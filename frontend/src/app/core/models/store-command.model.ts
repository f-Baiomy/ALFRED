/**
 * Redis commands of a call (specs/011-redis-capture, contracts/store-commands-api.md) - "store commands": Redis is the
 * first store; the shape is the backend's StoreCommandSummary / StoreCommand / DecodedValue / KeyPatternRow.
 */

export type StoreRw = 'r' | 'w' | 'o';
export type StoreOutcome = 'HIT' | 'MISS' | 'OK' | 'FAILED';

export interface StoreOrigin {
  readonly store?: string | null;
  readonly cache?: string | null;
  /** '@Cacheable', 'cache put', 'evict', 'clear'. */
  readonly operation?: string | null;
  readonly method?: string | null;
}

export interface StoreGroup {
  readonly kind: 'tx' | 'pipeline';
  readonly id: string;
  readonly index: number;
  readonly size: number;
}

/** One row of the Redis view - no bytes. */
export interface StoreCommandSummary {
  readonly id: number;
  readonly store: string;
  readonly seq: number;
  readonly at: string;
  readonly micros: number;
  readonly command: string;
  readonly keys: readonly string[];
  readonly keysTotal: number;
  readonly keyPattern?: string | null;
  readonly rw: StoreRw;
  readonly outcome: StoreOutcome;
  readonly replyType: string;
  readonly replyPreview?: string | null;
  readonly argsText?: string | null;
  readonly error?: string | null;
  readonly origin?: StoreOrigin | null;
  readonly group?: StoreGroup | null;
  readonly code?: string | null;
  readonly client?: string | null;
  readonly connection?: string | null;
  readonly poolWaitMicros?: number | null;
  readonly bytes: number;
  readonly replyBytes: number;
  readonly hasBefore: boolean;
  readonly beforeNote?: string | null;
  readonly runTag?: string | null;
}

/** A value as a person reads it - decoded in ALFRED, never in the application. */
export interface DecodedValue {
  readonly format?: string | null;
  readonly className?: string | null;
  readonly text?: string | null;
  readonly partial: boolean;
  readonly masked: boolean;
  readonly bytes: number;
  readonly rawBase64?: string | null;
}

export interface KeyWriter {
  readonly callId?: string | null;
  readonly seq?: number | null;
  readonly command?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly status?: number | null;
  readonly agoMillis?: number | null;
  readonly sameValue?: boolean | null;
  readonly none?: string | null;
}

/** One command opened in the window. */
export interface StoreCommand {
  readonly row: StoreCommandSummary;
  readonly args: readonly string[];
  readonly reply?: DecodedValue | null;
  readonly before?: DecodedValue | null;
  readonly value?: DecodedValue | null;
  readonly writtenBy?: KeyWriter | null;
  readonly server?: string | null;
  readonly db?: number | null;
  readonly thread?: string | null;
  readonly callers?: readonly string[] | null;
  readonly fingerprint?: string | null;
  readonly resp: number;
  readonly argsRawBase64?: string | null;
}

/** The ⬢ chip / failures pill / health: one call at a glance. No summary = ⬢ was off for the call. */
export interface CallStoreSummary {
  readonly callId: string;
  readonly project?: string | null;
  readonly commands: number;
  readonly reads: number;
  readonly writes: number;
  readonly hits: number;
  readonly misses: number;
  readonly failed: number;
  readonly micros: number;
  readonly dropped: number;
  readonly live: boolean;
  readonly endedEarly: boolean;
}

export interface StoreCommandsPage {
  readonly total: number;
  readonly commands: readonly StoreCommandSummary[];
  /** Seqs of misses on keys a recorded call wrote earlier whose TTL had run out ("cache cold"). */
  readonly cold: readonly number[];
  readonly dropped: number;
  readonly summary?: CallStoreSummary | null;
}

export interface KeyPatternRow {
  readonly pattern: string;
  readonly commands: number;
  readonly reads: number;
  readonly writes: number;
  readonly hits: number;
  readonly misses: number;
  readonly failed: number;
  readonly micros: number;
  readonly lastWriter?: string | null;
}

export interface KeyHistoryRow {
  readonly callId: string;
  readonly seq: number;
  readonly op: 'r' | 'w';
  readonly command?: string | null;
  readonly at: string;
  readonly outcome?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly status?: number | null;
  readonly sameValueAsPrevious?: boolean | null;
}

/** A Redis command as an export carries it (bytes base64, absent when masked) and the import reads it back. */
export interface ExportedStoreCommand {
  readonly store?: string;
  readonly seq: number;
  readonly at?: string | null;
  readonly micros: number;
  readonly command: string;
  readonly keys: readonly string[];
  readonly keysTotal: number;
  readonly rw: StoreRw;
  readonly outcome: StoreOutcome;
  readonly replyType: string;
  readonly resp: number;
  readonly error?: string | null;
  readonly args?: string | null;
  readonly reply?: string | null;
  readonly before?: string | null;
  readonly beforeNote?: string | null;
  readonly argsBytes: number;
  readonly replyBytes: number;
  readonly beforeBytes: number;
  readonly masked: boolean;
  readonly client?: string | null;
  readonly connection?: string | null;
  readonly server?: string | null;
  readonly db: number;
  readonly thread?: string | null;
  readonly code?: string | null;
  readonly callers?: readonly string[] | null;
  readonly origin?: StoreOrigin | null;
  readonly group?: StoreGroup | null;
  readonly poolWaitMicros?: number | null;
  readonly fingerprint?: string | null;
  readonly runTag?: string | null;
  readonly argsText?: readonly string[] | null;
  readonly replyFormat?: string | null;
  readonly replyText?: string | null;
  readonly valueFormat?: string | null;
  readonly valueText?: string | null;
  readonly beforeText?: string | null;
}

/** What the agent's Redis hooks saw on a project (Settings → Clients found). */
export interface RedisClientSeen {
  readonly client: string;
  readonly version?: string | null;
  readonly connections: number;
  readonly servers: readonly string[];
  readonly dbs: readonly number[];
}

export interface RedisSettings {
  readonly maskPatterns: readonly string[];
  readonly showValues: 'DECODED' | 'RAW';
  readonly beforeImage: boolean;
  readonly slowMillis: number;
  readonly housekeeping: boolean;
}

export const DEFAULT_REDIS_SETTINGS: RedisSettings = { maskPatterns: [], showValues: 'DECODED', beforeImage: false, slowMillis: 10, housekeeping: false };
