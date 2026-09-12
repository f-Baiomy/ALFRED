import { CallOverlapCandidate, CallRecord, CallResponse, HttpMessageData } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { CallStatusFilter, isInProgress } from './call-utils';

/** A request-side event, emitted for every internal call that gets split (see buildBulkExportPayload). */
export interface BulkExportRequestEvent {
  readonly type: 'request';
  readonly callId: string;
  readonly service_name: string | null | undefined;
  readonly method: string;
  readonly original_url: string;
  readonly url: string;
  readonly timestamp: string;
  readonly request?: HttpMessageData;
  readonly session_id?: string | null;
  readonly operation_id?: string | null;
  readonly comments: readonly Comment[];
}

/** The response-side counterpart to a BulkExportRequestEvent, correlated purely by sharing the same callId. */
export interface BulkExportResponseEvent {
  readonly type: 'response';
  readonly callId: string;
  readonly status: number | undefined;
  readonly error?: string;
  readonly duration_ms: number;
  readonly timestamp: string;
  readonly response?: CallResponse;
}

/** An unsplit call - every external call, or an internal call that isn't resolved yet and shouldn't emit a synthetic response. */
export interface BulkExportCallEvent {
  readonly type: 'call';
  readonly callId: string;
  readonly service_name: string | null | undefined;
  readonly method: string;
  readonly original_url: string;
  readonly url: string;
  readonly timestamp: string;
  readonly duration_ms?: number;
  readonly status?: number;
  readonly error?: string;
  readonly request?: HttpMessageData;
  readonly response?: CallResponse;
  readonly session_id?: string | null;
  readonly operation_id?: string | null;
  readonly comments: readonly Comment[];
}

export type BulkExportEvent = BulkExportRequestEvent | BulkExportResponseEvent | BulkExportCallEvent;

export interface BulkExportPayload {
  readonly metadata: ExportFormData;
  readonly exportedAt: string;
  readonly summary: {
    readonly callCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly totalDurationMs: number;
  };
  readonly events: readonly BulkExportEvent[];
}

/** Response event's timestamp is derived, not stored - the moment the response was actually received, not restated at the request's own timestamp. */
function responseTimestamp(call: CallRecord): string {
  return new Date(new Date(call.timestamp).getTime() + (call.duration_ms ?? 0)).toISOString();
}

/**
 * Same 4-check containment + ownership + blocking-signature + ambiguity-veto algorithm as
 * call-utils.ts's qualifiesAsEvidence/computeSplitCallIds - re-implemented here per this codebase's
 * mirror-per-consumer convention (see markdown-builder.ts/html-builder.ts's identical copies).
 */
const MIN_COVERAGE_RATIO = 0.3;
const MIN_TAIL_MS = 250;
const TAIL_RATIO = 0.1;

function targetWindow(target: CallRecord): { start: number; end: number } {
  const start = new Date(target.timestamp).getTime();
  return { start, end: start + (target.duration_ms ?? 0) };
}

/** Whether `inner` sits STRICTLY inside `outer` - one-directionally. Two calls with identical
 * windows contain each other, and that's ambiguity rather than nesting: there's no telling which of
 * them a call inside both belongs to, so neither may claim it. Mirrors call-tree.ts's resolveParent,
 * so the split and the tree views can never disagree about whose downstream work a call was. */
function strictlyContainsCall(outer: CallRecord, inner: CallRecord): boolean {
  if (outer.id === inner.id) return false;
  const o = targetWindow(outer);
  const i = targetWindow(inner);
  const innerFitsInOuter = i.start >= o.start && i.end <= o.end;
  const outerFitsInInner = o.start >= i.start && o.end <= i.end;
  return innerFitsInOuter && !outerFitsInInner;
}

function candidateWindow(candidate: CallOverlapCandidate): { start: number; end: number } {
  const start = new Date(candidate.timestamp).getTime();
  return { start, end: start + candidate.durationMs };
}

/** Check 1 of 4: strict containment - see call-utils.ts's isStrictlyContained. */
function isStrictlyContained(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  if (candidate.id === target.id) return false;
  const t = targetWindow(target);
  const c = candidateWindow(candidate);
  return c.start >= t.start && c.end <= t.end;
}

/** Check 2 of 4: ownership/attribution - see call-utils.ts's passesOwnershipCheck. */
function passesOwnershipCheck(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  const targetServiceName = target.service_name ?? null;
  if (candidate.source === 'internal') {
    return candidate.serviceName !== targetServiceName;
  }
  if (candidate.serviceName == null) return true;
  return candidate.serviceName === targetServiceName;
}

/** The single-child blocking signature - see call-utils.ts's passesBlockingSignature. */
function passesBlockingSignature(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  const targetDurationMs = target.duration_ms ?? 0;
  if (targetDurationMs <= 0) return false;

  const t = targetWindow(target);
  const c = candidateWindow(candidate);
  const coverage = candidate.durationMs / targetDurationMs;
  const tail = t.end - c.end;

  return coverage >= MIN_COVERAGE_RATIO && tail <= Math.max(MIN_TAIL_MS, targetDurationMs * TAIL_RATIO);
}

/** Checks 1-2 combined - see call-utils.ts's qualifiesAsNestedChild. */
function qualifiesAsNestedChild(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  return isStrictlyContained(target, candidate) && passesOwnershipCheck(target, candidate);
}

/** Check 3 of 4, applied to the whole surviving SET rather than per candidate - see call-utils.ts's
 * hasBlockingEvidence for why a fan-out parent can't be held to the single-child signature. */
function hasBlockingEvidence(target: CallRecord, survivors: readonly CallOverlapCandidate[]): boolean {
  if (survivors.length >= 2) return true;
  return survivors.length === 1 && passesBlockingSignature(target, survivors[0]);
}

/** Mirrors call-utils.ts's candidateMatchesStatusFilter - see its doc. */
function candidateMatchesStatusFilter(candidate: CallOverlapCandidate, filter: CallStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'inProgress':
      return false;
    case 'ok':
      return candidate.status != null && candidate.status < 400;
    case 'client':
      return candidate.status != null && candidate.status >= 400 && candidate.status < 500;
    case 'failed':
      return candidate.error != null || (candidate.status != null && candidate.status >= 500);
  }
}

/** Mirrors call-utils.ts's computeSplitCallIds - see its doc for the exact two-pass mechanics. */
function computeSplitCallIds(
  internalCalls: readonly CallRecord[],
  candidates: readonly CallOverlapCandidate[],
  statusFilter: CallStatusFilter
): ReadonlySet<string> {
  const visibleCandidates = candidates.filter((candidate) => candidateMatchesStatusFilter(candidate, statusFilter));

  const survivorsByCallId = new Map<string, CallOverlapCandidate[]>(internalCalls.map((call) => [call.id, []]));

  for (const candidate of visibleCandidates) {
    const owners = internalCalls.filter((call) => qualifiesAsNestedChild(call, candidate));
    if (owners.length === 0) continue;

    // The INNERMOST owner takes it, provided the owners form a single nested chain - odeysys
    // containing core-service containing this call isn't ambiguous at all, it just means
    // core-service is whose work it was. Only owners that merely OVERLAP, neither inside the other,
    // are genuinely ambiguous, and those give it up entirely rather than guess.
    const innermost = owners.reduce((best, owner) => ((owner.duration_ms ?? 0) < (best.duration_ms ?? 0) ? owner : best));
    const nestedChain = owners.every((owner) => owner.id === innermost.id || strictlyContainsCall(owner, innermost));
    if (!nestedChain) continue;

    survivorsByCallId.get(innermost.id)!.push(candidate);
  }

  const staysSplit = new Set<string>();
  const callsById = new Map(internalCalls.map((call) => [call.id, call]));
  for (const [callId, survivors] of survivorsByCallId) {
    if (hasBlockingEvidence(callsById.get(callId)!, survivors)) staysSplit.add(callId);
  }
  return staysSplit;
}

/** An internal call is eligible to be split at all only once it's resolved (has a response or
 * error, never while still in-progress) - see eventsForCall/buildBulkExportPayload. */
function isResolvedInternalCall(call: CallRecord): boolean {
  return call.source === 'internal' && (call.response !== undefined || call.error !== undefined) && !isInProgress(call);
}

/**
 * Expands one call into its exported event(s). An internal, resolved call (has a response or an
 * error - i.e. not still in-progress) becomes a request event followed by a response event,
 * correlated purely by sharing `callId` (no new correlation-id concept) - but ONLY when it stays
 * split per the full 4-check algorithm, precomputed across every resolved internal call at once
 * (see computeSplitCallIds/buildBulkExportPayload): otherwise it emits a single 'call' event
 * instead, mirroring an external call's shape exactly. An internal call that's still in-progress
 * emits only its request event regardless - fabricating a response here would misrepresent a
 * legitimate point-in-time export taken mid-flight, and an in-progress call was never a
 * containment candidate to begin with. Every external call (never split, regardless of its
 * resolution state) emits a single 'call' event mirroring today's per-call shape exactly.
 *
 * Comments are attached to the request event (or the merged 'call' event) only, not duplicated
 * onto the response event too - a call's comments aren't inherently request-side or response-side
 * (see CommentBlock, which already distinguishes request- and response- prefixed fields), so
 * there's no need to carry two copies of the same list through the file; a reader/reprocessor
 * groupBy(callId)-ing the events back into a call finds the comments on whichever event happens to
 * be first in file order.
 */
function eventsForCall(call: CallRecord, comments: readonly Comment[], staysSplitIds: ReadonlySet<string>): BulkExportEvent[] {
  const asCallEvent = (): BulkExportCallEvent => ({
    type: 'call',
    callId: call.id,
    service_name: call.service_name,
    method: call.method,
    original_url: call.original_url,
    url: call.url,
    timestamp: call.timestamp,
    duration_ms: call.duration_ms,
    status: call.response?.status,
    error: call.error,
    request: call.request,
    response: call.response,
    session_id: call.session_id,
    operation_id: call.operation_id,
    comments,
  });

  if (call.source !== 'internal') {
    return [asCallEvent()];
  }

  const resolved = isResolvedInternalCall(call);

  const requestEvent: BulkExportRequestEvent = {
    type: 'request',
    callId: call.id,
    service_name: call.service_name,
    method: call.method,
    original_url: call.original_url,
    url: call.url,
    timestamp: call.timestamp,
    request: call.request,
    session_id: call.session_id,
    operation_id: call.operation_id,
    comments,
  };

  if (!resolved) return [requestEvent];
  if (!staysSplitIds.has(call.id)) return [asCallEvent()];

  const responseEvent: BulkExportResponseEvent = {
    type: 'response',
    callId: call.id,
    status: call.response?.status,
    error: call.error,
    duration_ms: call.duration_ms,
    timestamp: responseTimestamp(call),
    response: call.response,
  };
  return [requestEvent, responseEvent];
}

/**
 * The .json counterpart to buildBulkExportMarkdown - same metadata and per-call comments,
 * structured for a machine to reprocess rather than a person to read. Emits one event per
 * request/response EVENT (not one object per call): an internal, resolved call's request and
 * response come out as two separate events sharing `callId`, so a reprocessor can
 * `groupBy(event.callId)` to reconstruct a call - see eventsForCall(). exportedAt is passed in
 * rather than computed here with `new Date()`, so this stays a pure, easily-testable function.
 */
export function buildBulkExportPayload(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  exportedAt: string,
  overlapCandidates: readonly CallOverlapCandidate[] = [],
  statusFilter: CallStatusFilter = 'all'
): BulkExportPayload {
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;

  // Computed once, up front, across every resolved internal call in `calls` - the ambiguity veto
  // needs the full picture of who else a candidate might be evidence for before any single call's
  // split/merge decision can be made (see computeSplitCallIds).
  const resolvedInternalCalls = calls.filter(isResolvedInternalCall);
  const staysSplitIds = computeSplitCallIds(resolvedInternalCalls, overlapCandidates, statusFilter);

  // Sorted by each event's own timestamp (not call order, and not "all of call A's events before
  // call B's") so a resolved call's response event correctly interleaves after whatever other
  // calls' requests/responses happened in between it and its own request - the same real-time
  // ordering buildBulkExportMarkdown/buildBulkExportHtml force for the same reason.
  const events = calls
    .flatMap((call) => eventsForCall(call, commentsByCallId.get(call.id) ?? [], staysSplitIds))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    metadata: form,
    exportedAt,
    summary: {
      // Stays a count of actual calls, not events - splitting a call into two events must not double it here.
      callCount: calls.length,
      succeeded,
      failed: calls.length - succeeded,
      totalDurationMs: calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0),
    },
    events,
  };
}
