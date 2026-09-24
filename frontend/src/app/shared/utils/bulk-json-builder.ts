import { CallEndpointSource, CallLifecycleState, CallOverlapCandidate, CallRecord, CallResponse, HttpMessageData } from '../../core/models/call.model';
import { CallInterception } from '../../core/models/interception.model';
import { WsMessage } from '../../core/models/ws-message.model';
import { ExportedCycle, ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { CallStatusFilter, isInProgress } from './call-utils';
import { buildExportNarrative, ExportNarrative } from './export-narrative';

/** A request-side event, emitted for every internal call that gets split (see buildBulkExportPayload). */
export interface BulkExportRequestEvent {
  readonly type: 'request';
  readonly callId: string;
  /** Always 'internal' here (only an internal call is ever split), but stated rather than implied -
   * see BulkExportCallEvent.source for why this file carries direction explicitly. */
  readonly source: CallEndpointSource;
  readonly service_name: string | null | undefined;
  readonly method: string;
  readonly original_url: string;
  readonly url: string;
  readonly timestamp: string;
  readonly request?: HttpMessageData;
  readonly session_id?: string | null;
  readonly operation_id?: string | null;
  /** Load-bearing on THIS event in particular: an in-progress internal call emits a request event
   * and nothing else, so without `state` here the file cannot distinguish a call that was still in
   * flight when the export was taken from one whose response was simply never recorded. */
  readonly state?: CallLifecycleState;
  readonly comments: readonly Comment[];
  /** What an interception rule did to the call - see BulkExportCallEvent.interception. */
  readonly interception?: CallInterception;
  /** See BulkExportCallEvent.wsMessages - rides on the request event for a split internal call, same as comments/interception. */
  readonly wsMessages?: readonly WsMessage[];
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
  readonly state?: CallLifecycleState;
}

/** An unsplit call - every external call, or an internal call that isn't resolved yet and shouldn't emit a synthetic response. */
export interface BulkExportCallEvent {
  readonly type: 'call';
  readonly callId: string;
  /**
   * Which side of the app this call is - the single most load-bearing field for anything that reads
   * this file back, and deliberately NOT left to be inferred from `service_name`.
   *
   * It is tempting to infer it: on most captures a non-null service_name does mean inbound. But an
   * OUTBOUND call legitimately carries a service_name once its project opts into forward-proxy
   * outbound attribution (see CallRecord.service_name), so the inference silently misfiles exactly
   * those deployments - and `source` decides both which store a re-import lands in and whether a
   * call may own children at all (only 'internal' can - see call-tree.ts's canOwn), so getting it
   * wrong flattens every chain in the file.
   */
  readonly source: CallEndpointSource;
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
  /** Carried so a re-import can tell a completed call from one exported mid-flight, rather than
   * having to guess from the presence of a response. */
  readonly state?: CallLifecycleState;
  readonly comments: readonly Comment[];
  /**
   * What an interception rule (or a human at a breakpoint) did to this call, with both ends of
   * every half it changed. A fact about the whole call, so a split call carries it once, on its
   * request event, the same way it carries its comments. Absent on a call nothing touched.
   */
  readonly interception?: CallInterception;
  /**
   * Every WebSocket message this call carried (status 101 only) - untruncated, same
   * no-truncation guarantee as request/response bodies. Absent for anything that isn't a
   * WebSocket call, or wasn't fetched before export (see CallRecord.wsMessages).
   */
  readonly wsMessages?: readonly WsMessage[];
}

export type BulkExportEvent = BulkExportRequestEvent | BulkExportResponseEvent | BulkExportCallEvent;

export interface BulkExportPayload {
  /**
   * What this document is, who called whom, and what the comments are - the .json counterpart to the
   * "About This Document" section the .md/.html exports open with. First key in the file on purpose:
   * an agent handed this payload reads the narrative before it reaches a single event, and
   * `about.description` alone is enough to orient without parsing anything else. See
   * export-narrative.ts.
   */
  readonly about: ExportNarrative;
  readonly metadata: ExportFormData;
  readonly exportedAt: string;
  /** How many values the user hid before exporting. Non-zero means this file is deliberately incomplete - the import dialog surfaces that rather than letting it pass silently. */
  readonly redactedValueCount: number;
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
 * Same 3-check containment + ownership + ambiguity-veto algorithm as call-utils.ts's
 * qualifiesAsEvidence/computeSplitCallIds - re-implemented here per this codebase's
 * mirror-per-consumer convention (see markdown-builder.ts/html-builder.ts's identical copies).
 */
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

/** Checks 1-2 combined - see call-utils.ts's qualifiesAsNestedChild. */
function qualifiesAsNestedChild(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  return isStrictlyContained(target, candidate) && passesOwnershipCheck(target, candidate);
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
  for (const [callId, survivors] of survivorsByCallId) {
    if (survivors.length > 0) staysSplit.add(callId);
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
    source: call.source ?? 'external',
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
    state: call.state,
    comments,
    interception: call.interception ?? undefined,
    wsMessages: call.wsMessages,
  });

  if (call.source !== 'internal') {
    return [asCallEvent()];
  }

  const resolved = isResolvedInternalCall(call);

  const requestEvent: BulkExportRequestEvent = {
    type: 'request',
    callId: call.id,
    source: 'internal',
    service_name: call.service_name,
    method: call.method,
    original_url: call.original_url,
    url: call.url,
    timestamp: call.timestamp,
    request: call.request,
    session_id: call.session_id,
    operation_id: call.operation_id,
    state: call.state,
    comments,
    interception: call.interception ?? undefined,
    wsMessages: call.wsMessages,
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
    state: call.state,
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
  statusFilter: CallStatusFilter = 'all',
  redactedValueCount = 0,
  cycle: ExportedCycle | null = null
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
    // `cycle` rides inside `about` rather than as its own top-level key: it is a fact ABOUT the
    // document (which capture this is, and that it is complete), which is exactly what `about` is
    // for, and a re-importer already reads that object. See ExportNarrative.cycle.
    about: buildExportNarrative({ calls, commentsByCallId, splitCallIds: staysSplitIds, overlapCandidates, cycle }),
    metadata: form,
    exportedAt,
    // Stated at the top level rather than inside `about`, because this is the one fact a
    // re-importer must act on rather than merely read: this file is deliberately lossy, and the
    // import dialog warns on it. 0 means the file is a complete capture.
    redactedValueCount,
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
