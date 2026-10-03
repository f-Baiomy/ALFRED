import { CallRecord } from '../../core/models/call.model';
import { CallRef, refOf } from '../../core/models/call-ref.model';
import { ResendEdits } from '../../core/services/resend-api.service';
import { bodiesDiffer } from './body-format';

/** One header as it is being edited. `added` = not on the original call; `removed` = will be sent as null (removed). */
export interface DraftHeader {
  readonly name: string;
  readonly value: string;
  readonly removed: boolean;
  readonly added?: boolean;
}

/**
 * C1: one thing to pull out of a call's resend response and remember as `this.<as>` for later
 * drafts to substitute with `{{this.<as>}}`. See contracts.md section 6 (shared with F-SCENARIO,
 * which also reads `as` names when building assertions) and resend-draft-chain.ts for evaluation.
 */
export interface ExtractRule {
  /** JSON: a dotted field path. HEADER / COOKIE: a name. XML: element names from the outside in,
   *  namespace prefixes ignored, `@name` last for an attribute (`Body.LoginResponse.token`).
   *  REGEX: a pattern run on the body - its first group, or the whole match without one. */
  readonly from: 'JSON' | 'HEADER' | 'COOKIE' | 'XML' | 'REGEX';
  readonly path: string;
  readonly as: string;
  readonly missing: 'SKIP' | 'FALLBACK';
  readonly fallback?: string;
  /** Relive only: the value the recording had. A run puts its own value wherever this one
   *  appears in a later step (relive-session.ts `swapRecordedValues`) - no edit to those steps. */
  readonly recordedValue?: string;
}

/** D1/F-SCENARIO: an assertion evaluated against a DraftResult. Owned by F-SCENARIO; the type is
 *  kept here (contracts.md section 6) purely so both sides import the same shape. */
export interface Assertion {
  readonly kind: 'STATUS' | 'JSON' | 'HEADER' | 'LATENCY';
  readonly path?: string;
  readonly operator: 'EQUALS' | 'NOT_EQUALS' | 'EXISTS' | 'NOT_EXISTS' | 'CONTAINS' | 'GT' | 'LT' | 'MATCHES';
  readonly value?: string;
}

/** D3: attempts 0-5, applied on top of `on` failure kinds. A retry is a new POST /resend. */
export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
  readonly on: readonly ('5XX' | 'NETWORK')[];
}

/** D3: a group's data-driven rows - CSV (header row) or a JSON array of objects, parsed client-side. */
export interface Dataset {
  readonly name: string;
  readonly rows: readonly Record<string, string>[];
  readonly onRowFailure: 'SKIP' | 'STOP';
}

/** The supplier response as C1/D1 see it - the same shape POST /resend now returns (contracts.md section 2). */
export interface ResendResponseSnapshot {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/**
 * One send attempt's outcome (contracts.md section 6). An array of these lives per draft key in
 * `BulkResendDialogService.results`, because a retry or a dataset row produces more than one per
 * key - `row` and `attempt` tell them apart.
 */
export interface DraftResult {
  readonly key: string;
  readonly row?: number;
  readonly attempt: number;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly newCallId: string | null;
  readonly error: string | null;
  readonly response: ResendResponseSnapshot | null;
  readonly extracted: Readonly<Record<string, string>>;
}

/**
 * One call as it will be resent. Starts as an exact copy of the logged request and is edited
 * freely; `editsOf` then sends only what actually differs. Shared by the single Resend dialog and
 * the multi-call resend editor so both turn a form into `ResendEdits` the same way.
 */
export interface ResendDraft {
  /** Stable within one editor session - used for list tracking and the big-tab channel key. */
  readonly key: string;
  readonly ref: CallRef;
  /** The hydrated logged call - what "unchanged" means. */
  readonly original: CallRecord;
  readonly include: boolean;
  /** The group this call belongs to, or null when it is loose. See resend-group.ts. */
  readonly groupId: string | null;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly DraftHeader[];
  readonly body: string;
  readonly useCurrentSession: boolean;
  /** C1: what to pull out of this call's response and remember as `this.<as>` for later drafts. */
  readonly extract?: readonly ExtractRule[];
  /** D1: evaluated by F-SCENARIO against this draft's DraftResult(s); not read by the resend send path. */
  readonly assertions?: readonly Assertion[];
}

let nextKey = 0;

export function draftFrom(call: CallRecord, cycleId: string | null): ResendDraft {
  return {
    key: `d${++nextKey}-${call.id}`,
    ref: refOf(call, cycleId),
    original: call,
    include: true,
    groupId: null,
    method: call.method,
    url: call.url,
    headers: Object.entries(call.request?.headers ?? {}).map(([name, value]) => ({ name, value, removed: false })),
    body: call.request?.body ?? '',
    useCurrentSession: false,
  };
}

/**
 * Back to the logged request, keeping whatever is not itself a request edit: which group it is
 * in, whether it is included, and its C1/D1 resend-time configuration (extract rules, assertions)
 * - none of those describe the REQUEST, so "reset this call" must not silently drop them.
 */
export function resetDraft(draft: ResendDraft): ResendDraft {
  return {
    ...draftFrom(draft.original, draft.ref.cycleId),
    key: draft.key,
    include: draft.include,
    groupId: draft.groupId,
    extract: draft.extract,
    assertions: draft.assertions,
  };
}

/**
 * Only what differs from the logged request. The body is compared normalized (bodiesDiffer), so
 * pressing Format alone is never an edit - a signed SOAP envelope still goes out byte-for-byte
 * unless its content really changed. A removed header is sent as null; an added one as its value.
 */
export function editsOf(draft: ResendDraft): ResendEdits {
  const originalHeaders = draft.original.request?.headers ?? {};
  const headers: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const row of draft.headers) {
    const name = row.name.trim();
    if (!name) continue;
    seen.add(name);
    const had = Object.prototype.hasOwnProperty.call(originalHeaders, name);
    if (row.removed) {
      if (had) headers[name] = null;
    } else if (!had || originalHeaders[name] !== row.value) {
      headers[name] = row.value;
    }
  }
  // A header deleted from the rows entirely (e.g. through the JSON view) is a removal too.
  for (const name of Object.keys(originalHeaders)) {
    if (!seen.has(name)) headers[name] = null;
  }
  const originalBody = draft.original.request?.body ?? '';
  return {
    ...(draft.method !== draft.original.method ? { method: draft.method } : {}),
    ...(draft.url !== draft.original.url ? { url: draft.url } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(bodiesDiffer(originalBody, draft.body) ? { body: draft.body } : {}),
  };
}

export function isEdited(draft: ResendDraft): boolean {
  return draft.useCurrentSession || Object.keys(editsOf(draft)).length > 0;
}

/** Short words for what changed - the list's "edited" tooltip and the result line. */
export function describeEdits(draft: ResendDraft): string[] {
  const edits = editsOf(draft);
  const out: string[] = [];
  if (edits.method) out.push('method');
  if (edits.url) out.push('URL');
  const headerCount = Object.keys(edits.headers ?? {}).length;
  if (headerCount) out.push(`${headerCount} header${headerCount === 1 ? '' : 's'}`);
  if (edits.body !== undefined) out.push('body');
  if (draft.useCurrentSession) out.push('current session');
  return out;
}

export function isInbound(draft: ResendDraft): boolean {
  return draft.ref.source === 'internal';
}

/* ---- Edit all at once. Each returns new drafts; only included ones change. ---- */

type Update = (draft: ResendDraft) => ResendDraft;

function onIncluded(drafts: readonly ResendDraft[], update: Update): ResendDraft[] {
  return drafts.map((d) => (d.include ? update(d) : d));
}

/** Sets the header on every included call - case-insensitively replacing an existing one, else adding it. */
export function setHeaderOnAll(drafts: readonly ResendDraft[], name: string, value: string): ResendDraft[] {
  const wanted = name.trim();
  if (!wanted) return [...drafts];
  const lower = wanted.toLowerCase();
  return onIncluded(drafts, (d) => {
    const existing = d.headers.some((h) => h.name.toLowerCase() === lower);
    const headers = existing
      ? d.headers.map((h) => (h.name.toLowerCase() === lower ? { ...h, value, removed: false } : h))
      : [...d.headers, { name: wanted, value, removed: false, added: true }];
    return { ...d, headers };
  });
}

export function removeHeaderFromAll(drafts: readonly ResendDraft[], name: string): ResendDraft[] {
  const lower = name.trim().toLowerCase();
  if (!lower) return [...drafts];
  return onIncluded(drafts, (d) => ({
    ...d,
    // An added header has nothing to remove on the server - it just goes away.
    headers: d.headers
      .filter((h) => !(h.added && h.name.toLowerCase() === lower))
      .map((h) => (h.name.toLowerCase() === lower ? { ...h, removed: true } : h)),
  }));
}

export interface FindReplaceScope {
  readonly inUrl: boolean;
  readonly inHeaders: boolean;
  readonly inBody: boolean;
}

/** How many matches the replace would change, across included calls. Null when the matcher is null (empty or invalid). */
export function countMatches(drafts: readonly ResendDraft[], matcher: RegExp | null, scope: FindReplaceScope): number | null {
  if (!matcher) return null;
  let count = 0;
  const countIn = (text: string) => (text.match(new RegExp(matcher.source, flagsWithGlobal(matcher))) ?? []).filter((m) => m !== '').length;
  for (const d of drafts) {
    if (!d.include) continue;
    if (scope.inUrl) count += countIn(d.url);
    if (scope.inHeaders) for (const h of d.headers) if (!h.removed) count += countIn(h.value);
    if (scope.inBody) count += countIn(d.body);
  }
  return count;
}

export function findReplaceAll(drafts: readonly ResendDraft[], matcher: RegExp | null, replacement: string, scope: FindReplaceScope): ResendDraft[] {
  if (!matcher) return [...drafts];
  const global = new RegExp(matcher.source, flagsWithGlobal(matcher));
  const swap = (text: string) => text.replace(global, replacement);
  return onIncluded(drafts, (d) => ({
    ...d,
    url: scope.inUrl ? swap(d.url) : d.url,
    headers: scope.inHeaders ? d.headers.map((h) => (h.removed ? h : { ...h, value: swap(h.value) })) : d.headers,
    body: scope.inBody ? swap(d.body) : d.body,
  }));
}

export function setMethodOnAll(drafts: readonly ResendDraft[], method: string): ResendDraft[] {
  const m = method.trim().toUpperCase();
  return m ? onIncluded(drafts, (d) => ({ ...d, method: m })) : [...drafts];
}

/**
 * Points every included OUTBOUND call at another host (port kept unless given). Inbound calls
 * always go to their project's reverse-proxy listener, so a host there would be ignored - they are
 * left alone and counted in `skipped` for the UI to say so.
 */
export function setHostOnAll(drafts: readonly ResendDraft[], host: string): { drafts: ResendDraft[]; skipped: number } {
  const wanted = host.trim();
  let skipped = 0;
  if (!wanted) return { drafts: [...drafts], skipped };
  const out = onIncluded(drafts, (d) => {
    if (isInbound(d)) {
      skipped++;
      return d;
    }
    try {
      const url = new URL(d.url);
      url.host = wanted;
      return { ...d, url: url.toString() };
    } catch {
      skipped++;
      return d;
    }
  });
  return { drafts: out, skipped };
}

export function setCurrentSessionOnAll(drafts: readonly ResendDraft[], on: boolean): ResendDraft[] {
  return onIncluded(drafts, (d) => ({ ...d, useCurrentSession: on }));
}

function flagsWithGlobal(matcher: RegExp): string {
  return matcher.flags.includes('g') ? matcher.flags : matcher.flags + 'g';
}
