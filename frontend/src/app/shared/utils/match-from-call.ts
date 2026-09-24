import { CallRecord } from '../../core/models/call.model';
import { MatchTestKind, MatchTestOperator, RuleSource, matchTestNeedsValue } from '../../core/models/interception.model';

/**
 * "Fill from a call…" for a rule's Match section: turn a logged call into match fields (direction,
 * project, host, path, method) and optional "Only when…" tests, which the user ticks and edits
 * before they land in the form - and, once they have, say whether the edited match still matches
 * that call, and if not, which field stopped it.
 *
 * Pure. The semantics mirror proxy/interception.py's Match: host exact or a leading `*.`, path
 * tests against the path WITH its query string, header names case-insensitive, cookie names exact.
 */

/** Computed per call or per connection - a test on them would match one call, never the next. */
const NOT_TESTABLE = new Set(['content-length', 'host', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'cookie']);

/** Fallback when the backend's list has not loaded - the same names SensitiveHeaders.NAMES starts with. */
const DEFAULT_SECRETS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'api-key']);

/** One header, query parameter or cookie of the picked call, offered as a match test. */
export interface TestCandidate {
  readonly kind: MatchTestKind;
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

  return {
    direction,
    serviceName: direction === 'inbound' ? call.service_name ?? null : null,
    method: (call.method || '').toUpperCase(),
    host,
    path,
    pathWithQuery: path + query,
    tests,
  };
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
  readonly kind: MatchTestKind;
  readonly name: string;
  readonly operator: MatchTestOperator;
  readonly value: string;
  readonly secret: boolean;
  readonly on: boolean;
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
      operator: 'EQUALS',
      value: t.value,
      secret: t.secret,
      on: false,
    })),
  };
}

export interface FilledTest {
  readonly kind: MatchTestKind;
  readonly name: string;
  readonly operator: MatchTestOperator;
  readonly value: string | null;
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
      .filter((t) => t.on && t.name.trim())
      .map((t) => ({
        kind: t.kind,
        name: t.name.trim(),
        operator: t.operator,
        value: matchTestNeedsValue(t.operator) ? t.value : null,
      })),
  };
}

/** Same kind + name replaces the existing test in place (header names case-insensitively); the rest are appended. */
export function mergeTests<T extends { readonly kind: MatchTestKind; readonly name: string }>(existing: readonly T[], added: readonly T[]): T[] {
  const key = (t: { kind: MatchTestKind; name: string }) => t.kind + ':' + (t.kind === 'headers' ? t.name.trim().toLowerCase() : t.name.trim());
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
  readonly tests: readonly { readonly kind: MatchTestKind; readonly name: string; readonly operator: MatchTestOperator; readonly value?: string | null; readonly caseSensitive?: boolean | null }[];
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
    if (!name) continue;
    const failed = testFails(test, name, source);
    if (failed) reasons.push(failed);
  }
  return reasons;
}

function hostMatches(pattern: string, host: string): boolean {
  if (!host) return false;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
  return host === pattern;
}

function testFails(test: MatchForm['tests'][number], name: string, source: MatchSource): string | null {
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
