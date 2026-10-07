import type { MaskContext } from './masking.ts';
import { maskText } from './masking.ts';
import type { AttentionMark, AttentionSignals } from './frontend.ts';

/**
 * The kinds of trouble a call can carry (specs/010-mcp-log-investigation) - from HTTP, the database or the
 * application's logs - and the words the tools use for them. Mirrors backend-triage's Signal: errors outrank warnings.
 */
export const SIGNALS = ['HTTP_ERROR', 'NO_ANSWER', 'DB_FAILED', 'SUPPLIER_FAILED', 'LOG_ERROR', 'LOG_EXCEPTION', 'REDIS_FAILED', 'DB_WARNING', 'LOG_WARNING', 'CACHE_COLD'] as const;
export type SignalName = typeof SIGNALS[number];

export const SIGNAL_TEXT: Record<SignalName, string> = {
  HTTP_ERROR: 'answered with an error status',
  NO_ANSWER: 'got no answer (transport error)',
  DB_FAILED: 'a database statement failed',
  SUPPLIER_FAILED: 'a supplier call failed',
  LOG_ERROR: 'logged an ERROR line',
  LOG_EXCEPTION: 'logged an exception',
  DB_WARNING: 'raised a database flag (slow, N+1, huge result, no WHERE...)',
  LOG_WARNING: 'logged a WARN line',
  REDIS_FAILED: 'a Redis command failed (error reply or no reply)',
  CACHE_COLD: 'a Redis read missed a key an earlier recorded call wrote - its TTL ran out',
};

export function isError(signal: SignalName): boolean {
  return signal !== 'DB_WARNING' && signal !== 'LOG_WARNING' && signal !== 'CACHE_COLD';
}

/** Why lines or statements may be missing for a project or call - said instead of "none". */
export const WHY: Record<string, string> = {
  LOGS_OFF: "log lines are not caught for this project: its ▤ switch is off (set_log_capture can turn it on)",
  NO_AGENT: 'the db-agent was not attached to this project, so no log lines or statements were caught',
  DB_OFF: "database statements are not captured for this project: its ◆ switch is off (set_db_capture can turn it on)",
  BELOW_LEVEL: 'lines below the Log level that applied were not caught',
  REDIS_OFF: "Redis commands are not captured for this project: its ⬢ switch is off (Sources bar)",
};

/** A call's caught log and database signals as triage keeps them on its mark (absent on an older Alfred). */
export type MarkSignals = AttentionSignals;

/** The signals of a triage mark - the same rules as backend-triage's Signal.of. */
export function signalsOfEntry(e: AttentionMark, minStatus = 400): SignalName[] {
  const out: SignalName[] = [];
  if (e.error) out.push('NO_ANSWER');
  else if (e.status != null && e.status >= minStatus) out.push('HTTP_ERROR');
  if (e.failedStatements > 0) out.push('DB_FAILED');
  if (e.failingChildren > 0) out.push('SUPPLIER_FAILED');
  const s = e.signals ?? {};
  if ((s.logErrors ?? 0) > 0) out.push('LOG_ERROR');
  if ((s.logExceptions ?? 0) > 0) out.push('LOG_EXCEPTION');
  if ((s.redisFailed ?? 0) > 0) out.push('REDIS_FAILED');
  if ((s.dbFlags ?? []).length > 0) out.push('DB_WARNING');
  if ((s.logWarnings ?? 0) > 0) out.push('LOG_WARNING');
  if ((s.redisCold ?? 0) > 0) out.push('CACHE_COLD');
  return out;
}

/** "▤ 2 errors · 1 warning · 1 exception · DB flags SLOW, REPEATED_QUERY" - the log/DB part of a call's evidence. */
export function signalEvidence(s: MarkSignals | undefined): string | null {
  if (!s) return null;
  const parts: string[] = [];
  if (s.logErrors) parts.push(`${s.logErrors} error line${s.logErrors > 1 ? 's' : ''}`);
  if (s.logWarnings) parts.push(`${s.logWarnings} warning line${s.logWarnings > 1 ? 's' : ''}`);
  if (s.logExceptions) parts.push(`${s.logExceptions} exception${s.logExceptions > 1 ? 's' : ''}`);
  const log = parts.length ? `▤ ${parts.join(' · ')}${s.logLevel ? ` (caught at ${s.logLevel})` : ''}` : null;
  const db = s.dbFlags?.length ? `DB flags ${s.dbFlags.join(', ')}` : null;
  const redis = [s.redisFailed ? `⬢ ${s.redisFailed} Redis command${s.redisFailed > 1 ? 's' : ''} failed` : '',
    s.redisCold ? `⬢ cache cold (${s.redisCold} miss${s.redisCold > 1 ? 'es' : ''} on expired keys)` : ''].filter(Boolean).join(' · ') || null;
  return [log, db, redis].filter(Boolean).join(' · ') || null;
}

/** A log line's message shortened for an evidence line, masked like bodies. */
export function shortMessage(ctx: MaskContext, message: string | null | undefined, max = 160): string {
  const m = maskText(ctx, (message ?? '').replace(/\s+/g, ' ').trim());
  return m.length > max ? `${m.slice(0, max)}… (${m.length} chars)` : m;
}

// ------------------------------------------------------------------ fingerprint (port of backend LogFingerprint)

const RULES: readonly [RegExp, string][] = [
  [/'[^'\n]*'|"[^"\n]*"/g, '<q>'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<uuid>'],
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '<ip>'],
  [/\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\b/g, '<hex>'],
  [/(?<![\w.])-?\d+(?:\.\d+)?(?!\w)/g, '<n>'],
  [/\s+/g, ' '],
];

/** The message with its varying parts set aside - backend LogFingerprint.normalise, tested on the same vectors. */
export function normaliseMessage(message: string | null | undefined): string {
  if (!message) return '';
  let out = message;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  out = out.trim();
  return out.length > 300 ? out.slice(0, 300) : out;
}

/** What a line means, for comparing two calls' lines: logger, exception type and normalised message. */
export function lineKey(line: { logger?: string | null; exception?: { type?: string | null } | null; message?: string | null }): string {
  return `${line.logger ?? ''}|${line.exception?.type ?? ''}|${normaliseMessage(line.message)}`;
}
