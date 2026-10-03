/**
 * "Values passed between steps" for a Relive cycle: a value an earlier step's recorded RESPONSE
 * handed back (a session cookie, a login token, a created id, a CSRF token) that a later step's
 * recorded REQUEST sent again. Replaying those later requests as recorded sends yesterday's value,
 * so the app answers "please log in" or "not found". Using a suggestion adds one extraction to the
 * producing step that remembers the recorded value (`recordedValue`); the run then swaps in its own
 * value wherever the recorded one appears (relive-session.ts) - the later steps are not edited.
 *
 * Same idea as cycle-chain-detect.ts (resend scenarios), but over a cycle's top-level steps, and a
 * later request is searched as text - the URL, every header and the raw body - so a form post or a
 * SOAP envelope counts as much as JSON. Only the top-level steps: an Automatic run sends those; a
 * supplier call is made by the app itself.
 */
import { ExtractRule } from './resend-draft';
import { extractValues, setCookies } from './resend-draft-chain';
import { Step } from './relive-types';

export type ChainKind = ExtractRule['from'];

export interface StepChainUse {
  readonly stepKey: string;
  /** Where the later step sends it: "Cookie", a header name, "URL" or "body". */
  readonly where: string;
}

export interface StepChain {
  /** The variable name the extraction saves it as; unique within the result and the cycle. */
  readonly name: string;
  readonly kind: ChainKind;
  readonly path: string;
  readonly fromStepKey: string;
  readonly recordedValue: string;
  readonly uses: readonly StepChainUse[];
  /** A cookie, or a value sent back only inside one: the run's cookie jar already carries it
   *  while the cycle's carryCookies is on. */
  readonly cookie: boolean;
  /** The producing step already extracts this path. */
  readonly applied: boolean;
}

const MIN_STRING_LEN = 8;
const MIN_DIGITS = 5;
const MIN_TOKEN_LEN = 16;
const MAX_BODY_CHARS = 2 * 1024 * 1024;
const NOISE_HEADERS = new Set(['content-length', 'date', 'etag', 'connection', 'keep-alive', 'server', 'vary', 'content-encoding',
  'transfer-encoding', 'cache-control', 'expires', 'last-modified', 'x-request-id', 'x-correlation-id', 'content-type',
  'location', 'pragma', 'x-frame-options', 'x-content-type-options', 'x-xss-protection', 'strict-transport-security',
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers', 'access-control-allow-methods']);

interface Candidate {
  readonly value: string;
  readonly kind: ChainKind;
  readonly path: string;
  readonly name: string;
}

/** A value that looks generated - a session id, token or created id - not reference data that
 *  merely repeats between steps (a menu key, an airport name): no spaces, and a digit in it or
 *  long enough to be a token on its own. */
function worthChaining(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (/^\d+$/.test(text)) return text.length >= MIN_DIGITS;
  if (text.length < MIN_STRING_LEN || /\s/.test(text)) return false;
  return /\d/.test(text) || text.length >= MIN_TOKEN_LEN;
}

function walkJson(node: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkJson(item, path ? `${path}[${i}]` : `[${i}]`, visit));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) walkJson(value, path ? `${path}.${key}` : key, visit);
  } else if (path) {
    visit(path, node);
  }
}

function xmlLeaves(body: string, visit: (path: string, name: string, value: string) => void): void {
  if (typeof DOMParser === 'undefined') return;
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return;
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.children.length) continue;
    const parent = el.parentElement?.localName;
    visit(parent ? `${parent}.${el.localName}` : el.localName, el.localName, (el.textContent ?? '').trim());
  }
}

function candidatesOf(step: Step): Candidate[] {
  const out: Candidate[] = [];
  const headers = step.recording.responseHeaders ?? {};
  for (const cookie of setCookies(headers)) {
    if (!cookie.cleared && worthChaining(cookie.value)) out.push({ value: cookie.value, kind: 'COOKIE', path: cookie.name, name: cookie.name });
  }
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'set-cookie' || NOISE_HEADERS.has(lower)) continue;
    if (worthChaining(value)) out.push({ value: value.trim(), kind: 'HEADER', path: name, name });
  }
  const body = step.recording.responseBody ?? '';
  if (!body || body.length > MAX_BODY_CHARS) return out;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  if (json !== undefined && typeof json === 'object') {
    walkJson(json, '', (path, value) => {
      const text = typeof value === 'number' ? String(value) : value;
      const name = path.split(/[.[]/).pop()?.replace(']', '') || path;
      if (worthChaining(text)) out.push({ value: text.trim(), kind: 'JSON', path, name });
    });
  } else if (body.trimStart().startsWith('<')) {
    xmlLeaves(body, (path, name, value) => {
      if (worthChaining(value)) out.push({ value, kind: 'XML', path, name });
    });
  }
  return out;
}

/** Where `value` appears in `step`'s recorded request, or null when it does not. */
function useIn(step: Step, value: string): string | null {
  const encoded = encodeURIComponent(value);
  const has = (text: string | null | undefined) => !!text && (text.includes(value) || (encoded !== value && text.includes(encoded)));
  for (const [name, headerValue] of Object.entries(step.recording.requestHeaders ?? {})) {
    if (has(headerValue)) return name.toLowerCase() === 'cookie' ? 'Cookie' : name;
  }
  if (has(step.recording.url)) return 'URL';
  const body = step.recording.requestBody ?? '';
  if (body.length <= MAX_BODY_CHARS && has(body)) return 'body';
  return null;
}

function uniqueName(base: string, taken: Set<string>): string {
  const cleaned = (base || 'value').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[^A-Za-z]+/, '') || 'value';
  let name = cleaned;
  for (let n = 2; taken.has(name); n++) name = `${cleaned}_${n}`;
  taken.add(name);
  return name;
}

/**
 * The cycle's chains, most-used first. A value is credited to the first step whose response
 * returned it; one the first step's own request already carried is configuration (an API key),
 * not something the cycle produced, and is left out.
 */
export function detectStepChains(steps: readonly Step[], variableNames: readonly string[] = []): StepChain[] {
  const tops = steps.filter((s) => !s.parentKey && s.enabled);
  if (tops.length < 2) return [];
  const first = tops[0];
  const configuration = (value: string) => useIn(first, value) !== null;

  const taken = new Set<string>(variableNames);
  for (const step of steps) for (const rule of step.extract) taken.add(rule.as);

  const seen = new Set<string>();
  const chains: StepChain[] = [];
  tops.forEach((step, i) => {
    for (const candidate of candidatesOf(step)) {
      if (seen.has(candidate.value) || configuration(candidate.value)) continue;
      const uses: StepChainUse[] = [];
      for (const later of tops.slice(i + 1)) {
        const where = useIn(later, candidate.value);
        if (where) uses.push({ stepKey: later.key, where });
      }
      if (!uses.length) continue;
      seen.add(candidate.value);
      const existing = step.extract.find((rule) => rule.from === candidate.kind && rule.path === candidate.path);
      chains.push({
        name: existing?.as ?? uniqueName(candidate.name, taken),
        kind: candidate.kind,
        path: candidate.path,
        fromStepKey: step.key,
        recordedValue: candidate.value,
        uses,
        cookie: candidate.kind === 'COOKIE',
        applied: !!existing?.recordedValue,
      });
    }
  });
  // Every value already in use stays listed, even one detection would no longer suggest (a menu
  // key ticked before detection got stricter) - so it can always be unticked.
  tops.forEach((step, i) => {
    for (const rule of step.extract) {
      if (!rule.recordedValue || chains.some((c) => c.fromStepKey === step.key && c.kind === rule.from && c.path === rule.path)) continue;
      const uses: StepChainUse[] = [];
      for (const later of tops.slice(i + 1)) {
        const where = useIn(later, rule.recordedValue);
        if (where) uses.push({ stepKey: later.key, where });
      }
      chains.push({ name: rule.as, kind: rule.from, path: rule.path, fromStepKey: step.key, recordedValue: rule.recordedValue, uses, cookie: rule.from === 'COOKIE', applied: true });
    }
  });

  // A value that is only ever sent back inside a cookie the jar already carries (odeysys's login
  // JSON `sessionId` is the JSESSIONID cookie) needs nothing more than that cookie.
  const cookieValues = chains.filter((c) => c.kind === 'COOKIE').map((c) => c.recordedValue);
  const covered = chains.map((c) =>
    c.kind !== 'COOKIE' && c.uses.every((u) => u.where === 'Cookie') && cookieValues.some((v) => v.includes(c.recordedValue)) ? { ...c, cookie: true } : c);
  return covered.sort((a, b) => b.uses.length - a.uses.length);
}

/** `steps` with `chains` used: each producing step extracts the value and remembers what the
 *  recording had. An extraction of the same path already there gains `recordedValue`. */
export function applyStepChains(steps: readonly Step[], chains: readonly StepChain[]): Step[] {
  return steps.map((step) => {
    const mine = chains.filter((c) => c.fromStepKey === step.key);
    if (!mine.length) return step;
    const extract = [...step.extract];
    for (const chain of mine) {
      const at = extract.findIndex((rule) => rule.from === chain.kind && rule.path === chain.path);
      if (at >= 0) extract[at] = { ...extract[at], recordedValue: chain.recordedValue };
      else extract.push({ from: chain.kind, path: chain.path, as: chain.name, missing: 'SKIP', recordedValue: chain.recordedValue });
    }
    return { ...step, extract };
  });
}

/** `steps` with `chains` no longer used: the producing step's extraction stops swapping, and is
 *  removed when nothing refers to its variable by name either. */
export function removeStepChains(steps: readonly Step[], chains: readonly StepChain[]): Step[] {
  const text = JSON.stringify(steps.map((s) => [s.recording.url, s.recording.requestHeaders, s.recording.requestBody, s.callRule]));
  return steps.map((step) => {
    const mine = chains.filter((c) => c.fromStepKey === step.key);
    if (!mine.length) return step;
    const extract = step.extract.flatMap((rule) => {
      if (!mine.some((c) => c.kind === rule.from && c.path === rule.path)) return [rule];
      if (text.includes(`{{$.${rule.as}}}`)) {
        const { recordedValue: _dropped, ...kept } = rule;
        return [kept];
      }
      return [];
    });
    return { ...step, extract };
  });
}

/** An extraction's recorded value, re-read from the step's recording - for a rule the user
 *  edited by hand, so a changed path never keeps swapping a stale value. */
export function recordedValueOf(step: Step, rule: ExtractRule): string | undefined {
  const recording = step.recording;
  const response = { status: recording.status, headers: recording.responseHeaders ?? {}, body: recording.responseBody ?? null };
  const value = extractValues(response, [{ ...rule, missing: 'SKIP' }])[rule.as];
  return value && worthChaining(value) ? value : undefined;
}
