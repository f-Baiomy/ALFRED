/**
 * Database Capture (docs/db-capture.md, specs/006-db-capture/data-model.md) - the statements the db-agent records
 * inside the application, tied to their inbound call. Mirrors backend-db-capture's domain records.
 */

export type StatementKind =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'CALL' | 'DDL' | 'OTHER'
  | 'COMMIT' | 'ROLLBACK' | 'SAVEPOINT' | 'ROLLBACK_TO_SAVEPOINT';

/** A parameter or column value: JDBC/vendor type name and text form. `value: null` is SQL NULL. */
export interface TypedValue {
  readonly type?: string | null;
  readonly value: string | null;
  /** A vendor object the agent could only print, or a stream/LOB it did not read. */
  readonly opaque?: boolean;
  /** Set only for a streamed LOB longer than the agent keeps - shown, never silent. */
  readonly truncatedAt?: number | null;
  /** IN / OUT / INOUT for procedure parameters. */
  readonly direction?: string | null;
}

/** The agent's marker for a column the application never read (kept distinct from SQL NULL). */
export const NOT_READ_TYPE = 'NOT_READ';

export interface DbColumn {
  readonly name: string;
  readonly type: string;
}

export type OutcomeKind = 'ROWS' | 'UPDATED' | 'PROCEDURE' | 'FAILED' | 'TX_END';

export interface StatementOutcome {
  readonly kind: OutcomeKind;
  readonly columns?: readonly DbColumn[] | null;
  readonly rowsRead?: number | null;
  readonly partial?: boolean | null;
  readonly overLimit?: boolean | null;
  readonly affected?: number | null;
  readonly perSet?: readonly number[] | null;
  readonly generatedKeys?: readonly (readonly TypedValue[])[] | null;
  readonly outParams?: readonly TypedValue[] | null;
  readonly sqlState?: string | null;
  readonly vendorCode?: number | null;
  readonly message?: string | null;
  readonly chain?: readonly string[] | null;
  readonly swallowed?: boolean | null;
  readonly txResult?: string | null;
  readonly heldMicros?: number | null;
}

export type BeforeImageSource = 'EARLIER_READ' | 'AGENT_READ' | 'NONE';

export interface BeforeImage {
  readonly source: BeforeImageSource;
  readonly earlierSeq?: number | null;
  readonly extraReadMicros?: number | null;
  readonly skippedReason?: string | null;
  readonly rowCount?: number | null;
  readonly columns?: readonly DbColumn[] | null;
}

export interface CapturedStatement {
  readonly id: number;
  readonly callId: string | null;
  readonly thread: string;
  /** Order within the call, shared with its supplier calls - exact, clock-independent. */
  readonly seq: number;
  readonly kind: StatementKind;
  /** As the application sent it, placeholders kept. */
  readonly sql: string;
  readonly fingerprint?: string | null;
  readonly table?: string | null;
  /** One list per batch set; a non-batch statement has exactly one. */
  readonly params: readonly (readonly TypedValue[])[];
  readonly outcome: StatementOutcome;
  readonly startedAt: string;
  readonly durationMicros: number;
  readonly offsetMicros: number;
  readonly txId?: string | null;
  readonly connectionId?: string | null;
  readonly codeLocation?: string | null;
  readonly runTag?: string | null;
  readonly dataSource?: string | null;
  readonly beforeImage?: BeforeImage | null;
  readonly cascadesTo?: readonly string[] | null;
  /** Its transaction rolled back - nothing it wrote persisted. */
  readonly undone: boolean;
  /** Marked expected by the user - raises no flag. */
  readonly expected: boolean;
  readonly storedRows: number;
}

export interface StatementTransaction {
  readonly callId: string;
  readonly txId: string;
  readonly connectionId?: string | null;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly outcome: 'COMMITTED' | 'ROLLED_BACK' | 'OPEN';
  readonly heldMicros: number;
  readonly statementCount: number;
  readonly writeCount: number;
}

/** Where a supplier call sits in the call's sequence (the agent's HTTP_OUT marker). */
export interface SupplierMarker {
  readonly seq: number;
  readonly method?: string | null;
  readonly url?: string | null;
  readonly at?: string | null;
}

export interface CallStatementsPage {
  readonly statements: readonly CapturedStatement[];
  readonly transactions: readonly StatementTransaction[];
  readonly supplierMarkers: readonly SupplierMarker[];
  readonly hasMore: boolean;
}

export type RowsPart = 'RESULT' | 'BEFORE_IMAGE';

export interface RowsPage {
  readonly columns: readonly DbColumn[];
  readonly rows: readonly (readonly TypedValue[])[];
  /** Rows stored for this statement. */
  readonly total: number;
  /** Rows the application read (may exceed `total` when over the per-result limit). */
  readonly rowsRead?: number | null;
  readonly partial?: boolean | null;
  readonly overLimit?: boolean | null;
}

export type DbFlagType =
  | 'FAILED_SWALLOWED' | 'FAILED' | 'ROLLED_BACK' | 'NO_WHERE' | 'LARGE_DELETE' | 'REPEATED_QUERY' | 'SLOW'
  | 'HUGE_RESULT' | 'LOCK_DURING_SUPPLIER_CALL' | 'CASCADE' | 'BEFORE_NOT_CAPTURED';

export interface DbFlag {
  readonly type: DbFlagType;
  readonly severity: 'BAD' | 'WARN';
  readonly seqs: readonly number[];
  readonly group?: string | null;
  readonly detail?: Readonly<Record<string, string>> | null;
}

/** What the ◆ DB chip reads. No summary at all means the call was not captured. */
export interface CallDbSummary {
  readonly callId: string;
  readonly statementCount: number;
  readonly writeCount: number;
  readonly deleteCount: number;
  readonly failedCount: number;
  readonly transactionCount: number;
  readonly rolledBackCount: number;
  readonly dbMicros: number;
  readonly droppedCount: number;
  readonly flags: readonly DbFlag[];
  readonly lastSeq: number;
  readonly complete: boolean;
  readonly endedEarly: boolean;
}

export interface DbThresholds {
  readonly slowMs: number;
  readonly hugeRows: number;
  readonly repeatCount: number;
  readonly largeDeleteRows: number;
}

export interface DbCaptureSettings {
  readonly rowsPerResult: number;
  readonly beforeImageTables: readonly string[];
  readonly outsideCallCapture: boolean;
  readonly thresholds: DbThresholds;
  readonly expectedFingerprints: readonly string[];
  readonly ignorePatterns: readonly string[];
}

export interface AgentStatus {
  readonly agentId: string;
  readonly project: string;
  readonly agentVersion?: string | null;
  readonly jvm?: string | null;
  readonly appServer?: string | null;
  readonly droppedSinceStart: number;
  readonly queuedStatements: number;
  readonly lastSeen?: string | null;
}

/** One project's switch and agent - what the Sources bar, the cycle widget and Settings show. */
export interface ProjectCaptureStatus {
  readonly project: string;
  readonly enabled: boolean;
  readonly inboundLogging: boolean;
  readonly attached: boolean;
  readonly agent?: AgentStatus | null;
}

export interface RecordedQueryRequest {
  readonly mode: 'search' | 'sql';
  readonly text: string;
  readonly sortColumn?: string | null;
  readonly sortDir?: 'asc' | 'desc' | null;
  readonly offset: number;
  readonly limit: number;
}

/** A query over recorded data (never the application's database). `error` is the user's query being wrong. */
export interface RecordedQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly total: number;
  /** Present when the statements query selected `n` - the window filters its tree to these. */
  readonly statementSeqs?: readonly number[] | null;
  readonly error?: string | null;
}

export interface TraceHit {
  readonly seq: number;
  readonly where: 'PARAM' | 'ROW' | 'BEFORE_IMAGE' | 'KEY' | 'OUT';
  readonly index: number;
  readonly column?: string | null;
}

export interface TableSummary {
  readonly table: string;
  readonly reads: number;
  readonly inserts: number;
  readonly updates: number;
  readonly deletedRows: number;
  readonly failed: number;
  readonly rowsRead: number;
  readonly micros: number;
}

export type DbCaptureSocketEvent =
  | { readonly type: 'statements-appended'; readonly callId: string; readonly lastSeq: number; readonly summaryChanged: boolean }
  | { readonly type: 'outside-appended'; readonly thread: string; readonly count: number }
  | { readonly type: 'capture-settings-changed'; readonly project: string }
  | { readonly type: 'agent-status-changed'; readonly project: string; readonly attached: boolean };
