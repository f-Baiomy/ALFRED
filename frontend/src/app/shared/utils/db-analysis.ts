import { CallRecord } from '../../core/models/call.model';
import { CallDbAnalysis, CallDbCapture, CapturedStatement, QueryTotal, SupplierMarker, TimeBreakdown, TimeGap } from '../../core/models/db-capture.model';

export type { CallDbAnalysis, QueryTotal, TimeBreakdown, TimeGap };
import { isTxEnd } from './db-statement-display';

/**
 * Where an inbound call's time went, and which queries cost it - computed from what was captured (statement offsets
 * and durations, the supplier calls it made), never by asking anything. Shared by the database window (the time bar,
 * the "Top queries" tab), the .json export (index + dbCalls) and the .md/.html Database section, so they always agree.
 *
 * Built for the question an export reader asked by hand every time: "51 s, 18 s of it DB - where are the other 33?"
 * Here: DB / supplier calls / BETWEEN statements (the application's own work, or per-transaction overhead the
 * agent cannot see), with the gaps' count, median and largest - a 6 s stall reads differently from 300 gaps of 160 ms.
 */

const MIN_BASELINE_SAMPLES = 5;
const TOP_GAPS = 5;

/** RoundTrip.baselineMicros, mirrored: the 10th percentile of the call's successful SELECTs (5 or more), in ms. */
export function roundTripMs(statements: readonly CapturedStatement[]): number {
  const durations = statements
    .filter((s) => s.kind === 'SELECT' && s.outcome.kind !== 'FAILED')
    .map((s) => s.durationMicros)
    .sort((a, b) => a - b);
  if (durations.length < MIN_BASELINE_SAMPLES) return 0;
  return durations[Math.floor(durations.length * 0.1)] / 1000;
}

/** The application frames a statement ran from - its stack when the agent recorded one, else its one location. */
export function callersOf(s: CapturedStatement): readonly string[] {
  if (s.callers?.length) return s.callers;
  return s.codeLocation ? [s.codeLocation] : [];
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly seq: number;
  readonly kind: 'db' | 'out';
}

function union(spans: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

function length(spans: readonly { start: number; end: number }[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (ms: number) => Math.round(ms * 10) / 10;

/**
 * The breakdown of one inbound call. `suppliers` are its supplier calls by their place in its sequence (a marker with
 * no loaded call still counts as a point in time, with no duration).
 */
export function timeBreakdown(
  call: Pick<CallRecord, 'timestamp' | 'duration_ms'>,
  statements: readonly CapturedStatement[],
  markers: readonly SupplierMarker[],
  suppliers: ReadonlyMap<number, CallRecord>,
  transactionCount: number,
): TimeBreakdown {
  const start = new Date(call.timestamp).getTime();
  const totalMs = call.duration_ms ?? 0;
  const spans: Span[] = [];
  for (const s of statements) {
    if (isTxEnd(s) && !s.durationMicros) continue;
    spans.push({ start: s.offsetMicros / 1000, end: (s.offsetMicros + s.durationMicros) / 1000, seq: s.seq, kind: 'db' });
  }
  for (const m of markers) {
    const c = suppliers.get(m.seq);
    if (!c) continue;
    const at = new Date(c.timestamp).getTime() - start;
    spans.push({ start: at, end: at + (c.duration_ms ?? 0), seq: m.seq, kind: 'out' });
  }
  const out = union(spans.filter((s) => s.kind === 'out'));
  const all = union(spans);
  const outboundMs = length(out);
  const busyMs = length(all);
  const dbMs = Math.max(0, busyMs - outboundMs);
  const first = all[0]?.start ?? 0;
  const last = all[all.length - 1]?.end ?? 0;
  const gapMs = Math.max(0, last - first - busyMs);
  const edgeMs = Math.max(0, totalMs - busyMs - gapMs);

  // The gaps between consecutive busy stretches, named by the statement/supplier call on each side.
  const bySeqEnd = [...spans].sort((a, b) => a.end - b.end);
  const bySeqStart = [...spans].sort((a, b) => a.start - b.start);
  const statementBySeq = new Map(statements.map((s) => [s.seq, s]));
  const gaps: TimeGap[] = [];
  for (let i = 1; i < all.length; i++) {
    const ms = all[i].start - all[i - 1].end;
    if (ms <= 0) continue;
    const before = bySeqEnd.filter((s) => s.end <= all[i - 1].end + 1e-9).pop();
    const after = bySeqStart.find((s) => s.start >= all[i].start - 1e-9);
    const next = after ? statementBySeq.get(after.seq) : undefined;
    gaps.push({ ms: round(ms), afterSeq: before?.seq ?? null, beforeSeq: after?.seq ?? null, callers: next ? callersOf(next) : undefined });
  }
  const gapValues = gaps.map((g) => g.ms);
  return {
    totalMs: round(totalMs),
    dbMs: round(dbMs),
    outboundMs: round(outboundMs),
    gapMs: round(gapMs),
    edgeMs: round(edgeMs),
    gaps: { count: gaps.length, medianMs: round(median(gapValues)), maxMs: round(gapValues.length ? Math.max(...gapValues) : 0) },
    topGaps: [...gaps].sort((a, b) => b.ms - a.ms).slice(0, TOP_GAPS),
    baselineMs: round(roundTripMs(statements)),
    statements: statements.filter((s) => !isTxEnd(s)).length,
    transactions: transactionCount,
    appTimeDominant: totalMs >= 1000 && (gapMs + edgeMs) / totalMs > 0.5,
  };
}

/** One line per statement shape, costliest first: "why is this call slow" in one read. */
export function queryTotals(statements: readonly CapturedStatement[]): QueryTotal[] {
  const groups = new Map<string, CapturedStatement[]>();
  for (const s of statements) {
    if (isTxEnd(s)) continue;
    const key = s.fingerprint || s.sql;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const totals: QueryTotal[] = [];
  for (const [fingerprint, list] of groups) {
    const params = list.map((s) => JSON.stringify(s.params));
    const distinct = new Set(params).size;
    const callerCount = new Map<string, number>();
    for (const s of list) {
      const top = callersOf(s)[0];
      if (top) callerCount.set(top, (callerCount.get(top) ?? 0) + 1);
    }
    const origins = new Set(list.map((s) => s.origin?.id ?? ''));
    totals.push({
      fingerprint,
      sql: list[0].sql,
      table: list[0].table ?? null,
      kind: list[0].kind,
      count: list.length,
      distinctParams: distinct,
      duplicates: list.length - distinct,
      totalMs: round(list.reduce((sum, s) => sum + s.durationMicros, 0) / 1000),
      maxMs: round(Math.max(...list.map((s) => s.durationMicros)) / 1000),
      rows: list.reduce((sum, s) => sum + (s.outcome.rowsRead ?? s.outcome.affected ?? 0), 0),
      failed: list.filter((s) => s.outcome.kind === 'FAILED').length,
      callers: [...callerCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 5),
      seqs: list.map((s) => s.seq),
      // the HQL text and kind only - its parameter values stay with the statements (redaction masks them there)
      ...(origins.size === 1 && list[0].origin?.text ? { hql: list[0].origin.text, origin: list[0].origin.kind } : {}),
    });
  }
  return totals.sort((a, b) => b.totalMs - a.totalMs);
}

/** Both, for one captured call - what the export dialog attaches to a capture and every export writes. */
export function analyzeCapture(call: Pick<CallRecord, 'timestamp' | 'duration_ms'>, capture: CallDbCapture, suppliers: ReadonlyMap<number, CallRecord>): CallDbAnalysis {
  return {
    time: timeBreakdown(call, capture.statements, capture.supplierMarkers ?? [], suppliers, capture.transactions.length),
    queries: queryTotals(capture.statements),
  };
}

/** A call's supplier calls by their place in its sequence, found among `calls` by the db-agent's parent link. */
export function suppliersOf(callId: string, calls: readonly CallRecord[]): Map<number, CallRecord> {
  const map = new Map<number, CallRecord>();
  for (const c of calls) {
    if (c.parentCallId === callId && c.parentSeq != null) map.set(c.parentSeq, c);
  }
  return map;
}
