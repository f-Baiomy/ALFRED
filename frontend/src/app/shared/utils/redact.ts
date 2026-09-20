import { CallRecord } from '../../core/models/call.model';
import { Redaction, RedactionKind } from '../../core/models/redaction.model';
import { OriginalHttp } from '../../core/models/interception.model';

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
    // Not JSON, so there is no key to find. The UI only offers a body redaction on a line it could
    // derive a key from, so reaching here means the body changed shape since the redaction was made.
    return { body, count: 0 };
  }
  const counter = { n: 0 };
  const result = redactJsonValue(parsed, names, counter);
  if (counter.n === 0) return { body, count: 0 };
  return { body: JSON.stringify(result, null, 2), count: counter.n };
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
 * Both the headers and body panels render pretty-printed JSON, so one parse covers all four blocks.
 */
export function redactableNameOf(lineText: string): string | null {
  const match = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(lineText);
  if (!match) return null;
  const key = match[1].replace(/\\(.)/g, '$1').trim();
  return key.length > 0 ? key : null;
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

/** Masks one call. Returns the call unchanged (same reference) when nothing applies, so an export with no redactions costs nothing. */
export function redactCall(call: CallRecord, redactions: readonly Redaction[]): { call: CallRecord; count: number } {
  if (redactions.length === 0) return { call, count: 0 };

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

/** The choke point every export path calls before handing calls to a builder. */
export function redactCalls(calls: readonly CallRecord[], redactions: readonly Redaction[]): RedactionResult {
  if (redactions.length === 0) return { calls, redactedValueCount: 0 };
  let total = 0;
  const out = calls.map((call) => {
    const { call: redacted, count } = redactCall(call, redactions);
    total += count;
    return redacted;
  });
  return { calls: out, redactedValueCount: total };
}
