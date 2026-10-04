/** Logs Explorer wire types - mirror backend-logs' domain records (specs/004-logs-explorer/data-model.md). */

export type RawMode = 'COPY' | 'OFFSET';
export type PrivacyMode = 'SHOW' | 'MASK' | 'REDACT_AT_LOAD';
export type FieldType = 'DATE' | 'DATETIME' | 'NUMBER' | 'STRING' | 'BOOLEAN';
export type SearchMode = 'EXACT' | 'TEXT' | 'NONE';
export type Role =
  | 'TIME' | 'LEVEL' | 'CORRELATION' | 'MESSAGE' | 'SERVICE' | 'DURATION' | 'STATUS' | 'REQUEST_BODY' | 'RESPONSE_BODY' | 'ERROR';
export type GroupSort = 'TIME_ASC' | 'TIME_DESC' | 'ERRORS_DESC' | 'LINES_DESC' | 'MAX_DURATION_DESC' | 'ID_ASC';
export type DataView = 'TABLE' | 'JSON';
export type InputKind = 'UPLOAD' | 'SERVER_FILE' | 'FOLLOW' | 'PUSH' | 'OPENSEARCH' | 'WATCH' | 'WATCHED_FILE';
export type InputStatus = 'QUEUED' | 'UPLOADING' | 'LOADING' | 'DONE' | 'FOLLOWING' | 'WAITING' | 'PAUSED' | 'FAILED';

export interface FieldDef {
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly type: FieldType;
  readonly typeSource: 'AUTO' | 'USER';
  readonly format: string;
  readonly matchRate: number;
  readonly invalidCount: number;
  readonly suggestBoolean: boolean;
  readonly searchMode: SearchMode;
  readonly role: Role | null;
  readonly sensitive: boolean;
  readonly duplicateOf: string | null;
  readonly firstSeenLine: number;
  readonly sample: string | null;
  /** Order among the fields sharing a role (1 = tried first); each line uses the first one it has. 0 = no role. */
  readonly roleRank: number;
}

export interface GroupLevel {
  readonly fieldLabel: string;
  readonly sort: GroupSort;
}

export interface LogStructure {
  readonly id: string;
  readonly fields: readonly FieldDef[];
  readonly groupLevels: readonly GroupLevel[];
  readonly template: string;
  readonly columns: readonly string[];
  readonly defaultDataView: DataView;
  readonly timeZone: string;
  /** Fields past the searchable-field limit: only in the raw line and the JSON view. */
  readonly overflowPaths?: readonly string[];
  /** Parts of a line kept as ONE text field (their JSON): big or id-keyed payloads such as request/response bodies. */
  readonly payloadPaths?: readonly string[];
  /** How a line's Table view starts: grouped by dotted path or one flat list (each line can switch). */
  readonly defaultFieldLayout?: 'GROUPED' | 'FLAT';
}

export interface LogSource {
  readonly id: string;
  readonly name: string;
  readonly rawMode: RawMode;
  readonly privacyMode: PrivacyMode;
  /** 0 = keep every line (default). There is no age-based retention. */
  readonly retentionMaxBytes: number;
  readonly lineCount: number;
  readonly storedBytes: number;
  readonly unparsedCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LogInput {
  readonly id: string;
  readonly sourceId: string;
  readonly kind: InputKind;
  readonly path: string | null;
  readonly fileName: string | null;
  readonly fingerprint: string | null;
  readonly status: InputStatus;
  readonly statusReason: string | null;
  readonly position: number;
  readonly linesRead: number;
  readonly totalBytes: number;
  readonly mismatchCount: number;
  readonly unparsedCount: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  /** A WATCHED_FILE's folder input (WATCH). */
  readonly parentId?: string | null;
  /** WATCH: its WatchOptions as JSON; WATCHED_FILE: "archive" for a rotated copy read once. */
  readonly options?: string | null;
}

/** A folder of settings.properties logs_watch_dirs, mounted at /watch/<name>. */
export interface WatchFolder {
  readonly name: string;
  readonly hostPath: string;
  /** False when configured but not mounted yet (restart needed). */
  readonly available: boolean;
}

export interface WatchFolders {
  readonly folders: readonly WatchFolder[];
  /** events = notified by the kernel; agent = the host log agent reports changes (Docker Desktop). */
  readonly mode: 'events' | 'agent' | 'off';
  /** When the host agent last reported in (epoch ms); 0 = not since the backend started. */
  readonly agentSeenAt: number;
}

export interface WatchedFile {
  readonly path: string;
  readonly relative: string;
  readonly size: number;
  readonly modified: number;
  /** A rotated copy (detail.log.1): read once for the starting window, never followed. */
  readonly archive: boolean;
}

export type WatchStart = 'ALL' | 'LAST' | 'NEW';

export interface WatchOptions {
  readonly folder: string;
  readonly pattern: string;
  readonly subfolders: boolean;
  readonly start: WatchStart;
  readonly lastLines: number;
  /** N counted per file (true) or across all files, newest first (false). */
  readonly perFile: boolean;
}

export interface SessionMarker {
  readonly ts: number;
  readonly text: string;
}

/** A recorded stretch of a live log: a time window (+ optional filter) or one value of one ID field. */
export interface LogSession {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly notes: string;
  readonly kind: 'WINDOW' | 'ID';
  readonly pills: readonly Pill[];
  readonly idField: string | null;
  readonly idValue: string | null;
  readonly startedAt: number;
  /** null while recording. */
  readonly endedAt: number | null;
  readonly markers: readonly SessionMarker[];
  readonly lineCount: number;
  readonly errorCount: number;
  readonly createdAt: string;
}

export interface SessionView {
  readonly session: LogSession;
  /** The explorer filter that shows exactly this session's lines. */
  readonly pills: readonly Pill[];
}

export interface SourceView {
  readonly source: LogSource;
  readonly inputs: readonly LogInput[];
  readonly structureId: string | null;
}

export interface StructurePreview {
  readonly structure: LogStructure;
  readonly sampledLines: number;
  /** Different line structures in the sample - they all load into one source. */
  readonly structures: number;
  readonly matchingSourceId: string | null;
  readonly matchingSourceName: string | null;
}

export type FieldValue = string | number | boolean | null;

export interface LogLineSummary {
  readonly lineId: string;
  readonly ts: number;
  readonly level: string | null;
  readonly groupLevel: number;
  readonly groupPath: string;
  readonly missingLevel: string | null;
  readonly pinned: boolean;
  readonly unparsed: boolean;
  /** The structure this line belongs to (LineStructure.id); 0 for an unparsed line. */
  readonly shape: number;
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly commentCount: number;
}

export interface LogLine extends Omit<LogLineSummary, 'commentCount'> {
  readonly inputId: string;
  readonly byteOffset: number;
  readonly raw: string | null;
  readonly rawUnavailable: string | null;
}

export interface LogPage {
  readonly lines: readonly LogLineSummary[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly tookMs: number;
  readonly slow: boolean;
}

export type PillOp = 'EQ' | 'NEQ' | 'GT' | 'LT' | 'BETWEEN' | 'EXISTS' | 'NOT_EXISTS' | 'TEXT' | 'SELECTION' | 'PATTERN' | 'INGESTED';

export interface Pill {
  readonly op: PillOp;
  readonly field?: string | null;
  readonly value?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly lineIds?: readonly string[] | null;
}

export interface LogQuery {
  readonly pills: readonly Pill[];
  readonly from?: number | null;
  readonly to?: number | null;
  readonly sort?: { readonly field: string | null; readonly ascending: boolean } | null;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface Histogram {
  readonly from: number;
  readonly to: number;
  readonly bucketMs: number;
  readonly buckets: readonly { readonly from: number; readonly byLevel: Readonly<Record<string, number>> }[];
}

export interface ValueCount {
  readonly value: string;
  readonly count: number;
}

export interface FieldValues {
  readonly window: number;
  readonly sampled: number;
  readonly fields: Readonly<Record<string, { readonly presence: number; readonly top: readonly ValueCount[] }>>;
}

export interface FieldStats {
  readonly label: string;
  readonly type: FieldType;
  readonly values: number;
  readonly exact: boolean;
  readonly window: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly distribution: readonly number[];
  readonly distinct: number | null;
  readonly top: readonly ValueCount[];
}

export interface Minimap {
  readonly total: number;
  readonly sampled: boolean;
  readonly matches: readonly number[];
  readonly errors: readonly number[];
  readonly warns: readonly number[];
}

export interface GroupNode {
  readonly path: string;
  readonly level: number;
  readonly id: string;
  readonly headLine: LogLineSummary | null;
  readonly siblings: readonly LogLineSummary[];
  readonly skipped: readonly LogLineSummary[];
  readonly childCount: number;
  readonly descendantCount: number;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly errorCount: number;
  readonly maxDuration: number;
}

export interface Pattern {
  readonly id: number;
  readonly template: string;
  readonly count: number;
  readonly worstLevel: string;
}

/** One structure found among a source's lines (lines whose fields are mostly the same). */
export interface LineStructure {
  readonly id: number;
  /** "S2" - what the structure: filter takes. */
  readonly code: string;
  readonly name: string;
  /** True when the user named it; otherwise named after its most telling field. */
  readonly named: boolean;
  /** Summary template for these lines; "" = the source's template. */
  readonly template: string;
  readonly lineCount: number;
  /** Lines of this structure among the current results (explorer only). */
  readonly matching: number | null;
  readonly fields: readonly string[];
}

export interface LineStructures {
  readonly structures: readonly LineStructure[];
  readonly totalLines: number;
  /** Field label -> share of all lines that have it. */
  readonly presence: Readonly<Record<string, number>>;
  /** Lines from before structures existed are still being sorted. */
  readonly pending: boolean;
}

/** Pseudo-field of the structure: filter (structure:S2). */
export const STRUCTURE_FIELD = 'structure';

export interface LogComment {
  readonly id: string;
  readonly sourceId: string;
  readonly lineId: string;
  /** Field path, or "" for the whole line (FR-042). */
  readonly path: string;
  readonly text: string;
  readonly authorProfileId: string | null;
  readonly createdAt: string;
}

export interface SavedView {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly state: SavedViewState;
  readonly createdAt: string;
}

export interface SavedViewState {
  readonly pills: readonly Pill[];
  readonly range?: string;
  readonly view?: ExplorerView;
  readonly columns?: readonly string[];
  readonly sort?: { readonly field: string | null; readonly ascending: boolean } | null;
  /** A zoomed time range (histogram drag); overrides `range`. */
  readonly customRange?: { readonly from: number; readonly to: number } | null;
}

export type ExplorerView = 'lines' | 'grouped' | 'patterns';

export interface ServerFile {
  readonly path: string;
  readonly name: string;
  readonly directory: boolean;
  readonly size: number;
}

export interface UploadTicket {
  readonly uploadId: string;
  readonly chunkSize: number;
  readonly receivedChunks: readonly number[];
}

export interface DeleteImpact {
  readonly lines: number;
  readonly comments: number;
  readonly pinned: number;
}

export type LogsSocketEvent =
  | { readonly type: 'lines-added'; readonly sourceId: string; readonly count: number; readonly newestTs: number }
  | {
      readonly type: 'input-progress';
      readonly sourceId: string;
      readonly inputId: string;
      readonly status: InputStatus;
      readonly reason: string | null;
      readonly lines: number;
      readonly bytes: number;
      readonly totalBytes: number;
      readonly unparsed: number;
      readonly mismatch: number;
      readonly newField: string | null;
    }
  | { readonly type: 'structure-changed'; readonly sourceId: string; readonly rebuilding: string | null }
  | { readonly type: 'sources-changed' }
  | { readonly type: 'comment-changed'; readonly sourceId: string; readonly lineId: string | null }
  | { readonly type: 'sessions-changed'; readonly sourceId: string };
