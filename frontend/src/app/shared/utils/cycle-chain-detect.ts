import { CallRecord } from '../../core/models/call.model';
import { jsonTypeOf } from './json-paths';
import { draftFrom, ResendDraft } from './resend-draft';
import { ResendGroup, newGroupId } from './resend-group';
import { ExtractRule } from './scenario-types';

/**
 * D2 - given a session cycle's calls in order (hydrated with request/response bodies), finds
 * values that were handed back in an earlier call's RESPONSE and reused in a later call's REQUEST
 * - the shape a login token -> Authorization header, or a created id -> a later URL path segment,
 * always takes. Feeds "Create scenario from cycle" (pages/session-cycle-detail): each suggestion
 * becomes one ExtractRule on the source draft and one `{{this.<name>}}` substitution on every use.
 *
 * Deliberately conservative: a value only counts once it clears a size floor (an 8+ char string
 * leaf, or a 5+ digit number) so it isn't drowning in "true"/"1"/short enum values, and a value
 * already present in the very FIRST call's request is treated as static config (an API key that
 * was there from the start, not something the cycle produced) rather than a chain.
 */

export type SourceKind = 'JSON' | 'HEADER' | 'COOKIE';
export type UseLocation = 'HEADER' | 'COOKIE' | 'QUERY' | 'JSON' | 'URL_PATH';

export interface ChainSource {
  readonly callIndex: number;
  readonly kind: SourceKind;
  readonly path: string;
}

export interface ChainUse {
  readonly callIndex: number;
  readonly where: UseLocation;
  readonly location: string;
}

export interface ChainSuggestion {
  /** Derived from the source JSON key / header / cookie name; unique across the returned list. */
  readonly name: string;
  readonly from: ChainSource;
  readonly uses: readonly ChainUse[];
  readonly count: number;
  /**
   * True when this is really just the same session cookie being echoed back on every request -
   * chaining it as an extracted value would be pointless busywork since "use current session"
   * already does the same thing without a rule.
   */
  readonly useCurrentSession?: boolean;
}

const MAX_CALLS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MIN_STRING_LEN = 8;
const MIN_DIGIT_COUNT = 5;

/** Response headers that are noise - present on nearly every call, never something a later request would deliberately reuse. */
const NOISE_HEADERS = new Set(['content-length', 'date', 'etag', 'connection', 'keep-alive', 'server', 'vary', 'content-encoding', 'transfer-encoding', 'cache-control', 'expires', 'last-modified', 'x-request-id', 'x-correlation-id']);

const SESSION_COOKIE_NAMES = new Set(['jsessionid', 'connect.sid', 'session', 'sessionid', 'phpsessid', 'sid', 'asp.net_sessionid']);

interface Candidate {
  readonly value: string;
  readonly source: ChainSource;
  /** The name a suggestion is built from (JSON key / header name / cookie name). */
  readonly name: string;
}

export function detectChains(calls: readonly CallRecord[]): ChainSuggestion[] {
  const capped = calls.slice(0, MAX_CALLS);
  if (capped.length < 2) return [];

  const staticValues = collectStaticValues(capped[0]);

  // First occurrence only: once a value is produced by call i, an identical value resurfacing in
  // a later response is not a new source - reusing the ORIGINAL is what a rule should point at.
  const firstSourceOf = new Map<string, Candidate>();
  for (let i = 0; i < capped.length - 1; i++) {
    for (const candidate of candidatesFromResponse(capped[i], i)) {
      if (staticValues.has(candidate.value)) continue;
      if (!firstSourceOf.has(candidate.value)) firstSourceOf.set(candidate.value, candidate);
    }
  }

  const usesByValue = new Map<string, ChainUse[]>();
  // Session cookies: reported per cookie NAME rather than value, since "use current session"
  // means "whatever the browser session's cookie is right now" - the calling code needs to know
  // which calls used it, not which literal value it happened to carry in this recording.
  const sessionCookieUses = new Map<string, ChainUse[]>();
  for (let j = 1; j < capped.length; j++) {
    for (const use of usesInRequest(capped[j], j)) {
      if (!firstSourceOf.has(use.value)) continue;
      if (use.use.where === 'COOKIE' && isSessionCookie(use.name)) {
        const list = sessionCookieUses.get(use.name.toLowerCase()) ?? [];
        list.push(use.use);
        sessionCookieUses.set(use.name.toLowerCase(), list);
        continue;
      }
      const list = usesByValue.get(use.value) ?? [];
      list.push(use.use);
      usesByValue.set(use.value, list);
    }
  }

  const takenNames = new Set<string>();
  const suggestions: ChainSuggestion[] = [];

  // Session cookies: one suggestion per distinct cookie name, flagged useCurrentSession - the
  // toggle in the UI just turns on "use current session" on the calls listed in `uses`, no
  // extraction/substitution needed.
  for (const [name, uses] of sessionCookieUses) {
    const uniqueName = uniqueNameFor(name, takenNames);
    suggestions.push({ name: uniqueName, from: { callIndex: -1, kind: 'COOKIE', path: name }, uses, count: uses.length, useCurrentSession: true });
  }

  for (const [value, source] of firstSourceOf) {
    const uses = usesByValue.get(value);
    if (!uses || uses.length === 0) continue;
    const name = uniqueNameFor(source.name, takenNames);
    suggestions.push({ name, from: source.source, uses, count: uses.length });
  }

  // Highest-impact chains first (most reuses), stable by source call order for ties.
  return suggestions.sort((a, b) => b.count - a.count || a.from.callIndex - b.from.callIndex);
}

function uniqueNameFor(base: string, taken: Set<string>): string {
  const cleaned = (base || 'value').replace(/[^A-Za-z0-9_.-]/g, '_');
  let name = cleaned;
  let n = 2;
  while (taken.has(name)) name = `${cleaned}_${n++}`;
  taken.add(name);
  return name;
}

function isSessionCookie(name: string): boolean {
  return SESSION_COOKIE_NAMES.has(name.toLowerCase());
}

function bodyOf(io: { readonly body?: string } | undefined): string | undefined {
  const body = io?.body;
  if (!body || byteLength(body) > MAX_BODY_BYTES) return undefined;
  return body;
}

function byteLength(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
}

function isCandidateValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length >= MIN_STRING_LEN) return true;
  return false;
}

function isCandidateNumber(value: unknown): value is number {
  return typeof value === 'number' && Math.abs(value).toString().replace('.', '').length >= MIN_DIGIT_COUNT;
}

/* ---------------------------------------------------------------------------------------------- */
/* Response-side extraction: what a later request could plausibly be reusing.                      */

function candidatesFromResponse(call: CallRecord, callIndex: number): Candidate[] {
  const out: Candidate[] = [];
  const headers = call.response?.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (NOISE_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie') {
      for (const [cookieName, cookieValue] of parseCookiePairs(value)) {
        if (isCandidateValue(cookieValue)) out.push({ value: cookieValue, name: cookieName, source: { callIndex, kind: 'COOKIE', path: cookieName } });
      }
      continue;
    }
    if (isCandidateValue(value)) out.push({ value, name: key, source: { callIndex, kind: 'HEADER', path: key } });
  }
  const body = bodyOf(call.response);
  if (body) {
    const doc = tryParse(body);
    if (doc !== undefined) walkJsonLeaves(doc, '', (path, value) => {
      const key = path.split(/[.[]/).pop()?.replace(']', '') || path;
      if (isCandidateValue(value)) out.push({ value, name: key, source: { callIndex, kind: 'JSON', path } });
      else if (isCandidateNumber(value)) out.push({ value: String(value), name: key, source: { callIndex, kind: 'JSON', path } });
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Request-side matching: where a candidate value could resurface.                                  */

interface UseHit {
  readonly value: string;
  readonly name: string;
  readonly use: ChainUse;
}

function usesInRequest(call: CallRecord, callIndex: number): UseHit[] {
  const out: UseHit[] = [];
  const headers = call.request?.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'cookie') {
      for (const [cookieName, cookieValue] of parseCookiePairs(value)) {
        out.push({ value: cookieValue, name: cookieName, use: { callIndex, where: 'COOKIE', location: cookieName } });
      }
      continue;
    }
    if (lower === 'authorization') {
      const bearer = /^Bearer\s+(.+)$/i.exec(value.trim());
      if (bearer) {
        out.push({ value: bearer[1], name: key, use: { callIndex, where: 'HEADER', location: 'Authorization (Bearer)' } });
        continue;
      }
    }
    out.push({ value, name: key, use: { callIndex, where: 'HEADER', location: key } });
  }

  try {
    const url = new URL(call.url);
    url.searchParams.forEach((value, name) => {
      out.push({ value, name, use: { callIndex, where: 'QUERY', location: name } });
    });
    const segments = url.pathname.split('/').filter(Boolean);
    segments.forEach((segment, i) => {
      out.push({ value: segment, name: `path segment ${i}`, use: { callIndex, where: 'URL_PATH', location: `/${segments.slice(0, i + 1).join('/')}` } });
    });
  } catch {
    // Not a parseable absolute URL - skip query/path matching for this call, headers/body still apply.
  }

  const body = bodyOf(call.request);
  if (body) {
    const doc = tryParse(body);
    if (doc !== undefined) walkJsonLeaves(doc, '', (path, value) => {
      if (typeof value === 'string' || typeof value === 'number') {
        out.push({ value: String(value), name: path, use: { callIndex, where: 'JSON', location: path } });
      }
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */

/** Static values already present in the very first call's own request - ignored as chain candidates. */
function collectStaticValues(firstCall: CallRecord): Set<string> {
  const values = new Set<string>();
  for (const hit of usesInRequest(firstCall, 0)) values.add(hit.value);
  return values;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function walkJsonLeaves(node: unknown, path: string, visit: (path: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkJsonLeaves(item, path ? `${path}[${i}]` : `[${i}]`, visit));
    return;
  }
  if (node !== null && typeof node === 'object' && jsonTypeOf(node) === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walkJsonLeaves(value, path ? `${path}.${key}` : key, visit);
    }
    return;
  }
  if (path) visit(path, node);
}

/** `name=value; name2=value2` (a Cookie request header) or `name=value; Path=/; HttpOnly` (a Set-Cookie response header) - only the first pair of a Set-Cookie is the cookie itself. */
function parseCookiePairs(headerValue: string): [string, string][] {
  const out: [string, string][] = [];
  const parts = headerValue.split(';').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (/^(path|domain|expires|max-age|secure|httponly|samesite)$/i.test(name)) continue;
    out.push([name, part.slice(eq + 1).trim()]);
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* "Create scenario from cycle": turn the accepted suggestions into resend drafts.                  */

/**
 * Builds one draft per call (in order), substituting every accepted chain's value with
 * `{{this.<name>}}` everywhere it was found reused, and attaching an ExtractRule to the draft the
 * value came from. All drafts land in one new sequential group named after the cycle, per D2's
 * "everything in one sequential group" requirement. A session-cookie suggestion instead turns on
 * `useCurrentSession` for the calls that used it - there is nothing to extract or substitute.
 */
export function buildChainedDrafts(
  calls: readonly CallRecord[],
  cycleId: string | null,
  cycleName: string,
  suggestions: readonly ChainSuggestion[],
  acceptedNames: ReadonlySet<string>
): { drafts: ResendDraft[]; groups: Record<string, ResendGroup> } {
  const accepted = suggestions.filter((s) => acceptedNames.has(s.name));
  const groupId = newGroupId();
  const groups: Record<string, ResendGroup> = { [groupId]: { id: groupId, name: cycleName, mode: 'sequential' } };

  const drafts: ResendDraft[] = calls.map((call) => ({ ...draftFrom(call, cycleId), groupId }));

  for (const suggestion of accepted) {
    if (suggestion.useCurrentSession) {
      for (const use of suggestion.uses) {
        if (use.callIndex >= 0 && use.callIndex < drafts.length) drafts[use.callIndex] = { ...drafts[use.callIndex], useCurrentSession: true };
      }
      continue;
    }
    const token = `{{this.${suggestion.name}}}`;
    for (const use of suggestion.uses) {
      const i = use.callIndex;
      if (i < 0 || i >= drafts.length) continue;
      drafts[i] = substituteInDraft(drafts[i], candidateValueOf(calls, suggestion), token);
    }
    const sourceIndex = suggestion.from.callIndex;
    if (sourceIndex >= 0 && sourceIndex < drafts.length) {
      const rule: ExtractRule = { from: suggestion.from.kind, path: suggestion.from.path, as: suggestion.name, missing: 'SKIP' };
      const existing = drafts[sourceIndex].extract ?? [];
      drafts[sourceIndex] = { ...drafts[sourceIndex], extract: [...existing, rule] };
    }
  }

  return { drafts, groups };
}

/** Recovers the literal value a suggestion was built from, by re-deriving it from its source call - cheaper than threading the raw value through ChainSuggestion just for this one call site. */
function candidateValueOf(calls: readonly CallRecord[], suggestion: ChainSuggestion): string {
  const call = calls[suggestion.from.callIndex];
  if (!call) return '';
  for (const candidate of candidatesFromResponse(call, suggestion.from.callIndex)) {
    if (candidate.source.kind === suggestion.from.kind && candidate.source.path === suggestion.from.path) return candidate.value;
  }
  return '';
}

function substituteInDraft(draft: ResendDraft, value: string, token: string): ResendDraft {
  if (!value) return draft;
  const swap = (text: string) => text.split(value).join(token);
  return {
    ...draft,
    url: swap(draft.url),
    body: swap(draft.body),
    headers: draft.headers.map((h) => (h.removed ? h : { ...h, value: swap(h.value) })),
  };
}
