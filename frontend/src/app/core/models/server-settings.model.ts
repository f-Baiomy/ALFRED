/** Wire shapes of /server/** (specs/012-server-program contracts/server-api.md). */

export type SettingGroup = 'PROJECTS' | 'NETWORK' | 'STORAGE' | 'LOGS' | 'WILDFLY' | 'UPDATES' | 'SECRETS';
export type SettingKind =
  | 'BOOLEAN' | 'INTEGER' | 'SIZE_BYTES' | 'MEMORY' | 'PORT' | 'HOST_PORT' | 'PATH' | 'ENUM'
  | 'PROJECT_LIST' | 'FOLDER_LIST' | 'ACCESS_LIST' | 'SECRET' | 'URL' | 'TIME_WINDOW';
export type ApplyMode = 'LIVE' | 'PROXIES' | 'RESTART';
export type SettingSource = 'ENV_FILE' | 'DEFAULT' | 'PROCESS_ENV';

export interface PendingRestart {
  key: string;
  before: string;
  after: string;
  savedAt: string;
}

export interface ServerSetting {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  label: string;
  help: string;
  applies: ApplyMode;
  enumValues: string[];
  min: number | null;
  max: number | null;
  /** Null for a secret (only {@link isSet} is known) and, in Docker mode, for a setting Docker does not use. */
  value: string | null;
  isSet: boolean;
  defaultValue: string | null;
  source: SettingSource;
  differsFromDefault: boolean;
  pending: PendingRestart | null;
}

export interface EnvProblem {
  line: number;
  text: string;
  reason: string;
}

export interface ServerSettingsResponse {
  mode: 'NATIVE' | 'DOCKER';
  envLocation: string;
  envHash: string;
  settings: ServerSetting[];
  missingFromEnv: string[];
  unknownLines: EnvProblem[];
  pendingRestart: PendingRestart[];
}

export type AccessReason = 'LOCAL' | 'LAN' | 'LISTED' | 'TUNNEL' | 'NOT_LISTED' | 'DOCKER_MODE';

export interface EditAccess {
  allowed: boolean;
  reason: AccessReason;
  clientAddress: string;
  howToEdit: string;
}

export interface SettingEdit {
  key: string;
  value?: string;
  reset?: boolean;
}

export interface ValidationResult {
  key: string;
  level: 'OK' | 'WARNING' | 'ERROR';
  message: string;
  detail: Record<string, unknown>;
}

export interface SettingsPreview {
  diff: { key: string; before: string | null; after: string | null }[];
  effects: { key: string; applies: ApplyMode }[];
  results: ValidationResult[];
}

export type SaveOutcome = 'APPLIED' | 'PROXIES_RESTARTED' | 'PENDING_RESTART' | 'SAVED';

export interface SettingsSaved {
  envHash: string;
  applied: { key: string; applies: ApplyMode; outcome: SaveOutcome; tookMs: number; detail: string }[];
  historyId: number;
}

/** 409 body: .env changed after it was loaded. */
export interface SettingsConflict {
  message: string;
  conflict: { changedKeys: string[]; currentHash: string };
}

export interface ProjectRow {
  name: string;
  listenPort: string;
  upstreamPort: string;
  /** "host" or "host:port"; empty = no outbound attribution. */
  outbound: string;
}

export interface FolderRow {
  name: string;
  path: string;
}

export type ProcessState = 'RUNNING' | 'STOPPED' | 'RESTARTING' | 'CRASHED' | 'UNKNOWN';

export interface ProcessStatus {
  name: 'BACKEND' | 'OUTBOUND' | 'REVERSE' | 'MCP' | 'LOG_AGENT' | string;
  state: ProcessState;
  pid: number;
  startedAt: string | null;
  restarts: number;
  listeners: string[];
  detail: string;
  callsLastHour: number;
}

export type AgentAttachState = 'ATTACHED' | 'ATTACHING' | 'NO_JVM' | 'NOT_A_JVM' | 'FAILED' | 'NO_PROJECT' | 'UNKNOWN';

/** The supervisor's last attach attempt for a project: the JVM on its upstream port and what came of it. */
export interface AgentAttach {
  project: string;
  port: number;
  pid: number;
  state: AgentAttachState;
  detail: string;
  at: string | null;
  features: string;
}

export interface ServerStatus {
  version: string;
  installDir: string;
  mode: 'NATIVE' | 'DOCKER';
  startedAt: string;
  backendPid: number;
  heapUsedBytes: number;
  heapMaxBytes: number;
  processes: ProcessStatus[];
  /** Agents the supervisor attached by itself - empty in Docker mode. */
  agents?: AgentAttach[];
}

export type UpdateMode = 'OFF' | 'CHECK' | 'AUTO';
export type UpdateJobState = 'IDLE' | 'DOWNLOADING' | 'VERIFYING' | 'INSTALLING' | 'FAILED';

/** The supervisor's account of an install it was asked for (GET /server/update → job). */
export interface UpdateJob {
  state: UpdateJobState;
  version: string;
  downloadedBytes: number;
  totalBytes: number;
  error: string;
}

/** GET /server/update: the last check's result and the install in progress, if any. */
export interface UpdateStatus {
  mode: UpdateMode;
  runtimeMode: 'NATIVE' | 'DOCKER';
  target: string;
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  checkedAt: string | null;
  feedUrl: string;
  notes: string;
  publishedAt: string;
  installerUrl: string;
  sizeBytes: number;
  window: string;
  canInstall: boolean;
  job: UpdateJob;
  /** The last check's failure, or "". */
  error: string;
}

/** One value of an uploaded .env, checked as the editor would check it (POST /server/settings/import). */
export interface ImportedValue {
  key: string;
  value: string;
  current: string;
  valid: boolean;
  message: string;
}

export interface EnvImport {
  values: ImportedValue[];
  /** Keys that are not settings. */
  unknown: string[];
  /** Secret keys: never imported. */
  secrets: string[];
}

export interface HistoryEntry {
  id: number;
  at: string;
  source: 'UI' | 'CLI' | 'HAND_EDIT' | 'INSTALL' | 'UPGRADE' | 'IMPORT' | 'REVERT';
  sourceDetail: string | null;
  changes: { key: string; before: string | null; after: string | null }[];
  snapshotFile: string;
}
