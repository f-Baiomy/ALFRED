/** Which REST resource/store a call came from - selecting sources that span both is handled one level up by requesting 'external' and 'internal' separately and merging (see CallsStateService.fetchPageForSource). */
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
/**
 * One call's network phases, as measured by the proxy - what turns "this took 5.7s" into a reason.
 *
 * A large `ttfb_ms` means the upstream is thinking; a large `download_ms` means the payload is big;
 * a large connect+TLS share means connections are not being reused, which is a fix on our side.
 * `reused_connection` is why connect/TLS are usually null: mitmproxy reuses server connections, and
 * the handshake then belongs to some earlier call rather than this one.
 */
export interface CallTiming {
  readonly connect_ms?: number | null;
  readonly tls_ms?: number | null;
  readonly ttfb_ms?: number | null;
  readonly download_ms?: number | null;
  readonly reused_connection?: boolean | null;
}

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
  /**
   * Which named project this call is attributed to - meaning differs by direction. On an internal
   * call (reverse-proxied): the project (from settings.properties's internal_call_services) that
   * reverse-proxy resolved this call to, or its "unknown" bucket - always set once the call is
   * logged. On an external call (forward-proxied): null/undefined by default (unattributed - most
   * external traffic, or data predating outbound attribution), but non-null once the calling
   * project has opted into forward-proxy outbound attribution, naming exactly which project made
   * the call. Undefined either way for a call logged before this field existed. See
   * sourceKeyOf()/sourceLabelOf() in call-utils.ts - sourceLabelOf renders a non-null value on an
   * external call as "External · via <Project>".
   */
  /**
   * How the proxy measured this call's own network phases (see backend CallTiming). Every field is
   * independently nullable: connect/TLS are absent on a reused connection, and the whole object is
   * absent for a call logged before the proxy reported any of this. Absent means NOT MEASURED,
   * never zero.
   */
  readonly timing?: CallTiming | null;
  readonly service_name?: string | null;
  /** Which backend endpoint this call was fetched from - stamped client-side in toCallRecord(), never part of the wire shape. Undefined only for a CapturedCall's wrapped CallRecord (session-cycles never captures 'internal' calls, so it's always implicitly 'external' there). Needed so getCallDetail() knows whether to fetch GET /calls/{id}/detail or GET /internal-calls/{id}/detail once a call from a merged 'both' list is expanded. */
  readonly source?: CallEndpointSource;
}

/**
 * One expandable block of a call. Each is fetched on its own the first time it's opened (see
 * GET /calls/{id}/detail's `part` param) - a card lists all four collapsed from the start, and a
 * response body that's never opened is never transferred.
 */
export type CallDetailPart = 'request-headers' | 'request-body' | 'response-headers' | 'response-body';

/** The full request/response for one call - GET /calls/{id}/detail's response shape. A per-part
 * fetch returns this same shape with only the requested part populated. */
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
  readonly service_name?: string | null;
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
 * A single entry in the Sources bar's selection set - either the reserved key 'external' (today's
 * mitmproxy-forward-mode-captured supplier traffic, GET /calls, /ws/calls) or a named internal
 * project's `name` (matching CallRecord.service_name, including its reserved "unknown" bucket) -
 * GET /internal-calls, /ws/internal-calls, narrowed server-side by serviceNames. See
 * CallsStateService.selectedSources/fetchPageForSource for how a set of these is turned into
 * actual requests.
 */
export type SourceKey = string;

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

/**
 * GET /call-overlaps and GET /session-cycles/{id}/call-overlaps's per-item wire shape - a
 * candidate call that might strictly nest inside another call's own [timestamp, timestamp +
 * duration_ms] window. Only ever includes resolved calls: an unresolved call has no fixed end
 * time, so it can never be "contained" in anything - see splitCallsForDisplay's containment rule
 * in shared/utils/call-utils.ts. `serviceName` mirrors CallRecord.service_name in both directions:
 * null for an unattributed external candidate (the common case, or one predating outbound
 * attribution) or an internal candidate logged before the field existed, non-null for an internal
 * candidate (its own project, including its "unknown" bucket) or an external candidate once
 * outbound attribution names which project made it; `status`/`error` mirror
 * CallRecord.response.status/CallRecord.error, flattened the same way CallSummaryDto flattens them.
 */
export interface CallOverlapCandidate {
  readonly id: string;
  readonly source: CallEndpointSource;
  readonly serviceName: string | null;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly status: number | null;
  readonly error: string | null;
}
