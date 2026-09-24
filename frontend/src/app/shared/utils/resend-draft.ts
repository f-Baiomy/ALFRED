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
  readonly method: string;
  readonly url: string;
  readonly headers: readonly DraftHeader[];
  readonly body: string;
  readonly useCurrentSession: boolean;
}

let nextKey = 0;

export function draftFrom(call: CallRecord, cycleId: string | null): ResendDraft {
  return {
    key: `d${++nextKey}-${call.id}`,
    ref: refOf(call, cycleId),
    original: call,
    include: true,
    method: call.method,
    url: call.url,
    headers: Object.entries(call.request?.headers ?? {}).map(([name, value]) => ({ name, value, removed: false })),
    body: call.request?.body ?? '',
    useCurrentSession: false,
  };
}

/** Back to the logged request, keeping only whether it is included. */
export function resetDraft(draft: ResendDraft): ResendDraft {
  return { ...draftFrom(draft.original, draft.ref.cycleId), key: draft.key, include: draft.include };
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

export function moveDraft(drafts: readonly ResendDraft[], from: number, to: number): ResendDraft[] {
  const out = [...drafts];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

function flagsWithGlobal(matcher: RegExp): string {
  return matcher.flags.includes('g') ? matcher.flags : matcher.flags + 'g';
}
