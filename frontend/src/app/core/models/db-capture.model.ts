import { LogLevelSetting } from './call-logs.model';
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
  /** First statement on a freshly checked-out connection: how long getConnection took. */
  readonly acquireMicros?: number | null;
  /** TX_END: JDBC (Connection.commit/rollback) or JTA (the container's transaction), and what ending it cost. */
  readonly via?: 'JDBC' | 'JTA' | null;
  readonly beginMicros?: number | null;
  readonly commitMicros?: number | null;
  readonly closeMicros?: number | null;
}

/** One index of a table, from database metadata (the agent's opt-in Index check). */
export interface TableIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
}

/** A transaction's cost beyond its statements, and how it ended. Microseconds. */
export interface TxLifecycle {
  readonly via?: 'JDBC' | 'JTA' | null;
  readonly acquireMicros?: number | null;
  readonly beginMicros?: number | null;
  readonly commitMicros?: number | null;
  readonly closeMicros?: number | null;
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

/** One kind of origin - what in the application made a statement (when an ORM did). */
export type OriginKind = 'HQL' | 'NATIVE' | 'CRITERIA' | 'LAZY_LOAD' | 'LOAD' | 'FLUSH' | 'HIBERNATE';

/**
 * Where a statement came from when Hibernate made it: the query the code wrote (HQL/JPQL, native SQL, Criteria) with
 * its parameters, name and paging, or the event that made SQL on its own. Absent for plain JDBC. Statements of one
 * query execution share `id`; an event that ran inside a query names it in `parentId`.
 */
export interface StatementOrigin {
  readonly id: string;
  readonly kind: OriginKind;
  /** The query as the code wrote it (null for events). */
  readonly text?: string | null;
  /** A named query's name. */
  readonly name?: string | null;
  /** The method the code called: list, getResultList, executeUpdate ... */
  readonly method?: string | null;
  readonly params?: readonly { readonly name: string; readonly value?: string | null }[] | null;
  readonly firstResult?: number | null;
  readonly maxResults?: number | null;
  readonly entity?: string | null;
  readonly entityId?: string | null;
  readonly role?: string | null;
  /** FLUSH: INSERT, UPDATE, DELETE or COLLECTION. */
  readonly action?: string | null;
  /** A flushed UPDATE: the properties that changed. */
  readonly changed?: readonly string[] | null;
  readonly parentId?: string | null;
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
  /** The application frames that issued it, innermost first, past the project's pass-through classes (db-agent). */
  readonly callers?: readonly string[] | null;
  /** Its table's indexes - on the first statement of each table in a call, when the project's Index check is on. */
  readonly indexes?: readonly TableIndex[] | null;
  readonly runTag?: string | null;
  readonly dataSource?: string | null;
  readonly beforeImage?: BeforeImage | null;
  readonly cascadesTo?: readonly string[] | null;
  /** Its transaction rolled back - nothing it wrote persisted. */
  readonly undone: boolean;
  /** Marked expected by the user - raises no flag. */
  readonly expected: boolean;
  readonly storedRows: number;
  /** The ORM query or event that made it; absent for plain JDBC. */
  readonly origin?: StatementOrigin | null;
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
  readonly lifecycle?: TxLifecycle | null;
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

/** A statement as a .json export carries it: the record plus every stored row (nothing cut). */
export interface ExportedDbStatement extends CapturedStatement {
  readonly rows?: readonly (readonly TypedValue[])[] | null;
  readonly beforeImageRows?: readonly (readonly TypedValue[])[] | null;
}

/** A call's whole database capture - `dbCapture` on its export event (contracts/export-format.md). */
// ---- derived per call (shared/utils/db-analysis.ts): where the time went, and which queries cost it

export interface TimeGap {
  readonly ms: number;
  /** The statement or supplier call just before the gap (null: the gap opens the call) and just after it. */
  readonly afterSeq: number | null;
  readonly beforeSeq: number | null;
  /** Where in code the statement after the gap ran from - what the application was doing next. */
  readonly callers?: readonly string[];
}

export interface TimeBreakdown {
  readonly totalMs: number;
  /** Time a statement was running and no supplier call was. */
  readonly dbMs: number;
  /** Time a supplier (outbound) call was running. */
  readonly outboundMs: number;
  /** Between the first and the last statement/supplier call, with neither running. */
  readonly gapMs: number;
  /** Before the first and after the last of them (request parsing, response writing). */
  readonly edgeMs: number;
  readonly gaps: { readonly count: number; readonly medianMs: number; readonly maxMs: number };
  readonly topGaps: readonly TimeGap[];
  /** The call's database round trip (RoundTrip.java's formula) - 0 when there are too few statements to tell. */
  readonly baselineMs: number;
  readonly statements: number;
  readonly transactions: number;
  /** Most of the call is neither DB nor supplier calls - the time is in the application (or unseen overhead). */
  readonly appTimeDominant: boolean;
  /**
   * Connection checkouts, begins, commits and hand-backs the agent timed (inside the gaps - the statements do not
   * include them): the per-transaction overhead that a remote database multiplies.
   */
  readonly overheadMs: number;
  readonly checkouts: number;
}

export interface QueryTotal {
  readonly fingerprint: string;
  readonly sql: string;
  readonly table: string | null;
  readonly kind: string;
  readonly count: number;
  readonly distinctParams: number;
  /** Executions beyond the first of each parameter set - each one could have come from a cache. */
  readonly duplicates: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly rows: number;
  readonly failed: number;
  /** The distinct places in code it ran from, most frequent first. */
  readonly callers: readonly string[];
  readonly seqs: readonly number[];
  /** The HQL/native query it came from, when every execution came from the same one (text and kind only). */
  readonly hql?: string;
  readonly origin?: string;
}

export interface CallDbAnalysis {
  readonly time: TimeBreakdown;
  readonly queries: readonly QueryTotal[];
  /** The window's summary line: "20.0 s · 51% inside the app - 2 idle stretches, the longest 2.5 s before #28". */
  readonly summary?: string;
  /** The window's findings (db-findings.ts), worst first - errors, then warnings by what they cost, then notes. */
  readonly findings?: readonly DbFindingSummary[];
}

/** A finding as exports carry it: everything the window shows except its chips (`seqs` names the statements). */
export interface DbFindingSummary {
  readonly severity: 'bad' | 'warn' | 'note';
  readonly title: string;
  readonly short: string;
  readonly why: string;
  readonly fix?: string;
  readonly impactMs: number | null;
  readonly impact: string;
  readonly count: string;
  readonly seqs: readonly number[];
  readonly source: string;
}

export interface CallDbCapture {
  readonly summary?: CallDbSummary | null;
  /** The call's Redis commands, whole (specs/011-redis-capture FR-030) - travel with the export and come back on import. */
  readonly redis?: readonly import('./store-command.model').ExportedStoreCommand[] | null;
  readonly redisSummary?: import('./store-command.model').CallStoreSummary | null;
  readonly transactions: readonly StatementTransaction[];
  readonly supplierMarkers?: readonly SupplierMarker[] | null;
  readonly statements: readonly ExportedDbStatement[];
  /**
   * How the .md/.html Database section lays the statements out - grouped by transaction (default) or one plain list.
   * Presentation only, set by the export dialog; never written into the .json (bulk-json-builder drops it).
   */
  readonly layout?: 'grouped' | 'flat';
  /**
   * 'summary': the .md/.html Database section shows the headline, findings, time and top queries but not each
   * statement - for a report meant for people, where an N+1 call would otherwise add megabytes of SQL. Said so in
   * the section itself, like rows: sample. Presentation only: never written into the .json, which is always whole.
   */
  readonly detail?: 'full' | 'summary';
  /**
   * Where the call's time went and its per-query totals - derived (db-analysis.ts), attached by the export dialog
   * (which also has the supplier calls). Written into every export; never read back on import (recomputed instead).
   */
  readonly analysis?: CallDbAnalysis;
}

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
  | 'HUGE_RESULT' | 'LOCK_DURING_SUPPLIER_CALL' | 'CASCADE' | 'BEFORE_NOT_CAPTURED' | 'DUPLICATE' | 'TX_PER_STATEMENT'
  | 'QUERY_FAN_OUT';

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
  /** Classes/packages the call chain skips (a generic DAO every query goes through). */
  readonly passThroughClasses?: readonly string[];
  /** Application frames recorded per statement (1-10, default 3). */
  readonly callerFrames?: number;
  /** Read a slow statement's table's index list once (metadata only, never a query of the data). */
  readonly indexInfo?: boolean;
  /** The lowest level of log line the agent catches with each call - ERROR unless set (specs/009). */
  readonly logLevel?: LogLevelSetting;
  /** Redis capture settings (specs/011-redis-capture) - nothing here limits what is stored. */
  readonly redis?: import('./store-command.model').RedisSettings;
  /**
   * Native install: how the supervisor loads the agent into the project's app by itself. WHEN_ASKED (the default):
   * at Alfred's start, when a call arrives and no agent reports, on "Attach now". AUTOMATIC: also the moment the
   * app's port opens or its pid changes. OFF: never by itself.
   */
  readonly attachMode?: AttachMode;
  /** ...and routes the app's outbound calls through Alfred's forward proxy while doing so. */
  readonly attachProxy?: boolean;
}

export type AttachMode = 'OFF' | 'WHEN_ASKED' | 'AUTOMATIC';

/** The list shows the full account; the closed picker shows the mode's name alone (`buttonLabel`), so it fits the ◆ popover. */
export const ATTACH_MODE_CHOICES: readonly { readonly value: AttachMode; readonly label: string; readonly buttonLabel: string }[] = [
  { value: 'WHEN_ASKED', buttonLabel: 'When asked', label: 'When asked - at start, when calls arrive and no agent reports, or on Attach now' },
  { value: 'AUTOMATIC', buttonLabel: 'Automatic', label: 'Automatic - the moment the app starts or restarts, before its first call' },
  { value: 'OFF', buttonLabel: 'Off', label: 'Off - never by itself (alfred attach still works)' },
];

export function attachModeWords(mode: AttachMode | undefined): string {
  return ATTACH_MODE_CHOICES.find(c => c.value === (mode ?? 'WHEN_ASKED'))?.buttonLabel ?? 'When asked';
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
  /** The features the agent runs ("proxy,db,logs,redis" order, "" for none); absent from an agent too old to say. */
  readonly features?: string | null;
}

/**
 * The switches on for a project that the attached agent in its JVM does NOT run - e.g. ◆ on here while the agent was
 * loaded by a `start.py` proxy-on step alone (`features=proxy`). Empty when nothing is missing, the agent is not
 * attached, or it did not say what it runs.
 */
export function agentLacks(p: ProjectCaptureStatus | null | undefined): readonly string[] {
  const features = p?.agent?.features;
  if (!p?.attached || features == null) return [];
  const has = new Set(features.split(',').map((f) => f.trim()).filter(Boolean));
  const missing: string[] = [];
  if (p.enabled && !has.has('db')) missing.push('◆ database');
  if (p.logsOn && !has.has('logs')) missing.push('▤ log');
  if (p.redisOn && !has.has('redis')) missing.push('⬢ Redis');
  return missing;
}

/** One project's switch and agent - what the Sources bar, the cycle widget and Settings show. */
export interface ProjectCaptureStatus {
  readonly project: string;
  readonly enabled: boolean;
  readonly inboundLogging: boolean;
  readonly attached: boolean;
  readonly agent?: AgentStatus | null;
  /** The project's ▤ Logs switch (specs/008-logs-call-link): while on, its calls are linked to its log lines. */
  readonly logsOn?: boolean;
  /** The lowest level of line the agent catches for it (Settings → Database capture). */
  readonly logLevel?: LogLevelSetting;
  /** The project's ⬢ Redis switch (specs/011-redis-capture). */
  readonly redisOn?: boolean;
  /** Redis clients the agent saw (Settings → Clients found). */
  readonly redisClients?: readonly import('./store-command.model').RedisClientSeen[];
  /** Spring Cache names the agent saw. */
  readonly springCaches?: readonly string[];
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
  /** REDIS_*: a Redis command's key, argument, reply or value before the write (specs/011-redis-capture); `column` the key or JSON path. */
  readonly where: 'PARAM' | 'ROW' | 'BEFORE_IMAGE' | 'KEY' | 'OUT' | 'REDIS_KEY' | 'REDIS_ARG' | 'REDIS_REPLY' | 'REDIS_BEFORE';
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
  | { readonly type: 'agent-status-changed'; readonly project: string; readonly attached: boolean }
  /** Caught log lines arrived for a call (callId null: outside any call) - specs/009-agent-log-capture. */
  | { readonly type: 'logs-appended'; readonly callId: string | null; readonly project: string | null }
  /** Redis commands of these calls were stored or their summary changed (specs/011-redis-capture). */
  | { readonly type: 'store-commands'; readonly callIds: readonly string[] };

/** A log line the agent caught outside any call (GET /db-capture/outside/logs). */
export interface OutsideLogLine {
  readonly id: number;
  readonly at: string;
  readonly level: string | null;
  readonly logger: string | null;
  readonly thread: string | null;
  readonly message: string | null;
  readonly exceptionType?: string | null;
  readonly exceptionMessage?: string | null;
  readonly exceptionStack?: string | null;
  readonly cut?: boolean;
}
