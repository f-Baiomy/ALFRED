/** Which REST resource/store a call came from - 'both' (CallSource, below) isn't a valid endpoint on its own, it's handled one level up by requesting 'external' and 'internal' separately and merging. */
export type CallEndpointSource = 'external' | 'internal';

export interface HttpMessageData {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** Where a call is in its two-phase logging lifecycle - see backend's CallLifecycleStatus. Distinct from the HTTP status code in `response`. Optional/undefined only for data that predates two-phase logging (defaults to however error/response already implied "resolved" before this field existed). */
export type CallLifecycleState = 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';

export interface CallResponse extends HttpMessageData {
  readonly status: number;
}

/**
 * One logged request/response pair. `request`/`response.headers`/`response.body` are undefined
 * until hydrated - GET /calls and GET /session-cycles/{id}/calls return only the summary fields
 * (id, both urls, method, timestamp, duration_ms, response.status, error), since headers/bodies
 * routinely dominate a call's size and most calls in a list are scanned, never opened. The rest is
 * fetched only once a call is actually expanded, via GET /calls/{id}/detail (or the session-cycles
 * equivalent) - always a real network call, never cached client-side, even if this same call's
 * detail was already fetched before.
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
  /** Best-effort supplier name parsed server-side from the request body's "supplier" JSON field (see backend's CallSummary.supplierNameOf) - null/undefined when it couldn't be determined. Part of the summary, not the detail, so it shows on a collapsed card with no extra fetch. */
  readonly supplierName?: string | null;
  readonly state?: CallLifecycleState;
  /** The proxy's X-Session-ID header value, or a proxy-generated UUID if the client didn't send one - null/undefined only for a call logged before this field existed. */
  readonly session_id?: string | null;
  /** The proxy's X-Operation-Id header value, or a proxy-generated UUID if the client didn't send one - null/undefined only for a call logged before this field existed. */
  readonly operation_id?: string | null;
  /** Which backend endpoint this call was fetched from - stamped client-side in toCallRecord(), never part of the wire shape. Undefined only for a CapturedCall's wrapped CallRecord (session-cycles never captures 'internal' calls, so it's always implicitly 'external' there). Needed so getCallDetail() knows whether to fetch GET /calls/{id}/detail or GET /internal-calls/{id}/detail once a call from a merged 'both' list is expanded. */
  readonly source?: CallEndpointSource;
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
  readonly supplierName?: string | null;
  readonly state?: CallLifecycleState;
  readonly session_id?: string | null;
  readonly operation_id?: string | null;
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

/** The other /ws/calls broadcast shape - sent once after the Database settings tab's "Clear calls" action, no payload beyond the discriminator. */
export interface CallsClearedEvent {
  readonly type: 'calls-cleared';
}

export type CallsWsMessage = CallEvent | CallsClearedEvent;

/**
 * Which backend-side source(s) the Live Calls view is reading from - 'external' is today's
 * mitmproxy-forward-mode-captured supplier traffic (GET /calls, /ws/calls), unchanged default.
 * 'internal' is the separate backend-internal-calls slice logging browser-to-WildFly traffic
 * (GET /internal-calls, /ws/internal-calls) - a totally independent store, not a filter over the
 * same data. 'both' merges the two client-side (see CallsStateService.fetchPageForSource).
 */
export type CallSource = 'external' | 'internal' | 'both';

/** Wire envelope for the /ws/internal-calls broadcast - mirrors CallEvent exactly now that backend-internal-calls traffic can also be captured into a session-cycle (see CapturedCall). */
export interface InternalCallEvent {
  readonly call: CallSummaryDto;
  readonly capturedByCycleIds: readonly string[];
}

/** The other /ws/internal-calls broadcast shape - mirrors CallsClearedEvent, sent when internal calls are cleared. */
export type InternalCallsWsMessage = InternalCallEvent | CallsClearedEvent;

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
