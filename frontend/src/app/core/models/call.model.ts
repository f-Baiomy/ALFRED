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
