/** GET /database/storage - Settings → Storage (backend-app/storage/StorageService.Overview). */

export type StorageShare = 'inbound' | 'capture' | 'outbound' | 'logs' | 'reliveRuns' | 'work';
export type StorageSplit = 'recommended' | 'even' | 'inbound' | 'outbound' | 'custom';
export type CleanupKind = 'inbound' | 'outbound' | 'cycles' | 'reliveRuns';

/** The most disk space Alfred may use; every share is a ratio of {@link bytes}. bytes null = no budget. */
export interface StorageBudget {
  readonly bytes: number | null;
  readonly split: StorageSplit;
  readonly ratios: Partial<Record<StorageShare, number>>;
  /** 0 = no count limit. */
  readonly inboundMaxCalls: number;
  readonly outboundMaxCalls: number;
  /** Newest runs kept per Relive cycle; 0 = all. */
  readonly reliveKeepRuns: number;
  /** "Also delete after N days" per kind; 0 or missing = never. */
  readonly maxAgeDays: Partial<Record<'inbound' | 'outbound' | 'reliveRuns', number>>;
  /** Automatic rules - they apply with or without a budget. */
  readonly rules: StorageRules;
}

export interface StorageRules {
  /** OPTIONS calls removed every 10 minutes. */
  readonly dropPreflights: boolean;
  /** Comma-separated URL parts removed the same way, e.g. "/health,/actuator". */
  readonly healthPaths: string;
  /** Warn under this much free disk; 0 = off. */
  readonly lowDiskWarnGb: number;
  /** Under this much free disk the oldest traffic goes until 5 GB more is free; 0 = off. */
  readonly diskGuardGb: number;
  /** Free a file's empty space at night when more than 20% of it is empty. */
  readonly autoCompact: boolean;
  /** Back up your work and setup at 03:00, the last 7 kept. */
  readonly nightlyBackup: boolean;
  /** Endpoints never recorded again: "inbound GET http://host:9001/app/heartbeat" (URL without query). */
  readonly stopRecording: readonly string[];
  /** The size and count limits skip a call with a comment. */
  readonly keepCommented: boolean;
}

export const DEFAULT_RULES: StorageRules = {
  dropPreflights: false, healthPaths: '', lowDiskWarnGb: 10, diskGuardGb: 2, autoCompact: true, nightlyBackup: false,
  stopRecording: [], keepCommented: true,
};

export interface StorageStore {
  readonly id: string;
  readonly name: string;
  readonly group: 'traffic' | 'capture' | 'work' | 'relive' | 'config';
  readonly share: StorageShare;
  readonly files: string;
  readonly items: number;
  readonly unit: string;
  /** File plus its write log. */
  readonly sizeBytes: number;
  /** Empty pages inside the file - given back by "Free space", nothing deleted. */
  readonly freeBytes: number;
  readonly walBytes: number;
  readonly oldest: string | null;
  readonly limitBytes: number | null;
  readonly limitCalls: number | null;
  readonly cleanable: boolean;
}

export interface StorageRun {
  readonly id: string;
  readonly status: string;
  readonly startedAt: string | null;
  /** Never deleted by a rule or a clean-up. */
  readonly starred: boolean;
}

export interface StorageReliveCycle {
  readonly id: string;
  readonly name: string;
  readonly steps: number;
  readonly lastRun: string | null;
  /** Newest first. */
  readonly runs: readonly StorageRun[];
}

export interface StorageHistoryEntry {
  readonly at: string;
  readonly who: 'auto' | 'you';
  readonly what: string;
  /** -1 = not measured. */
  readonly bytes: number;
}

export interface StorageOverview {
  readonly usedBytes: number;
  readonly freeInsideBytes: number;
  readonly disk: { readonly path: string; readonly freeBytes: number; readonly totalBytes: number };
  readonly budget: StorageBudget;
  readonly shareBytes: Record<StorageShare, number>;
  readonly shareUsed: Record<StorageShare, number>;
  readonly maxBudgetBytes: number;
  readonly stores: readonly StorageStore[];
  readonly relive: readonly StorageReliveCycle[];
  readonly history: readonly StorageHistoryEntry[];
  readonly lowDisk: boolean;
}

export interface DiskState {
  readonly freeBytes: number;
  readonly totalBytes: number;
  readonly lowDisk: boolean;
  readonly warnGb: number;
}

export interface InsightGroup {
  readonly direction: 'inbound' | 'outbound';
  readonly method: string | null;
  readonly path: string | null;
  readonly project: string | null;
  readonly calls: number;
  readonly bytes: number;
  readonly note: string | null;
  readonly ids: readonly string[];
}

export interface InsightCall {
  readonly direction: 'inbound' | 'outbound';
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly project: string | null;
  readonly bytes: number;
  readonly at: string | null;
}

export interface InsightDay {
  readonly day: string;
  readonly inboundBytes: number;
  readonly outboundBytes: number;
  readonly inboundCalls: number;
  readonly outboundCalls: number;
}

export interface StorageInsights {
  readonly endpoints: readonly InsightGroup[];
  readonly largest: readonly InsightCall[];
  readonly projects: readonly InsightGroup[];
  readonly repeats: readonly InsightGroup[];
  readonly repeatBytes: number;
  readonly repeatCalls: number;
  readonly days: readonly InsightDay[];
  readonly perDayBytes: number;
}

export interface FileHealth {
  readonly name: string;
  readonly fileBytes: number;
  readonly walBytes: number;
  readonly freeBytes: number;
  readonly check: string | null;
}

export interface StorageBackup {
  readonly name: string;
  readonly bytes: number;
  readonly at: string;
  readonly files: readonly string[];
  readonly nightly: boolean;
}

export interface StorageBackups {
  readonly dataDir: string;
  readonly backups: readonly StorageBackup[];
  readonly pending: { readonly files: readonly string[]; readonly from: string } | null;
}

export interface CleanupRequest {
  readonly kind: CleanupKind;
  readonly olderThanDays: number | null;
  readonly project: string | null;
  readonly status: '' | '2xx' | '4xx' | '5xx' | 'options';
  readonly urlContains: string | null;
  readonly keepCommented: boolean;
  readonly compactAfter: boolean;
}

export interface CleanupResult {
  readonly kind: CleanupKind;
  readonly count: number;
  readonly bytes: number;
  readonly kept: number;
  readonly sample: readonly { id: string; method: string | null; url: string | null; status: number | null; at: string | null }[];
  readonly applied: boolean;
  /** The matching calls (inbound/outbound), for "Export these first". */
  readonly ids?: readonly string[];
}
