import { LinkedLogLine } from '../../core/models/call-logs.model';
import { CallRecord } from '../../core/models/call.model';
import { Redaction, RedactionKind } from '../../core/models/redaction.model';
import { OriginalHttp } from '../../core/models/interception.model';
import { CallDbCapture, ExportedDbStatement, TypedValue } from '../../core/models/db-capture.model';
import { paramColumns } from './sql-param-columns';

/**
 * Masking every export format goes through this one module, applied ONCE to the calls before any
 * builder sees them - rather than each of the six builders masking its own output.
 *
 * That is the whole point. A per-builder implementation is six chances to forget one, and the
 * failure mode of forgetting is not a cosmetic bug, it is shipping the user's bearer token to
 * whoever they sent the file to. A single choke point means a format added later is redacted by
 * construction, without its author having to know redaction exists.
 */
export const REDACTED = '***REDACTED***';

export interface RedactionResult {
  readonly calls: readonly CallRecord[];
  /** How many values were actually replaced - drives the export's "N values redacted" note, so a reader knows the file is sanitised rather than complete. */
  readonly redactedValueCount: number;
}

/** A redaction applies to a call when it is global, or pinned to that exact call. */
function appliesTo(redaction: Redaction, callId: string): boolean {
  return redaction.scope === 'all' || redaction.callId === callId;
}

function namesOfKind(redactions: readonly Redaction[], callId: string, kind: RedactionKind): Set<string> {
  const names = new Set<string>();
  for (const r of redactions) {
    // Header and query-param names are case-insensitive in practice, and JSON keys are matched
    // case-insensitively too so that "Authorization" typed once still catches "authorization".
    if (r.kind === kind && appliesTo(r, callId)) names.add(r.name.toLowerCase());
  }
  return names;
}

function redactHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  names: ReadonlySet<string>
): { headers: Record<string, string> | undefined; count: number } {
  if (!headers || names.size === 0) return { headers: headers as Record<string, string> | undefined, count: 0 };
  let count = 0;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (names.has(key.toLowerCase())) {
      out[key] = REDACTED;
      count++;
    } else {
      out[key] = value;
    }
  }
  return { headers: out, count };
}

/** Replaces every occurrence of a named key anywhere in the tree - a token nested three objects deep is the same secret as one at the root, and the user pointed at a name, not a position. */
function redactJsonValue(node: unknown, names: ReadonlySet<string>, counter: { n: number }): unknown {
  if (Array.isArray(node)) return node.map((item) => redactJsonValue(item, names, counter));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (names.has(key.toLowerCase())) {
        out[key] = REDACTED;
        counter.n++;
      } else {
        out[key] = redactJsonValue(value, names, counter);
      }
    }
    return out;
  }
  return node;
}

/**
 * Only re-serializes when something actually matched. A body is often megabytes (one measured
 * response pretty-prints to 110k lines), and round-tripping it through parse/stringify for nothing
 * would both cost that for every call and silently reformat a body the export promises to reproduce
 * as it crossed the wire.
 */
function redactBody(body: string | undefined, names: ReadonlySet<string>): { body: string | undefined; count: number } {
  if (!body || names.size === 0) return { body, count: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON. A SOAP envelope (wsse:Password) or a form post (password=...) carries the same
    // secrets under the same names, and a JSON-only redaction let them through into exports.
    if (body.trimStart().startsWith('<')) return redactXml(body, names);
    if (FORM_BODY.test(body.trim())) return redactForm(body, names);
    return { body, count: 0 };
  }
  const counter = { n: 0 };
  const result = redactJsonValue(parsed, names, counter);
  if (counter.n === 0) return { body, count: 0 };
  return { body: JSON.stringify(result, null, 2), count: counter.n };
}

/** `a=b&c=d`, nothing else: a body that merely contains '=' is not a form. */
const FORM_BODY = /^[^\s=&]+=[^\s&]*(?:&[^\s=&]+=[^\s&]*)*$/;

const XML_NAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
const XML_ELEMENT = new RegExp(`<(${XML_NAME})(\\s[^>]*)?>([^<]*)</\\1\\s*>`, 'g');
const XML_ATTRIBUTE = new RegExp(`(\\s)(${XML_NAME})(\\s*=\\s*)(["'])([^"']*)\\4`, 'g');
const XML_VALUE_LINE = new RegExp(`^\\s*<(${XML_NAME})(?:\\s[^>]*)?>[^<]+</\\1\\s*>\\s*$`);

/** A qualified XML name matches by itself (`wsse:Password`) or by its local part (`Password`). */
function xmlNameMatches(qualified: string, names: ReadonlySet<string>): boolean {
  const lower = qualified.toLowerCase();
  return names.has(lower) || names.has(lower.slice(lower.indexOf(':') + 1));
}

/**
 * Element text and attribute values whose name is redacted. Edited in place rather than parsed and
 * re-serialised, for the same reason as JSON above: the export promises the body as it crossed
 * the wire, and a round trip through a DOM would reformat all of it.
 */
function redactXml(body: string, names: ReadonlySet<string>): { body: string; count: number } {
  let count = 0;
  const elements = body.replace(XML_ELEMENT, (whole: string, name: string, attrs: string | undefined, text: string) => {
    if (!xmlNameMatches(name, names) || text.length === 0) return whole;
    count++;
    return `<${name}${attrs ?? ''}>${REDACTED}</${name}>`;
  });
  const attributes = elements.replace(XML_ATTRIBUTE, (whole: string, space: string, name: string, eq: string, quote: string) => {
    if (!xmlNameMatches(name, names)) return whole;
    count++;
    return `${space}${name}${eq}${quote}${REDACTED}${quote}`;
  });
  return { body: count ? attributes : body, count };
}

function redactForm(body: string, names: ReadonlySet<string>): { body: string; count: number } {
  // redactUrl already masks a query string pair by pair without re-encoding the rest.
  const masked = redactUrl(`?${body}`, names);
  return masked.count && masked.url ? { body: masked.url.slice(1), count: masked.count } : { body, count: 0 };
}

function redactUrl(url: string | undefined, names: ReadonlySet<string>): { url: string | undefined; count: number } {
  if (!url || names.size === 0) return { url, count: 0 };
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return { url, count: 0 };

  const base = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);
  let count = 0;
  // Hand-rolled rather than URLSearchParams: that re-encodes every other parameter on the way out,
  // so a URL the export is meant to reproduce verbatim would come back subtly different even when
  // nothing was redacted.
  const rebuilt = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      if (!names.has(decodeURIComponent(key).toLowerCase())) return pair;
      count++;
      return `${key}=${REDACTED}`;
    })
    .join('&');

  return { url: `${base}?${rebuilt}`, count };
}

/**
 * The key a clicked line hides, or null when the line has no value to hide (a brace, an array
 * element, a bare string). The UI only offers the control where this returns something, so a user
 * is never given a button that would silently do nothing.
 *
 * Both the headers and body panels render pretty-printed JSON, so one parse covers all four blocks;
 * an XML body is pretty-printed one element per line, so a value element names its own key.
 */
export function redactableNameOf(lineText: string): string | null {
  const match = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(lineText);
  if (match) {
    const key = match[1].replace(/\\(.)/g, '$1').trim();
    return key.length > 0 ? key : null;
  }
  // A pretty-printed XML body: an element holding a value on its own line, e.g. <wsse:Password>…</wsse:Password>.
  return XML_VALUE_LINE.exec(lineText)?.[1] ?? null;
}

/**
 * One interception snapshot, masked the same way the call's own halves are.
 *
 * These are a second copy of the request and the response - that is their entire purpose - so a
 * header masked on `call.request` and left intact on `interception.originalRequest` is not a
 * partial redaction, it is a redaction that did nothing. The user's token would sit in the very
 * next block of the same export.
 */
function redactSnapshot(
  http: OriginalHttp | null | undefined,
  headerNames: ReadonlySet<string>,
  bodyNames: ReadonlySet<string>,
  urlNames: ReadonlySet<string>
): { http: OriginalHttp | null | undefined; count: number } {
  if (!http) return { http, count: 0 };
  const headers = redactHeaders(http.headers ?? undefined, headerNames);
  const body = redactBody(http.body ?? undefined, bodyNames);
  const url = redactUrl(http.url ?? undefined, urlNames);
  const count = headers.count + body.count + url.count;
  if (count === 0) return { http, count: 0 };
  return { http: { ...http, headers: headers.headers, body: body.body, url: url.url ?? http.url }, count };
}

/**
 * Values of secret global variables (D6, specs/002-power-features). Unlike the named redactions
 * above - which say WHERE a secret sits - a secret variable says WHAT it is, so it is masked by
 * value, wherever it turns up: a header, a body, a URL, an interception snapshot, a resend edit.
 * Pushed here by SecretValuesService whenever the variables change, so every export path that
 * already calls redactCall/redactCalls is covered without knowing this exists.
 */
let secretValues: readonly string[] = [];

/** Very short values are skipped: masking every "1" or "ok" in a capture would shred it. */
const MIN_SECRET_LENGTH = 4;

export function setSecretValues(values: readonly string[]): void {
  // Longest first, so a secret that contains another is masked whole rather than in pieces.
  secretValues = [...new Set(values.filter((v) => typeof v === 'string' && v.length >= MIN_SECRET_LENGTH))]
    .sort((a, b) => b.length - a.length);
}

function maskSecretsDeep(node: unknown, counter: { n: number }): unknown {
  if (typeof node === 'string') {
    let out = node;
    for (const secret of secretValues) {
      if (!out.includes(secret)) continue;
      const parts = out.split(secret);
      counter.n += parts.length - 1;
      out = parts.join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((item) => {
      const next = maskSecretsDeep(item, counter);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? mapped : node;
  }
  if (node !== null && typeof node === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const next = maskSecretsDeep(value, counter);
      if (next !== value) changed = true;
      out[key] = next;
    }
    return changed ? out : node;
  }
  return node;
}

/** Masks one call. Returns the call unchanged (same reference) when nothing applies, so an export with no redactions costs nothing. */
export function redactCall(call: CallRecord, redactions: readonly Redaction[]): { call: CallRecord; count: number } {
  const named = redactByName(call, redactions);
  if (secretValues.length === 0) return named;
  const counter = { n: 0 };
  const masked = maskSecretsDeep(named.call, counter) as CallRecord;
  return counter.n === 0 ? named : { call: masked, count: named.count + counter.n };
}

/** Masks free text (a scenario report, a cURL line) with the same secret values. */
export function redactSecrets(text: string): string {
  return secretValues.length === 0 ? text : (maskSecretsDeep(text, { n: 0 }) as string);
}

function redactByName(call: CallRecord, redactions: readonly Redaction[]): { call: CallRecord; count: number } {
  if (redactions.length === 0) return { call, count: 0 };
  const db = call.dbCapture ? redactDbCapture(call.dbCapture, namesOfKind(redactions, call.id, 'db-column')) : null;
  const httpPart = redactHttpByName(call, redactions);
  const withDb = !db || db.count === 0 ? httpPart : { call: { ...httpPart.call, dbCapture: db.capture }, count: httpPart.count + db.count };
  const logs = call.logLines?.length ? redactLogLines(call.logLines, bodyNames(redactions, call.id)) : null;
  if (!logs || logs.count === 0) return withDb;
  return { call: { ...withDb.call, logLines: logs.lines }, count: withDb.count + logs.count };
}

/** Log lines are masked like bodies (specs/008-logs-call-link FR-017a): the body-key rules apply to each line's JSON. */
function bodyNames(redactions: readonly Redaction[], callId: string): Set<string> {
  return new Set([...namesOfKind(redactions, callId, 'request-body-key'), ...namesOfKind(redactions, callId, 'response-body-key')]);
}

function redactLogLines(lines: readonly LinkedLogLine[], names: ReadonlySet<string>): { lines: readonly LinkedLogLine[]; count: number } {
  if (names.size === 0) return { lines, count: 0 };
  let count = 0;
  const out = lines.map((l) => {
    const raw = redactBody(l.raw, names);
    const message = redactBody(l.message, names);
    if (raw.count === 0 && message.count === 0) return l;
    count += raw.count + message.count;
    return { ...l, raw: raw.body ?? l.raw, message: message.body ?? l.message };
  });
  return { lines: count ? out : lines, count };
}

function redactHttpByName(call: CallRecord, redactions: readonly Redaction[]): { call: CallRecord; count: number } {

  const reqHeaders = redactHeaders(call.request?.headers, namesOfKind(redactions, call.id, 'request-header'));
  const resHeaders = redactHeaders(call.response?.headers, namesOfKind(redactions, call.id, 'response-header'));
  const reqBody = redactBody(call.request?.body, namesOfKind(redactions, call.id, 'request-body-key'));
  const resBody = redactBody(call.response?.body, namesOfKind(redactions, call.id, 'response-body-key'));
  const urlNames = namesOfKind(redactions, call.id, 'url-param');
  const url = redactUrl(call.url, urlNames);
  // original_url carries the same query string and is what the .md/.html exports print as the
  // pre-proxy URL, so redacting only `url` would leave the secret sitting in plain sight one line up.
  const originalUrl = redactUrl(call.original_url, urlNames);

  // The interception snapshots are the same two halves over again. Driven off the same name sets
  // and the same helpers, so a snapshot added later is masked by construction rather than by
  // somebody remembering this function exists.
  const requestHeaderNames = namesOfKind(redactions, call.id, 'request-header');
  const responseHeaderNames = namesOfKind(redactions, call.id, 'response-header');
  const requestBodyNames = namesOfKind(redactions, call.id, 'request-body-key');
  const responseBodyNames = namesOfKind(redactions, call.id, 'response-body-key');
  const snapshots = call.interception
    ? {
        originalRequest: redactSnapshot(call.interception.originalRequest, requestHeaderNames, requestBodyNames, urlNames),
        finalRequest: redactSnapshot(call.interception.finalRequest, requestHeaderNames, requestBodyNames, urlNames),
        originalResponse: redactSnapshot(call.interception.originalResponse, responseHeaderNames, responseBodyNames, urlNames),
        finalResponse: redactSnapshot(call.interception.finalResponse, responseHeaderNames, responseBodyNames, urlNames),
      }
    : null;
  const snapshotCount = snapshots
    ? snapshots.originalRequest.count + snapshots.finalRequest.count +
      snapshots.originalResponse.count + snapshots.finalResponse.count
    : 0;

  const count =
    reqHeaders.count + resHeaders.count + reqBody.count + resBody.count + url.count + originalUrl.count +
    snapshotCount;
  if (count === 0) return { call, count: 0 };

  return {
    call: {
      ...call,
      interception:
        call.interception && snapshots && snapshotCount > 0
          ? {
              ...call.interception,
              originalRequest: snapshots.originalRequest.http,
              finalRequest: snapshots.finalRequest.http,
              originalResponse: snapshots.originalResponse.http,
              finalResponse: snapshots.finalResponse.http,
            }
          : call.interception,
      url: url.url ?? call.url,
      original_url: originalUrl.url ?? call.original_url,
      request: call.request ? { ...call.request, headers: reqHeaders.headers, body: reqBody.body } : call.request,
      response: call.response
        ? { ...call.response, headers: resHeaders.headers, body: resBody.body }
        : call.response,
    },
    count,
  };
}

function maskValue(v: TypedValue): TypedValue {
  return { type: v.type, value: REDACTED };
}

/** Masks the cells of the named columns; rows are copied only when something matched. */
function redactRows(
  rows: readonly (readonly TypedValue[])[] | null | undefined,
  columns: readonly { readonly name: string }[] | null | undefined,
  names: ReadonlySet<string>,
  counter: { n: number },
): readonly (readonly TypedValue[])[] | null | undefined {
  if (!rows || !columns) return rows;
  const hidden = columns.map((c, i) => (names.has(c.name.toLowerCase()) ? i : -1)).filter((i) => i >= 0);
  if (!hidden.length) return rows;
  return rows.map((row) => row.map((v, i) => {
    if (!hidden.includes(i) || v.value == null) return v;
    counter.n++;
    return maskValue(v);
  }));
}

function redactStatement(s: ExportedDbStatement, names: ReadonlySet<string>, counter: { n: number }): ExportedDbStatement {
  const before = counter.n;
  const bound = paramColumns(s.sql);
  const params = bound.some((c) => c && names.has(c))
    ? s.params.map((set) => set.map((v, i) => {
      const col = bound[i];
      if (!col || !names.has(col) || v.value == null) return v;
      counter.n++;
      return maskValue(v);
    }))
    : s.params;
  const rows = redactRows(s.rows, s.outcome.columns, names, counter);
  const beforeImageRows = redactRows(s.beforeImageRows, s.beforeImage?.columns, names, counter);
  const origin = redactOrigin(s, params, names, counter);
  return counter.n === before ? s : { ...s, params, rows, beforeImageRows, origin };
}

/**
 * The query the code wrote carries the same values by name (`:password = 'x'`): a parameter is masked when its name is
 * a redacted column, or its value is one the SQL parameters just had masked.
 */
function redactOrigin(
  s: ExportedDbStatement,
  params: ExportedDbStatement['params'],
  names: ReadonlySet<string>,
  counter: { n: number },
): ExportedDbStatement['origin'] {
  const o = s.origin;
  if (!o?.params?.length) return o;
  const masked = new Set<string>();
  s.params.forEach((set, i) => set.forEach((v, j) => {
    if (v.value != null && params[i]?.[j]?.value === REDACTED) masked.add(v.value);
  }));
  let changed = false;
  const originParams = o.params.map((p) => {
    const raw = p.value?.replace(/^'(.*)'$/s, '$1');
    if (p.value == null || !(names.has(p.name.replace(/^[:?]/, '').toLowerCase()) || (raw != null && masked.has(raw)))) return p;
    changed = true;
    counter.n++;
    return { ...p, value: REDACTED };
  });
  return changed ? { ...o, params: originParams } : o;
}

/** `db-column` redactions over a call's captured statements. The live window is never masked - only exports. */
function redactDbCapture(capture: CallDbCapture, names: ReadonlySet<string>): { capture: CallDbCapture; count: number } {
  if (names.size === 0) return { capture, count: 0 };
  const counter = { n: 0 };
  const statements = capture.statements.map((s) => redactStatement(s, names, counter));
  return counter.n === 0 ? { capture, count: 0 } : { capture: { ...capture, statements }, count: counter.n };
}

/** The choke point every export path calls before handing calls to a builder. */
export function redactCalls(calls: readonly CallRecord[], redactions: readonly Redaction[]): RedactionResult {
  if (redactions.length === 0 && secretValues.length === 0) return { calls, redactedValueCount: 0 };
  let total = 0;
  const out = calls.map((call) => {
    const { call: redacted, count } = redactCall(call, redactions);
    total += count;
    return redacted;
  });
  return { calls: out, redactedValueCount: total };
}
