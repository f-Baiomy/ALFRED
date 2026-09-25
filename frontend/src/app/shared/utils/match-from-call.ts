import { CallRecord } from '../../core/models/call.model';
import {
  BodyTestKind,
  ConditionOperator,
  MatchTestKind,
  RuleSource,
  bodyTestFormats,
  bodyTestNeedsValue,
  bodyTestOperatorLabel,
} from '../../core/models/interception.model';
import { detectAndFormatBody } from './body-format';
import { jsonPathIndex, parseJson, valuesAt } from './json-paths';

/**
 * "Fill from a call…" for a rule's Match section: turn a logged call into match fields (direction,
 * project, host, path, method) and optional "Only when…" tests, which the user ticks and edits
 * before they land in the form - and, once they have, say whether the edited match still matches
 * that call, and if not, which field stopped it.
 *
 * Pure. The semantics mirror proxy/interception.py's Match: host exact or a leading `*.`, path
 * tests against the path WITH its query string, header names case-insensitive, cookie names exact,
 * and body tests through the same squash-then-compare as _BodyTest.
 */

/** A row of the "Only when…" list: a header / query / cookie test, or a body, JSON field or size test. */
export type MatchRowKind = MatchTestKind | 'body' | 'json' | 'size';

export const BODY_ROW_KINDS: Readonly<Record<'body' | 'json' | 'size', BodyTestKind>> = { body: 'BODY', json: 'JSON_FIELD', size: 'SIZE' };

export function isBodyRow(kind: MatchRowKind): kind is 'body' | 'json' | 'size' {
  return kind === 'body' || kind === 'json' || kind === 'size';
}

/** Whether a row needs a name - a header, parameter, cookie or JSON path; a body or size does not. */
export function rowNeedsName(kind: MatchRowKind): boolean {
  return kind !== 'body' && kind !== 'size';
}

/** Computed per call or per connection - a test on them would match one call, never the next. */
const NOT_TESTABLE = new Set(['content-length', 'host', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'cookie']);

/** Fallback when the backend's list has not loaded - the same names SensitiveHeaders.NAMES starts with. */
const DEFAULT_SECRETS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'api-key']);

/** One header, query parameter or cookie of the picked call, offered as a match test. */
export interface TestCandidate {
  readonly kind: MatchRowKind;
  readonly name: string;
  readonly value: string;
  /** A credential (every cookie counts as one) - tagged, since checking it puts its value in the rule in plain text. */
  readonly secret: boolean;
}

export interface MatchSource {
  readonly direction: 'outbound' | 'inbound';
  readonly serviceName: string | null;
  readonly method: string;
  readonly host: string;
  /** Path without the query - what the fields are filled with. */
  readonly path: string;
  /** Path with the query - what the proxy tests pathContains / pathRegex against. */
  readonly pathWithQuery: string;
  readonly tests: readonly TestCandidate[];
  /** The raw request body - what the live check reads body tests against. */
  readonly body: string;
}

export function matchSourceOf(call: CallRecord, direction: 'outbound' | 'inbound', sensitiveNames: ReadonlySet<string> | null): MatchSource {
  const secrets = sensitiveNames ?? DEFAULT_SECRETS;
  let host = '';
  let path = '';
  let query = '';
  const params: [string, string][] = [];
  try {
    const u = new URL(call.original_url || call.url);
    host = u.hostname.toLowerCase();
    path = u.pathname || '/';
    query = u.search;
    const seen = new Set<string>();
    u.searchParams.forEach((value, name) => {
      if (seen.has(name)) return;
      seen.add(name);
      params.push([name, value]);
    });
  } catch {
    path = call.original_url || call.url || '';
  }

  const tests: TestCandidate[] = [];
  const headers = call.request?.headers ?? {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (NOT_TESTABLE.has(lower)) continue;
    tests.push({ kind: 'headers', name, value, secret: secrets.has(lower) || DEFAULT_SECRETS.has(lower) });
  }
  for (const [name, value] of params) tests.push({ kind: 'query', name, value, secret: false });
  for (const [name, value] of cookiesOf(headers)) tests.push({ kind: 'cookies', name, value, secret: true });
  const body = call.request?.body ?? '';
  if (body.trim()) {
    // The whole body, pretty-printed, as one "body contains" row - trimmed down by the user.
    tests.push({ kind: 'body', name: '', value: detectAndFormatBody(body).body, secret: false });
    for (const [name, value] of jsonLeaves(body)) tests.push({ kind: 'json', name, value, secret: false });
  }

  return {
    direction,
    serviceName: direction === 'inbound' ? call.service_name ?? null : null,
    method: (call.method || '').toUpperCase(),
    host,
    path,
    pathWithQuery: path + query,
    tests,
    body,
  };
}

/**
 * A JSON body's fields as [path, value] rows for "Fill from a call": every scalar leaf, lists
 * through `[*]` (`searchCriteria[*].origin`, not the list as one JSON blob), shallow first, capped
 * so a large response does not become a hundred rows. The first value stands for a [*] path.
 */
function jsonLeaves(body: string): [string, string][] {
  const doc = parseJson(body);
  if (doc === undefined || doc === null || typeof doc !== 'object') return [];
  return jsonPathIndex(doc)
    .filter((e) => !/\[\d+\]/.test(e.path) && e.type !== 'object' && e.type !== 'list')
    .sort((a, b) => a.depth - b.depth)
    .slice(0, MAX_JSON_ROWS)
    .map((e) => [e.path, e.samples[0] ?? asText(valuesAt(doc, e.path)[0])]);
}

const MAX_JSON_ROWS = 40;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** name -> value, first occurrence winning, split the way the proxy's _request_cookies splits. */
function cookiesOf(headers: Readonly<Record<string, string>>): [string, string][] {
  const raw = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'cookie')
    .map(([, value]) => value)
    .join('; ');
  const out = new Map<string, string>();
  for (const piece of raw.split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    if (name && !out.has(name)) out.set(name, piece.slice(eq + 1).trim());
  }
  return [...out.entries()];
}

export interface Variant {
  readonly label: string;
  readonly value: string;
}

/** The exact host, then `*.parent` - the one wildcard the proxy supports. Never for an IP or a one-dot name. */
export function hostVariants(host: string): readonly Variant[] {
  const out: Variant[] = [{ label: 'exact', value: host }];
  const labels = host.split('.');
  if (labels.length > 2 && !/^\d+(\.\d+){3}$/.test(host)) {
    out.push({ label: 'any subdomain', value: '*.' + labels.slice(1).join('.') });
  }
  return out;
}

export type PathForm = 'contains' | 'regex';

export interface PathVariant extends Variant {
  readonly form: PathForm;
}

/** The whole path, each shorter prefix of it (still "contains"), then a regex with its ids generalised. */
export function pathVariants(path: string): readonly PathVariant[] {
  const out: PathVariant[] = [{ label: 'contains the whole path', form: 'contains', value: path }];
  const segments = path.split('/').filter(Boolean);
  for (let n = segments.length - 1; n >= 1; n--) {
    const prefix = '/' + segments.slice(0, n).join('/');
    out.push({ label: `contains ${prefix}`, form: 'contains', value: prefix });
  }
  if (segments.length) out.push({ label: 'regex, ids generalised', form: 'regex', value: generalisePath(path) });
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/v2/order/88123/confirm` → `^/v\d+/order/\d+/confirm(?:\?|$)`: numbers, UUIDs, version
 * segments and id-looking tokens (long, with a digit) become patterns; everything else literal.
 * Anchored at both ends, the end allowing a query - the proxy tests the path with its query.
 */
export function generalisePath(path: string): string {
  const parts = path.split('/').map((segment) => {
    if (!segment) return '';
    if (/^\d+$/.test(segment)) return '\\d+';
    if (UUID.test(segment)) return '[0-9a-fA-F-]{36}';
    if (/^v\d+$/i.test(segment)) return segment[0] + '\\d+';
    if (segment.length >= 8 && /\d/.test(segment) && /^[A-Za-z0-9_-]+$/.test(segment)) return '[^/]+';
    return escapeRegex(segment);
  });
  return '^' + parts.join('/') + '(?:\\?|$)';
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface TestChoice {
  readonly kind: MatchRowKind;
  readonly name: string;
  readonly operator: ConditionOperator;
  readonly value: string;
  readonly secret: boolean;
  readonly on: boolean;
  /** Body and JSON field rows - compare without JSON/XML formatting. */
  readonly ignoreFormatting: boolean;
}

export interface MatchChoices {
  readonly direction: boolean;
  readonly project: boolean;
  readonly host: boolean;
  readonly hostValue: string;
  readonly path: boolean;
  readonly pathForm: PathForm;
  readonly pathValue: string;
  readonly method: boolean;
  readonly tests: readonly TestChoice[];
}

/**
 * Direction, project, path and method start checked; host too, except for an inbound call (it
 * arrives at the project's own listener, so its host says nothing the project does not). Every
 * test starts unchecked - which ones matter is the user's call - and as "equals" its value,
 * secrets included (they are tagged; the user decides whether one belongs in the rule).
 */
export function defaultMatchChoices(source: MatchSource): MatchChoices {
  return {
    direction: true,
    project: !!source.serviceName,
    host: source.direction === 'outbound' && !!source.host,
    hostValue: source.host,
    path: !!source.path,
    pathForm: 'contains',
    pathValue: source.path,
    method: !!source.method,
    tests: source.tests.map((t) => ({
      kind: t.kind,
      name: t.name,
      // The body row is the whole document - "contains" is what a trimmed-down copy of it means.
      operator: t.kind === 'body' ? 'CONTAINS' : 'EQUALS',
      value: t.value,
      secret: t.secret,
      on: false,
      ignoreFormatting: true,
    })),
  };
}

export interface FilledTest {
  readonly kind: MatchRowKind;
  readonly name: string;
  readonly operator: ConditionOperator;
  readonly value: string | null;
  readonly ignoreFormatting?: boolean;
}

/** What "Fill match" writes into the form: only the checked fields are present. */
export interface MatchFill {
  readonly source?: RuleSource;
  readonly serviceNames?: readonly string[];
  readonly host?: string;
  /** Set together: a path fill writes one field and clears the other, so the two never contradict. */
  readonly pathContains?: string;
  readonly pathRegex?: string;
  readonly methods?: readonly string[];
  readonly tests: readonly FilledTest[];
}

export function buildMatchFill(source: MatchSource, choices: MatchChoices): MatchFill {
  const path = choices.pathValue.trim();
  return {
    ...(choices.direction ? { source: source.direction } : {}),
    ...(choices.project && source.serviceName ? { serviceNames: [source.serviceName] } : {}),
    ...(choices.host ? { host: choices.hostValue.trim() } : {}),
    ...(choices.path
      ? choices.pathForm === 'regex'
        ? { pathContains: '', pathRegex: path }
        : { pathContains: path, pathRegex: '' }
      : {}),
    ...(choices.method && source.method ? { methods: [source.method] } : {}),
    tests: choices.tests
      .filter((t) => t.on && (!rowNeedsName(t.kind) || t.name.trim()))
      .map((t) => ({
        kind: t.kind,
        name: t.name.trim(),
        operator: t.operator,
        value: bodyTestNeedsValue(t.operator) ? t.value : null,
        ...(isBodyRow(t.kind) ? { ignoreFormatting: t.ignoreFormatting } : {}),
      })),
  };
}

/** Same kind + name replaces the existing test in place (header names case-insensitively); the rest are appended. */
export function mergeTests<T extends { readonly kind: MatchRowKind; readonly name: string }>(existing: readonly T[], added: readonly T[]): T[] {
  const key = (t: { kind: MatchRowKind; name: string }) => t.kind + ':' + (t.kind === 'headers' ? t.name.trim().toLowerCase() : t.name.trim());
  const byKey = new Map(added.map((t) => [key(t), t]));
  const out = existing.map((t) => {
    const replacement = byKey.get(key(t));
    if (!replacement) return t;
    byKey.delete(key(t));
    return replacement;
  });
  return [...out, ...byKey.values()];
}

/** The form's current match, as the live check reads it. */
export interface MatchForm {
  readonly source: RuleSource;
  readonly serviceNames: readonly string[];
  readonly host: string;
  readonly pathContains: string;
  readonly pathRegex: string;
  readonly methods: readonly string[];
  readonly tests: readonly MatchFormTest[];
}

export interface MatchFormTest {
  readonly kind: MatchRowKind;
  readonly name: string;
  readonly operator: ConditionOperator;
  readonly value?: string | null;
  readonly caseSensitive?: boolean | null;
  readonly ignoreFormatting?: boolean | null;
}

/**
 * Why the form's match would NOT match the picked call, one reason per failing field - empty when
 * it still matches. Regexes run in the browser's engine; a Python-only construct it cannot compile
 * is reported as "could not check", never as a mismatch.
 */
export function whyNotMatching(form: MatchForm, source: MatchSource): string[] {
  const reasons: string[] = [];
  if (form.source !== 'both' && form.source !== source.direction) reasons.push(`direction is ${form.source}, the call is ${source.direction}`);
  if (form.serviceNames.length && !form.serviceNames.includes(source.serviceName ?? '')) {
    reasons.push(source.serviceName ? `project ${source.serviceName} is not selected` : 'the call belongs to no project');
  }
  if (form.methods.length && !form.methods.map((m) => m.toUpperCase()).includes(source.method)) reasons.push(`method ${source.method} is not selected`);
  const host = form.host.trim().toLowerCase();
  if (host && !hostMatches(host, source.host)) reasons.push(`host ${host} does not match ${source.host || 'the call'}`);
  const contains = form.pathContains.trim();
  if (contains && !source.pathWithQuery.includes(contains)) reasons.push(`path does not contain "${contains}"`);
  const pattern = form.pathRegex.trim();
  if (pattern) {
    const re = compile(pattern, '');
    if (re === null) reasons.push('path regex could not be checked here');
    else if (!re.test(source.pathWithQuery)) reasons.push('path regex does not match');
  }
  for (const test of form.tests) {
    const name = test.name.trim();
    if (rowNeedsName(test.kind) && !name) continue;
    const failed = isBodyRow(test.kind) ? bodyTestFails(test, name, source) : testFails(test, name, source);
    if (failed) reasons.push(failed);
  }
  return reasons;
}

function hostMatches(pattern: string, host: string): boolean {
  if (!host) return false;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  return host === pattern;
}

/**
 * A body test the way the proxy's _BodyTest runs it: with ignoreFormatting, the raw value against
 * the raw body OR the squashed value against the squashed body (both, for a negation) - JSON
 * squashed outside its strings, XML between its tags.
 */
function bodyTestFails(test: MatchFormTest, name: string, source: MatchSource): string | null {
  const kind = test.kind as 'body' | 'json' | 'size';
  const op = test.operator;
  const value = test.value ?? '';
  const label = kind === 'json' ? `JSON field ${name}` : kind === 'size' ? 'body size' : 'body';
  const said = `${label} ${bodyTestOperatorLabel(BODY_ROW_KINDS[kind], op)}`;
  const text = source.body;
  if ((op === 'MATCHES' || op === 'NOT_MATCHES') && compile(value, '') === null) return `${label}: regex could not be checked here`;
  const cond = (values: readonly string[], v: string) => conditionHolds(op, values, v, test.caseSensitive !== false);

  if (kind === 'size') {
    const size = new TextEncoder().encode(text).length;
    return cond([String(size)], value) ? null : `${said} ${value} bytes does not hold - it is ${size} bytes`;
  }
  const squash = test.ignoreFormatting !== false && bodyTestFormats(BODY_ROW_KINDS[kind], op) && test.value != null;
  let raw: string[];
  let squashed: string[] | null = null;
  let form: 'json' | 'xml' | null = null;
  if (kind === 'json') {
    const found = jsonField(text, name);
    raw = found.map(asText);
    form = 'json';
    squashed = found.map((f, i) => (typeof f === 'string' ? raw[i] : squashJson(raw[i])));
  } else {
    raw = text ? [text] : [];
    form = text ? bodyForm(text) : null;
    if (form) squashed = [form === 'json' ? squashJson(text) : squashXml(text)];
  }
  let ok: boolean;
  if (!squash || !form || !squashed) {
    ok = cond(raw, value);
  } else {
    const results = [cond(raw, value), cond(squashed, form === 'json' ? squashJson(value) : squashXml(value))];
    ok = op.startsWith('NOT_') ? results.every(Boolean) : results.some(Boolean);
  }
  return ok ? null : `${said}${bodyTestNeedsValue(op) ? ' the value' : ''} does not hold`;
}

/** proxy Condition.holds_values: presence, the "absent" negatives, then any / none over the values. */
function conditionHolds(op: ConditionOperator, values: readonly string[], value: string, caseSensitive: boolean): boolean {
  if (op === 'EXISTS') return values.length > 0;
  if (op === 'NOT_EXISTS') return values.length === 0;
  if (!values.length) return op === 'NOT_EQUALS' || op === 'NOT_CONTAINS' || op === 'NOT_MATCHES';
  const one = (actual: string): boolean => {
    if (op === 'MATCHES' || op === 'NOT_MATCHES') return compile(value, caseSensitive ? '' : 'i')?.test(actual) ?? false;
    if (op === 'AT_LEAST' || op === 'AT_MOST') {
      const n = Number(actual);
      const limit = Number(value);
      if (actual.trim() === '' || Number.isNaN(n) || value.trim() === '' || Number.isNaN(limit)) return false;
      return op === 'AT_LEAST' ? n >= limit : n <= limit;
    }
    const a = caseSensitive ? actual : actual.toLowerCase();
    const v = caseSensitive ? value : value.toLowerCase();
    return op === 'EQUALS' || op === 'NOT_EQUALS' ? a === v : a.includes(v);
  };
  const any = values.some(one);
  return op.startsWith('NOT_') ? !any : any;
}

/** JSON text without the whitespace outside its strings - proxy _squash_json. */
export function squashJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/** XML without the whitespace between tags - proxy _squash_xml. */
export function squashXml(text: string): string {
  return text.trim().replace(/>\s+</g, '><');
}

function bodyForm(text: string): 'json' | 'xml' | null {
  const head = text.trimStart()[0];
  return head === '{' || head === '[' ? 'json' : head === '<' ? 'xml' : null;
}

/** Every value at a dotted path (`a.b[0].c`, `a[*].c`) - proxy get_json_field. */
function jsonField(text: string, path: string): unknown[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const segments: (string | number)[] = [];
  for (const part of path.split('.')) {
    if (!part) continue;
    const bracket = part.indexOf('[');
    const name = bracket < 0 ? part : part.slice(0, bracket);
    if (name) segments.push(name);
    for (const m of (bracket < 0 ? '' : part.slice(bracket)).matchAll(/\[([^\]]*)\]/g)) {
      const index = m[1].trim();
      if (index === '*') segments.push('*');
      else if (/^-?\d+$/.test(index)) segments.push(Number(index));
    }
  }
  const collect = (node: unknown, rest: (string | number)[]): unknown[] => {
    if (!rest.length) return [node];
    const [head, ...tail] = rest;
    if (head === '*') return Array.isArray(node) ? node.flatMap((item) => collect(item, tail)) : [];
    if (typeof head === 'number') {
      if (!Array.isArray(node) || head >= node.length || head < -node.length) return [];
      return collect(node[head < 0 ? node.length + head : head], tail);
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || !(head in (node as object))) return [];
    return collect((node as Record<string, unknown>)[head], tail);
  };
  return collect(doc, segments);
}

function testFails(test: MatchFormTest, name: string, source: MatchSource): string | null {
  const found = source.tests.find((t) => t.kind === test.kind && (test.kind === 'headers' ? t.name.toLowerCase() === name.toLowerCase() : t.name === name));
  const actual = found ? found.value : null;
  const label = `${test.kind === 'headers' ? 'header' : test.kind === 'query' ? 'query' : 'cookie'} ${name}`;
  switch (test.operator) {
    case 'EXISTS':
      return actual === null ? `${label} is not on the call` : null;
    case 'NOT_EXISTS':
      return actual !== null ? `${label} is on the call` : null;
  }
  if (actual === null) return `${label} is not on the call`;
  const folded = test.caseSensitive === false;
  const value = test.value ?? '';
  if (test.operator === 'MATCHES') {
    const re = compile(value, folded ? 'i' : '');
    if (re === null) return `${label}: regex could not be checked here`;
    return re.test(actual) ? null : `${label} does not match the regex`;
  }
  const a = folded ? actual.toLowerCase() : actual;
  const v = folded ? value.toLowerCase() : value;
  if (test.operator === 'EQUALS') return a === v ? null : `${label} does not equal the value`;
  return a.includes(v) ? null : `${label} does not contain the value`;
}

/** Python's `(?P<name>` / `(?P=name)` in JS spelling; null when the browser cannot compile it. */
function compile(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern.replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>'), flags);
  } catch {
    return null;
  }
}
