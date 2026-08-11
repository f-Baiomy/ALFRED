export interface HttpMessageData {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface CallResponse extends HttpMessageData {
  readonly status: number;
}

/**
 * One logged request/response pair. `request`/`response.headers`/`response.body` are undefined
 * until hydrated - GET /calls and GET /session-cycles/{id}/calls return only the summary fields
 * (id, both urls, method, timestamp, duration_ms, response.status, error), since headers/bodies
 * routinely dominate a call's size and most calls in a list are scanned, never opened. The rest is
 * fetched only once a call is actually expanded, via GET /calls/{id}/detail (or the session-cycles
 * equivalent) - see CallDetailCacheService.
 */
export interface CallRecord {
  readonly id: string;
  readonly original_url: string;
  readonly url: string;
  readonly method: string;
  readonly request?: HttpMessageData;
  readonly timestamp: string;
  readonly duration_ms: number;
  readonly response?: CallResponse;
  readonly error?: string;
}

/** The full request/response for one call - GET /calls/{id}/detail's response shape. */
export interface CallDetail {
  readonly request?: HttpMessageData;
  readonly response?: CallResponse;
}

/** GET /calls and GET /session-cycles/{id}/calls' per-item wire shape - a CallRecord without request/response headers/bodies, with status flattened rather than nested. See shared/utils/call-utils.ts's toCallRecord(). */
export interface CallSummaryDto {
  readonly id: string;
  readonly original_url: string;
  readonly url: string;
  readonly method: string;
  readonly timestamp: string;
  readonly duration_ms: number;
  readonly status: number | null;
  readonly error?: string;
}

/** 'custom' is a manually drag-and-drop-ordered arrangement - only ever reachable on a session-cycle
 * detail page (see CALL_REORDER_STATE), never on the main dashboard. */
export type SortMode = 'newest' | 'oldest' | 'newest-call' | 'oldest-call' | 'slowest' | 'fastest' | 'status' | 'custom';

export type JsonViewMode = 'flat' | 'tree';

/** Wire envelope for the /ws/calls broadcast - the call plus which session-cycles (if any) captured it. Carries a CallSummaryDto, not a hydrated CallRecord - a live-pushed call's detail is fetched the same lazy way as any other, once toCallRecord() converts this to the frontend shape. */
export interface CallEvent {
  readonly call: CallSummaryDto;
  readonly capturedByCycleIds: readonly string[];
}

export type SessionCycleStatus = 'RECORDING' | 'PAUSED';

/** A named, recordable/pausable group of calls, as served by GET /session-cycles. assignedTo is a Profile's id (see profile.model.ts) - resolved to a display name via ProfilesStateService.labelFor, not shown raw. */
export interface SessionCycle {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly assignedTo: string | null;
  readonly status: SessionCycleStatus;
}

/** One call captured into a session-cycle, as served by GET /session-cycles/{id}/calls. */
export interface CapturedCall {
  readonly id: string;
  readonly capturedAt: string;
  readonly call: CallRecord;
}
