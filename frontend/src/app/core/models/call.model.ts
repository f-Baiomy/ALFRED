export interface HttpMessageData {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface CallResponse extends HttpMessageData {
  readonly status: number;
}

/** One logged request/response pair, as served by GET /calls. */
export interface CallRecord {
  readonly original_url: string;
  readonly url: string;
  readonly method: string;
  readonly request?: HttpMessageData;
  readonly timestamp: string;
  readonly duration_ms: number;
  readonly response?: CallResponse;
  readonly error?: string;
}

export type SortMode = 'newest' | 'oldest' | 'slowest' | 'fastest' | 'status';

export type JsonViewMode = 'flat' | 'tree';

/** Wire envelope for the /ws/calls broadcast - the call plus which session-cycles (if any) captured it. */
export interface CallEvent {
  readonly call: CallRecord;
  readonly capturedByCycleIds: readonly string[];
}

export type SessionCycleStatus = 'RECORDING' | 'PAUSED';

/** A named, recordable/pausable group of calls, as served by GET /session-cycles. assignedTo is a free-form profile id reserved for a future profiles feature. */
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
