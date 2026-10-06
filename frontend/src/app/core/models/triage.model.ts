/**
 * Triage's saved mark of a call (backend-triage, GET /triage/calls and /triage/live): written as the call, its supplier
 * calls and its database statements arrive, so "what needs attention" is one indexed read. Shared by the UI and the
 * MCP server (which imports this file), so both read the wire shape the same way.
 */

/** An error inside a body whose status claims success - the same detector as shared/utils/soft-failure.ts. */
export interface AttentionSoftFailure {
  readonly kind: string;
  readonly code?: string | null;
  readonly message: string;
}

export interface AttentionMark {
  readonly callId: string;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly project?: string | null;
  /** Outbound: the inbound call that made it, when the db-agent linked them. */
  readonly parentCallId?: string | null;
  readonly method?: string | null;
  readonly url?: string | null;
  readonly status?: number | null;
  readonly error?: string | null;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly durationMs?: number | null;
  /** IN_PROGRESS / COMPLETED / ERROR, or UNKNOWN when only its supplier calls or statements have been reported so far. */
  readonly state: string;
  readonly softFailure?: AttentionSoftFailure | null;
  /** Result-like keys of a successful JSON response that are all empty. */
  readonly emptyKeys: readonly string[];
  readonly failingChildren: number;
  readonly failedStatements: number;
  readonly swallowedStatements: number;
  /** Its caught log lines' and database flags' signals (specs/010-mcp-log-investigation); absent on an older Alfred. */
  readonly signals?: AttentionSignals;
}

export interface AttentionSignals {
  readonly logErrors?: number;
  readonly logWarnings?: number;
  readonly logExceptions?: number;
  readonly logStatus?: string | null;
  readonly logLevel?: string | null;
  readonly dbFlags?: readonly string[];
}

/**
 * A mark ranked for the threshold asked (default 300):
 * 1 failed + failing supplier call · 2 failed + failed statements · 3 other failed ·
 * 4 succeeded but a supplier call or statement under it failed · 5 error inside its body / empty result · 6 the rest.
 */
export interface TriageEntry extends AttentionMark {
  readonly priority: 1 | 2 | 3 | 4 | 5 | 6;
  /** Its own status/error/still-running says so (its children and statements not counted). */
  readonly needsAttention: boolean;
  readonly failingSupplierCalls: readonly AttentionMark[];
}

/** GET /db-capture/failures - a call's failed statements, from the failed-statement index (at most 50 listed). */
export interface CallStatementFailures {
  readonly callId: string;
  readonly failedCount: number;
  readonly swallowedCount: number;
  readonly statements: readonly FailedStatement[];
}

export interface FailedStatement {
  readonly id: number;
  readonly seq: number;
  readonly kind: string;
  readonly table?: string | null;
  readonly sql: string;
  readonly sqlState?: string | null;
  readonly vendorCode?: number | null;
  readonly message?: string | null;
  readonly swallowed: boolean;
  readonly undone: boolean;
  readonly durationMicros: number;
  readonly codeLocation?: string | null;
  readonly callers?: readonly string[] | null;
}

/** /ws/triage: these calls' marks changed. */
export interface AttentionChangedEvent {
  readonly type: 'attention-changed';
  readonly callIds: readonly string[];
}
