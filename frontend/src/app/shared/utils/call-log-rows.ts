import { CallRecord } from '../../core/models/call.model';
import { LinkedLogLine } from '../../core/models/call-logs.model';
import { CapturedStatement, SupplierMarker } from '../../core/models/db-capture.model';
import { isFailed } from './db-statement-display';

/**
 * One row of the database window's Logs and Together views (specs/008-logs-call-link, walkthrough "Together"):
 * statements, supplier calls and log lines in one list by time from the call's start.
 */
export type TogetherRow =
  | { readonly kind: 'db'; readonly key: string; readonly atMs: number; readonly seq: number; readonly verb: string; readonly text: string; readonly ms: number; readonly failed: boolean }
  | { readonly kind: 'sup'; readonly key: string; readonly atMs: number; readonly seq: number; readonly verb: string; readonly text: string; readonly ms: number | null }
  | { readonly kind: 'log'; readonly key: string; readonly atMs: number; readonly line: LinkedLogLine };

export type LogLevelClass = 'error' | 'warn' | 'info' | 'debug';

/** ERROR / FATAL / SEVERE → error, WARN(ING) → warn, DEBUG / TRACE → debug, anything else → info. */
export function logLevelClass(level: string | null | undefined): LogLevelClass {
  const l = (level ?? '').toUpperCase();
  if (l === 'ERROR' || l === 'FATAL' || l === 'SEVERE' || l === 'CRITICAL') return 'error';
  if (l === 'WARN' || l === 'WARNING') return 'warn';
  if (l === 'DEBUG' || l === 'TRACE' || l === 'FINE' || l === 'FINER' || l === 'FINEST') return 'debug';
  return 'info';
}

export function logRows(lines: readonly LinkedLogLine[]): TogetherRow[] {
  return lines.map((line) => ({ kind: 'log' as const, key: `l:${line.sourceId}:${line.lineId}`, atMs: line.offsetMs, line }));
}

/** Everything in one list, by time; at the same instant the call's own order (seq) and then log lines last. */
export function togetherRows(
  callStartMs: number,
  statements: readonly CapturedStatement[],
  markers: readonly SupplierMarker[],
  suppliers: ReadonlyMap<number, CallRecord>,
  lines: readonly LinkedLogLine[],
): TogetherRow[] {
  const rows: TogetherRow[] = statements.map((s) => ({
    kind: 'db' as const, key: `s:${s.seq}`, atMs: s.offsetMicros / 1000, seq: s.seq, verb: s.kind, text: oneLine(s.sql),
    ms: s.durationMicros / 1000, failed: isFailed(s),
  }));
  for (const m of markers) {
    const sup = suppliers.get(m.seq);
    const at = m.at ? Date.parse(m.at) : sup?.timestamp ? Date.parse(sup.timestamp) : NaN;
    if (Number.isNaN(at)) continue;
    rows.push({
      kind: 'sup', key: `p:${m.seq}`, atMs: at - callStartMs, seq: m.seq, verb: (sup?.method ?? m.method ?? 'CALL').toUpperCase(),
      text: sup?.supplierName ? `${sup.supplierName} ${pathOf(sup.url ?? m.url ?? '')}` : (sup?.url ?? m.url ?? ''), ms: sup?.duration_ms ?? null,
    });
  }
  rows.push(...logRows(lines));
  const rank = (r: TogetherRow) => (r.kind === 'log' ? 1 : 0);
  return rows.sort((a, b) => a.atMs - b.atMs || rank(a) - rank(b) || ('seq' in a && 'seq' in b ? a.seq - b.seq : 0));
}

/** A log line's fields for its detail: the raw line's JSON flattened to dotted keys, or null when it is not JSON. */
export function lineFields(raw: string): readonly { readonly key: string; readonly value: string }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: { key: string; value: string }[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length) {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}.${k}` : k, x);
    } else {
      out.push({ key: prefix, value: typeof v === 'string' ? v : JSON.stringify(v) });
    }
  };
  walk('', parsed);
  return out;
}

function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
