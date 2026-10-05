import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement, DbFindingSummary, DbFlag, DbFlagType, SupplierMarker } from '../../core/models/db-capture.model';
import { isTxEnd } from './db-statement-display';

const MIN_BASELINE_SAMPLES = 5;

/** RoundTrip.baselineMicros, mirrored: the 10th percentile of the call's successful SELECTs (5 or more), in ms. */
export function roundTripMs(statements: readonly CapturedStatement[]): number {
  const durations = statements
    .filter((s) => s.kind === 'SELECT' && s.outcome.kind !== 'FAILED')
    .map((s) => s.durationMicros)
    .sort((a, b) => a - b);
  if (durations.length < MIN_BASELINE_SAMPLES) return 0;
  return durations[Math.floor(durations.length * 0.1)] / 1000;
}

/**
 * What a captured call's database work says, in words a reader can act on (specs/006-db-capture/timeline-mock.html):
 * one summary line, the timeline's lanes (what each statement is, the supplier calls, the idle stretches) and the
 * findings - each one line closed (title, short why, count, impact), opened: the full why, the fix and its
 * statements as chips. Built from the backend's flags (StatementFlags.java) plus what only the client can see - the
 * supplier calls and the stretches where nothing ran. Shared by the database window and the .md/.html/.json exports,
 * so they say the same thing.
 */

export type FindingSeverity = 'bad' | 'warn' | 'note';
/** What a timeline item is - its colour. */
export type ItemKind = 'ok' | 'fan' | 'slow' | 'rep' | 'big' | 'err' | 'tx' | 'sup' | 'idle';

export const ITEM_LABELS: Readonly<Record<ItemKind, string>> = {
  ok: 'Query',
  fan: 'Loaded per row (N+1 inside one query)',
  slow: 'Slow (beyond the round trip)',
  rep: 'Run twice',
  big: 'Huge read',
  err: 'Failed',
  tx: 'Commit / rollback',
  sup: 'Supplier call',
  idle: 'Idle ≥ 1 s',
};

/** One statement (or a range, or a supplier call, or an idle stretch) of a finding; a click jumps to `seq`. */
export interface FindingChip {
  /** The timeline item it lights up: `s<seq>` statement, `c<seq>` supplier call, `i<seq>` idle stretch before seq. */
  readonly key: string;
  readonly seq: number;
  readonly kind: ItemKind;
  /** "#12", "#20-#22", "#3 → #4". */
  readonly n: string;
  readonly label: string;
  readonly ms?: number | null;
}

export interface DbFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly icon: string;
  readonly title: string;
  /** The closed line's why - a few words. */
  readonly short: string;
  readonly why: string;
  readonly fix?: string;
  /** Time it cost (or could save), for ranking; null when it is not about time. */
  readonly impactMs: number | null;
  readonly impact: string;
  /** "7 statements", "4 pairs", "2 calls". */
  readonly count: string;
  /** Every statement / supplier call it is about, in run order - "Show" filters the list to these. */
  readonly seqs: readonly number[];
  /** Timeline items it lights up on hover. */
  readonly keys: readonly string[];
  readonly chips: readonly FindingChip[];
  /** The flag type it came from, or what the client found. */
  readonly source: DbFlagType | 'IDLE' | 'SUPPLIER_FAILED' | 'SUPPLIER_TIME' | 'ROUND_TRIP';
  /** Statement shapes "Mark expected" silences (empty: nothing to mark). */
  readonly fingerprints: readonly string[];
}

export interface IdleStretch {
  readonly atMs: number;
  readonly ms: number;
  /** The statement / supplier call after it (null: the call's end). */
  readonly beforeSeq: number | null;
  readonly afterSeq: number | null;
}

export interface TimelineSupplier {
  readonly seq: number;
  readonly atMs: number;
  readonly ms: number;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly status: number | null;
  readonly failed: boolean;
  /** Its row in the supplier lane - calls that overlap get their own row. */
  readonly row: number;
}

export interface DbOverview {
  readonly totalMs: number;
  readonly dbMs: number;
  readonly supplierMs: number;
  /** Share of the call with neither SQL nor a supplier call running, 0-100. */
  readonly appPct: number;
  readonly baselineMs: number;
  readonly idle: readonly IdleStretch[];
  readonly suppliers: readonly TimelineSupplier[];
  /** What each statement is on the timeline. */
  readonly kinds: ReadonlyMap<number, ItemKind>;
  readonly findings: readonly DbFinding[];
  /** "20.0 s · 51% inside the app - 2 idle stretches, the longest 2.5 s before #28". */
  readonly summary: string;
  /** Its parts: "51% inside the app" (the biggest share) and what follows the dash. */
  readonly share: string;
  readonly detail: string;
  readonly errors: number;
  readonly toFix: number;
}

export const IDLE_MIN_MS = 1000;
const SUPPLIER_NOTE_MIN_MS = 1000;
const SUPPLIER_NOTE_MIN_SHARE = 0.2;
const ROUND_TRIP_NOTE_MIN_MS = 20;
const ROUND_TRIP_NOTE_MIN_STATEMENTS = 10;
/** Chips one finding shows; past it, "+N more" (the list's "Show" has them all). */
export const CHIP_LIMIT = 30;

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const msOf = (s: CapturedStatement) => s.durationMicros / 1000;

/** "ndc-integration-x.azurewebsites.net" → "ndc-integration-x" - the part that tells suppliers apart. */
function hostLabel(url: string, supplierName?: string | null): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: supplierName || u.hostname.split('.')[0], path: u.pathname };
  } catch {
    return { host: supplierName || url, path: '' };
  }
}

function union(spans: { start: number; end: number; seq: number }[]): { start: number; end: number; first: number; last: number }[] {
  const out: { start: number; end: number; first: number; last: number }[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      if (s.end >= last.end) last.last = s.seq;
      last.end = Math.max(last.end, s.end);
    } else out.push({ start: s.start, end: s.end, first: s.seq, last: s.seq });
  }
  return out;
}

/** Supplier calls on the timeline, overlapping ones on rows of their own. */
export function timelineSuppliers(call: Pick<CallRecord, 'timestamp'>, markers: readonly SupplierMarker[], suppliers: ReadonlyMap<number, CallRecord>): TimelineSupplier[] {
  const start = Date.parse(call.timestamp);
  const items: Omit<TimelineSupplier, 'row'>[] = [];
  const seqs = new Set([...markers.map((m) => m.seq), ...suppliers.keys()]);
  for (const seq of seqs) {
    const c = suppliers.get(seq);
    if (!c) continue;
    const at = Date.parse(c.timestamp) - start;
    if (!Number.isFinite(at)) continue;
    const status = c.response?.status ?? null;
    items.push({ seq, atMs: Math.max(0, at), ms: c.duration_ms ?? 0, method: c.method, ...hostLabel(c.url, c.supplierName), status,
      failed: !!c.error || status == null || status >= 400 });
  }
  const rowsEnd: number[] = [];
  return items.sort((a, b) => a.atMs - b.atMs).map((it) => {
    let row = rowsEnd.findIndex((end) => end <= it.atMs);
    if (row < 0) {
      row = rowsEnd.length;
      rowsEnd.push(0);
    }
    rowsEnd[row] = it.atMs + it.ms;
    return { ...it, row };
  });
}

function paramsKey(s: CapturedStatement): string {
  return JSON.stringify(s.params);
}

function firstValue(s: CapturedStatement): string {
  return s.params[0]?.[0]?.value ?? '';
}

function chipOf(s: CapturedStatement, kind: ItemKind, label = s.table ?? s.kind): FindingChip {
  return { key: `s${s.seq}`, seq: s.seq, kind, n: `#${s.seq}`, label, ms: msOf(s) };
}

function errorLabel(s: CapturedStatement): string {
  return s.outcome.message?.split('\n')[0].trim() || s.outcome.sqlState || 'error';
}

/** Builds the overview of one captured call. `flags` are the backend's, worst first. */
export function buildOverview(
  call: Pick<CallRecord, 'timestamp' | 'duration_ms'> & { readonly response?: CallRecord['response'] },
  statements: readonly CapturedStatement[],
  markers: readonly SupplierMarker[],
  suppliers: ReadonlyMap<number, CallRecord>,
  flags: readonly DbFlag[],
): DbOverview {
  const bySeq = new Map(statements.map((s) => [s.seq, s]));
  const ordered = [...statements].sort((a, b) => a.seq - b.seq);
  const sup = timelineSuppliers(call, markers, suppliers);
  const lastEnd = Math.max(0, ...ordered.map((s) => (s.offsetMicros + s.durationMicros) / 1000), ...sup.map((c) => c.atMs + c.ms));
  const totalMs = Math.max(call.duration_ms ?? 0, lastEnd);

  // ---- busy / idle
  const dbSpans = ordered.filter((s) => !(isTxEnd(s) && !s.durationMicros))
    .map((s) => ({ start: s.offsetMicros / 1000, end: (s.offsetMicros + s.durationMicros) / 1000, seq: s.seq }));
  const supSpans = sup.map((c) => ({ start: c.atMs, end: c.atMs + c.ms, seq: c.seq }));
  const busy = union([...dbSpans, ...supSpans]);
  const busyMs = busy.reduce((n, b) => n + b.end - b.start, 0);
  const supplierMs = union(supSpans).reduce((n, b) => n + b.end - b.start, 0);
  const dbMs = Math.max(0, busyMs - supplierMs);
  const appMs = Math.max(0, totalMs - busyMs);
  const idle: IdleStretch[] = [];
  if (busy.length && busy[0].start >= IDLE_MIN_MS) idle.push({ atMs: 0, ms: busy[0].start, beforeSeq: busy[0].first, afterSeq: null });
  for (let i = 1; i < busy.length; i++) {
    const gap = busy[i].start - busy[i - 1].end;
    if (gap >= IDLE_MIN_MS) idle.push({ atMs: busy[i - 1].end, ms: gap, beforeSeq: busy[i].first, afterSeq: busy[i - 1].last });
  }
  const tail = busy.length ? totalMs - busy[busy.length - 1].end : 0;
  if (tail >= IDLE_MIN_MS) idle.push({ atMs: busy[busy.length - 1].end, ms: tail, beforeSeq: null, afterSeq: busy[busy.length - 1].last });

  // ---- what each statement is
  const kinds = new Map<number, ItemKind>();
  const mark = (seqs: readonly number[], kind: ItemKind) => seqs.forEach((seq) => bySeq.has(seq) && !kinds.has(seq) && kinds.set(seq, kind));
  for (const s of ordered) {
    if (s.outcome.kind === 'FAILED') kinds.set(s.seq, 'err');
    else if (isTxEnd(s)) kinds.set(s.seq, 'tx');
  }
  const ofType = (t: DbFlagType) => flags.filter((f) => f.type === t);
  ofType('HUGE_RESULT').forEach((f) => mark(f.seqs, 'big'));
  ofType('QUERY_FAN_OUT').forEach((f) => mark(f.seqs, 'fan'));
  ofType('SLOW').forEach((f) => mark(f.seqs, 'slow'));
  ofType('DUPLICATE').forEach((f) => mark(f.seqs, 'rep'));
  for (const s of ordered) if (!kinds.has(s.seq)) kinds.set(s.seq, 'ok');
  const kindOf = (seq: number): ItemKind => kinds.get(seq) ?? 'ok';

  const baselineMs = roundTripMs(statements);
  const findings: DbFinding[] = [];
  const fp = (seqs: readonly number[]) => [...new Set(seqs.map((q) => bySeq.get(q)?.fingerprint).filter((f): f is string => !!f))];
  const stmts = (seqs: readonly number[]) => seqs.map((q) => bySeq.get(q)).filter((s): s is CapturedStatement => !!s);
  const status = call.response?.status;

  // ---- errors
  for (const f of ofType('FAILED_SWALLOWED')) {
    const s = bySeq.get(f.seqs[0]);
    const next = s ? ordered.find((o) => o.seq > s.seq && o.kind === 'ROLLBACK' && (!s.txId || o.txId === s.txId)) : undefined;
    const seqs = next ? [...f.seqs, next.seq] : [...f.seqs];
    const error = f.detail?.['error'] ?? (s ? errorLabel(s) : 'error');
    findings.push({
      id: `swallowed-${f.seqs[0]}`, severity: 'bad', icon: '✕', title: `Error hidden${f.detail?.['table'] ? ` · ${f.detail['table']}` : ''}`,
      short: `#${f.seqs[0]} failed${next ? ', rolled back' : ''}, the call still answered ${status ?? 'normally'}`,
      why: `#${f.seqs[0]} failed (${s?.outcome.message?.trim() || error})${next ? `, #${next.seq} rolled its transaction back` : ''} - and the call still answered ${status ?? 'normally'}, so nobody was told the work was lost.`,
      fix: 'Let the failure reach the caller, or at least log it - a caught and ignored SQL error looks like success.',
      impactMs: null, impact: 'lost silently', count: plural(seqs.length, 'statement'), seqs, keys: seqs.map((q) => `s${q}`),
      chips: stmts(seqs).map((x) => chipOf(x, kindOf(x.seq))), source: 'FAILED_SWALLOWED', fingerprints: [],
    });
  }
  const failed = ofType('FAILED');
  if (failed.length) {
    const seqs = failed.flatMap((f) => f.seqs);
    const first = failed[0].detail?.['error'] ?? 'error';
    findings.push({
      id: 'failed', severity: 'bad', icon: '✕', title: `${plural(seqs.length, 'statement')} failed`, short: first,
      why: stmts(seqs).map((s) => `#${s.seq} ${s.table ?? s.kind}: ${errorLabel(s)}`).join(' · '),
      fix: 'Open each one for its error and the code that ran it.',
      impactMs: null, impact: `${seqs.length} failed`, count: plural(seqs.length, 'statement'), seqs, keys: seqs.map((q) => `s${q}`),
      chips: stmts(seqs).slice(0, CHIP_LIMIT).map((s) => chipOf(s, 'err')), source: 'FAILED', fingerprints: [],
    });
  }
  for (const f of ofType('ROLLED_BACK')) {
    const writes = f.detail?.['writes'] ?? '?';
    const s = bySeq.get(f.seqs[0]);
    findings.push({
      id: `rolled-back-${f.group ?? f.seqs[0]}`, severity: 'bad', icon: '↩', title: `Transaction rolled back · ${writes} writes not saved`,
      short: `transaction ${f.detail?.['tx'] ?? ''} from #${f.seqs[0]}`.trim(),
      why: `The transaction that starts at #${f.seqs[0]} was rolled back - its ${writes} writes never reached the database.`,
      fix: 'Find the failure or the decision that rolled it back - open the transaction.',
      impactMs: null, impact: `${writes} writes lost`, count: plural(f.seqs.length, 'statement'), seqs: [...f.seqs], keys: f.seqs.map((q) => `s${q}`),
      chips: s ? [chipOf(s, kindOf(s.seq))] : [], source: 'ROLLED_BACK', fingerprints: [],
    });
  }
  for (const f of ofType('NO_WHERE')) {
    const s = bySeq.get(f.seqs[0]);
    findings.push({
      id: `no-where-${f.seqs[0]}`, severity: 'bad', icon: '⚠', title: `${f.detail?.['verb'] ?? 'DELETE'} without WHERE · ${f.detail?.['table'] ?? ''}`.trim(),
      short: `every row of the table${f.detail?.['rows'] ? ` - ${f.detail['rows']} rows` : ''}`,
      why: `#${f.seqs[0]} changes every row of ${f.detail?.['table'] ?? 'its table'} - there is no WHERE.`,
      fix: 'Add the missing WHERE - or Mark expected if clearing the whole table is the intent.',
      impactMs: null, impact: f.detail?.['rows'] ? `${f.detail['rows']} rows` : 'whole table', count: '1 statement', seqs: [...f.seqs], keys: f.seqs.map((q) => `s${q}`),
      chips: s ? [chipOf(s, kindOf(s.seq))] : [], source: 'NO_WHERE', fingerprints: fp(f.seqs),
    });
  }

  // ---- warnings
  for (const f of ofType('QUERY_FAN_OUT')) {
    const all = stmts(f.seqs);
    if (!all.length) continue;
    const [first, ...followers] = all;
    const d = f.detail ?? {};
    const hql = !!first.origin?.text;
    // one chip per parent row: the followers that share its values
    const groups: CapturedStatement[][] = [];
    const byValues = new Map<string, CapturedStatement[]>();
    for (const s of followers) {
      const key = paramsKey(s);
      if (!byValues.has(key)) {
        byValues.set(key, []);
        groups.push(byValues.get(key)!);
      }
      byValues.get(key)!.push(s);
    }
    const perRow = d['perRow'] ?? String(Math.round(followers.length / Math.max(1, groups.length)));
    const tables = d['tables'] || [...new Set(followers.map((s) => s.table).filter(Boolean))].join(', ');
    const extraMs = Number(d['extraMs'] ?? followers.reduce((n, s) => n + msOf(s), 0));
    const rows = d['rows'] ?? String(groups.length);
    const projected = baselineMs ? ` With 100 rows that is ${(100 * Number(perRow)).toLocaleString()} extra queries (≈ ${fmtMs(100 * Number(perRow) * baselineMs)} at this ${Math.round(baselineMs)} ms round trip).` : '';
    findings.push({
      id: `fan-${f.group ?? first.seq}`, severity: 'warn', icon: '🌿',
      title: `1 ${hql ? (first.origin?.kind === 'NATIVE' ? 'native' : 'HQL') : ''} query → ${all.length} SQL statements`.replace('  ', ' '),
      short: `its ${rows} rows loaded ${tables ? `${perRow === '1' ? 'a query' : `${perRow} queries`}` : 'more'} each, one by one`,
      why: `${d['query'] ?? first.sql} (#${first.seq}) returned ${rows} rows; for each one ${hql ? 'Hibernate' : 'the application'} then ran ${perRow === '1' ? 'a query' : `${perRow} queries`} of its own${tables ? ` on ${tables}` : ''} - an N+1 inside one query.${projected}`,
      fix: hql
        ? 'join fetch these collections in the query, or put @BatchSize(size = 50) / @Fetch(FetchMode.SUBSELECT) on them - one query per collection instead of one per row.'
        : 'Load the children of all the rows in one query (WHERE parent_id IN (...)) or with a join.',
      impactMs: extraMs, impact: `+${fmtMs(extraMs)}`, count: plural(all.length, 'statement'), seqs: all.map((s) => s.seq), keys: all.map((s) => `s${s.seq}`),
      chips: [chipOf(first, 'fan', first.table ?? 'query'), ...groups.slice(0, CHIP_LIMIT).map((g) => ({
        key: `s${g[0].seq}`, seq: g[0].seq, kind: 'fan' as const, n: g.length > 1 ? `#${g[0].seq}-#${g[g.length - 1].seq}` : `#${g[0].seq}`,
        label: `${firstValue(g[0]) || 'row'} · ${plural(g.length, 'query', 'queries')}`, ms: g.reduce((n, s) => n + msOf(s), 0),
      }))],
      source: 'QUERY_FAN_OUT', fingerprints: fp([first.seq]),
    });
  }
  if (idle.length) {
    const total = idle.reduce((n, g) => n + g.ms, 0);
    const longest = [...idle].sort((a, b) => b.ms - a.ms)[0];
    findings.push({
      id: 'idle', severity: 'warn', icon: '⏳', title: `${fmtMs(total)} idle in ${plural(idle.length, 'stretch', 'stretches')}`,
      short: 'no SQL, no supplier call running',
      why: `For ${fmtMs(total)} of this call nothing it did reached the database or a supplier - the longest stretch is ${fmtMs(longest.ms)}${longest.beforeSeq != null ? ` before #${longest.beforeSeq}` : ' at the end'}. That is the application's own work (or waiting on something the agent does not see: a lock, a file, a queue).`,
      fix: 'Open the statement right after a stretch - its call chain shows the code that ran before it.',
      impactMs: total, impact: fmtMs(total), count: plural(idle.length, 'stretch', 'stretches'),
      seqs: [...new Set(idle.map((g) => g.beforeSeq ?? g.afterSeq).filter((q): q is number => q != null))],
      keys: idle.map(idleKey),
      chips: idle.map((g) => ({ key: idleKey(g), seq: (g.beforeSeq ?? g.afterSeq)!, kind: 'idle' as const, n: g.beforeSeq != null ? `before #${g.beforeSeq}` : `after #${g.afterSeq}`, label: `${fmtMs(g.ms)} idle` }))
        .filter((c) => c.seq != null),
      source: 'IDLE', fingerprints: [],
    });
  }
  for (const f of ofType('HUGE_RESULT')) {
    const s = bySeq.get(f.seqs[0]);
    if (!s) continue;
    findings.push({
      id: `huge-${s.seq}`, severity: 'warn', icon: '📦', title: `${f.detail?.['rows'] ?? s.outcome.rowsRead} rows read from ${s.table ?? 'one query'}`,
      short: 'every row comes back to the application',
      why: `#${s.seq} brings ${f.detail?.['rows'] ?? s.outcome.rowsRead} rows of ${s.table ?? 'its table'} into the application in ${fmtMs(msOf(s))}.`,
      fix: 'Filter or page it in SQL - or, if it is reference data read on every call, cache it.',
      impactMs: msOf(s), impact: fmtMs(msOf(s)), count: '1 statement', seqs: [s.seq], keys: [`s${s.seq}`], chips: [chipOf(s, 'big')],
      source: 'HUGE_RESULT', fingerprints: fp([s.seq]),
    });
  }
  const dups = ofType('DUPLICATE');
  if (dups.length) {
    const chips: FindingChip[] = [];
    const seqs: number[] = [];
    let savable = 0;
    let groups = 0;
    let largest = 0;
    for (const f of dups) {
      const byValues = new Map<string, CapturedStatement[]>();
      for (const s of stmts(f.seqs)) {
        const key = paramsKey(s);
        byValues.set(key, [...(byValues.get(key) ?? []), s]);
      }
      for (const g of byValues.values()) {
        if (g.length < 2) continue;
        groups++;
        largest = Math.max(largest, g.length);
        savable += g.slice(1).reduce((n, s) => n + msOf(s), 0);
        seqs.push(...g.map((s) => s.seq));
        chips.push({ key: `s${g[0].seq}`, seq: g[1].seq, kind: 'rep', n: g.map((s) => `#${s.seq}`).join(' → '), label: g[0].table ?? g[0].kind });
      }
    }
    if (groups) {
      findings.push({
        id: 'duplicates', severity: 'warn', icon: '♻', title: largest === 2 ? `${plural(groups, 'query', 'queries')} run twice` : `${plural(groups, 'query', 'queries')} run again with the same values`,
        short: 'same SQL, same parameters',
        why: 'The same SQL with the same parameters ran again later in the call - the second answer is the first one again.',
        fix: 'Keep the first answer for the rest of the request (a request-scoped cache, or pass the result along).',
        impactMs: savable, impact: `−${fmtMs(savable)}`, count: plural(groups, largest === 2 ? 'pair' : 'group'), seqs: seqs.sort((a, b) => a - b),
        keys: seqs.map((q) => `s${q}`), chips: chips.slice(0, CHIP_LIMIT), source: 'DUPLICATE', fingerprints: fp(seqs),
      });
    }
  }
  for (const f of ofType('REPEATED_QUERY')) {
    const first = bySeq.get(f.seqs[0]);
    if (!first) continue;
    const shape = first.fingerprint || first.sql;
    const run: CapturedStatement[] = [];
    for (const s of ordered.filter((o) => o.seq >= first.seq)) {
      if ((s.fingerprint || s.sql) !== shape) break;
      run.push(s);
    }
    const cacheable = f.detail?.['cacheable'] === 'true';
    const extra = run.slice(1).reduce((n, s) => n + msOf(s), 0);
    findings.push({
      id: `repeat-${first.seq}`, severity: 'warn', icon: '🔁',
      title: cacheable ? `${first.table ?? 'One query'} read ${run.length}× with the same values` : `N+1: ${first.table ?? 'one query'} ×${run.length} in a row`,
      short: cacheable ? 'same answer every time' : 'one query per value',
      why: cacheable
        ? `#${first.seq} and the ${run.length - 1} after it are the same query with the same values, back to back.`
        : `#${first.seq} and the ${run.length - 1} after it are the same query with a different value each time - a loop running one query per item.`,
      fix: cacheable ? 'Run it once and reuse the answer.' : 'Load them in one query (WHERE x IN (...)), with a join, or with @BatchSize.',
      impactMs: extra, impact: `+${fmtMs(extra)}`, count: plural(run.length, 'statement'), seqs: run.map((s) => s.seq), keys: run.map((s) => `s${s.seq}`),
      chips: [{ key: `s${first.seq}`, seq: first.seq, kind: kindOf(first.seq), n: `#${first.seq}-#${run[run.length - 1].seq}`, label: `${first.table ?? first.kind} ×${run.length}`, ms: run.reduce((n, s) => n + msOf(s), 0) }],
      source: 'REPEATED_QUERY', fingerprints: fp([first.seq]),
    });
  }
  // a huge read or a failure is reported as that - not again as slow
  const slow = stmts(ofType('SLOW').flatMap((f) => f.seqs)).filter((s) => kindOf(s.seq) === 'slow');
  if (slow.length) {
    const beyond = slow.reduce((n, s) => n + Math.max(0, msOf(s) - baselineMs), 0);
    findings.push({
      id: 'slow', severity: 'warn', icon: '🐢', title: `${plural(slow.length, 'slow query', 'slow queries')}`,
      short: baselineMs ? `beyond the ${Math.round(baselineMs)} ms round trip` : 'slow in the database',
      why: `${slow.length === 1 ? 'It takes' : 'They take'} longer in the database than the round trip every statement of this call pays${baselineMs ? ` (≈ ${Math.round(baselineMs)} ms)` : ''} - the database is doing real work.`,
      fix: 'Open it: the Index check shows whether its WHERE columns lead an index; the plan in your database tool tells the rest.',
      impactMs: beyond, impact: fmtMs(beyond), count: plural(slow.length, 'statement'), seqs: slow.map((s) => s.seq), keys: slow.map((s) => `s${s.seq}`),
      chips: slow.slice(0, CHIP_LIMIT).map((s) => chipOf(s, 'slow')), source: 'SLOW', fingerprints: fp(slow.map((s) => s.seq)),
    });
  }
  for (const f of ofType('LOCK_DURING_SUPPLIER_CALL')) {
    const c = sup.find((x) => x.seq === f.seqs[0]);
    findings.push({
      id: `lock-${f.seqs[0]}`, severity: 'warn', icon: '🔒', title: 'Row lock held during a supplier call',
      short: c ? `${c.host} · ${fmtMs(c.ms)} with the lock held` : `transaction ${f.detail?.['tx'] ?? ''}`,
      why: `A transaction${f.detail?.['tx'] ? ` (${f.detail['tx']})` : ''} locked rows and kept them locked while the call waited on a supplier - every other request for those rows waits too.`,
      fix: 'Commit before calling the supplier, or call it before taking the lock.',
      impactMs: c?.ms ?? null, impact: c ? fmtMs(c.ms) : 'lock held', count: '1 call', seqs: [...f.seqs], keys: f.seqs.map((q) => `c${q}`),
      chips: c ? [{ key: `c${c.seq}`, seq: c.seq, kind: 'sup', n: `#${c.seq}`, label: c.host, ms: c.ms }] : [], source: 'LOCK_DURING_SUPPLIER_CALL', fingerprints: [],
    });
  }
  for (const f of ofType('LARGE_DELETE')) {
    const s = bySeq.get(f.seqs[0]);
    findings.push({
      id: `large-delete-${f.seqs[0]}`, severity: 'warn', icon: '🗑', title: `${f.detail?.['rows'] ?? 'Many'} rows deleted from ${f.detail?.['table'] ?? 'one table'}`,
      short: 'more than the large-delete threshold', why: `#${f.seqs[0]} deleted ${f.detail?.['rows'] ?? 'many'} rows in one statement.`,
      fix: 'Intended? Mark expected. If not, check its WHERE.',
      impactMs: null, impact: `${f.detail?.['rows'] ?? ''} rows`.trim(), count: '1 statement', seqs: [...f.seqs], keys: f.seqs.map((q) => `s${q}`),
      chips: s ? [chipOf(s, kindOf(s.seq))] : [], source: 'LARGE_DELETE', fingerprints: fp(f.seqs),
    });
  }
  for (const f of ofType('TX_PER_STATEMENT')) {
    findings.push({
      id: 'tx-per-statement', severity: 'warn', icon: '🧾', title: `${f.detail?.['transactions'] ?? 'Many'} transactions for ${f.detail?.['statements'] ?? 'as many'} statements`,
      short: 'about one commit per statement',
      why: 'Almost every statement runs in a transaction of its own - each one pays a connection checkout, a begin and a commit.',
      fix: 'Do the request\'s work in one transaction (one @Transactional around it) instead of one per DAO call.',
      impactMs: null, impact: `${f.detail?.['transactions'] ?? ''} commits`.trim(), count: plural(f.seqs.length, 'statement'), seqs: [...f.seqs], keys: f.seqs.map((q) => `s${q}`),
      chips: stmts(f.seqs).slice(0, 1).map((s) => chipOf(s, kindOf(s.seq))), source: 'TX_PER_STATEMENT', fingerprints: [],
    });
  }

  // ---- notes
  for (const f of ofType('CASCADE')) {
    const s = bySeq.get(f.seqs[0]);
    findings.push({
      id: `cascade-${f.seqs[0]}`, severity: 'note', icon: '⤵', title: `Delete cascades · ${f.detail?.['table'] ?? ''} → ${f.detail?.['children'] ?? 'children'}`,
      short: 'the database deleted more than this statement shows', why: `#${f.seqs[0]} deletes from ${f.detail?.['table'] ?? 'a table'} with ON DELETE CASCADE children (${f.detail?.['children'] ?? '?'}) - those rows are gone too, without a statement of their own.`,
      impactMs: null, impact: 'hidden deletes', count: '1 statement', seqs: [...f.seqs], keys: f.seqs.map((q) => `s${q}`),
      chips: s ? [chipOf(s, kindOf(s.seq))] : [], source: 'CASCADE', fingerprints: [],
    });
  }
  for (const f of ofType('BEFORE_NOT_CAPTURED')) {
    findings.push({
      id: 'before-not-captured', severity: 'note', icon: 'ⓘ', title: `${f.detail?.['count'] ?? f.seqs.length} writes have no before-image`,
      short: 'what they changed is not recorded',
      why: `${f.detail?.['deletes'] ?? 0} deletes and ${f.detail?.['updates'] ?? 0} updates changed rows Alfred did not read first, so their old values are unknown.`,
      fix: 'Add their tables to "Before-image tables" in Settings → Database capture.',
      impactMs: null, impact: '', count: plural(f.seqs.length, 'statement'), seqs: [...f.seqs], keys: f.seqs.map((q) => `s${q}`),
      chips: stmts(f.seqs).slice(0, CHIP_LIMIT).map((s) => chipOf(s, kindOf(s.seq))), source: 'BEFORE_NOT_CAPTURED', fingerprints: [],
    });
  }
  const byHost = new Map<string, TimelineSupplier[]>();
  for (const c of sup) byHost.set(c.host, [...(byHost.get(c.host) ?? []), c]);
  for (const [host, list] of byHost) {
    const failedCalls = list.filter((c) => c.failed);
    const chips = list.map((c) => ({ key: `c${c.seq}`, seq: c.seq, kind: 'sup' as const, n: `#${c.seq}`, label: `${host} · ${c.status ?? 'no answer'}`, ms: c.ms }));
    if (failedCalls.length) {
      findings.push({
        id: `supplier-failed-${host}`, severity: 'bad', icon: '🌐', title: `${host} failed ${failedCalls.length === 1 ? 'once' : `${failedCalls.length}×`}`,
        short: failedCalls.map((c) => c.status ?? 'no answer').join(', '),
        why: `${plural(failedCalls.length, 'call')} to ${host} ${failedCalls.length === 1 ? 'was' : 'were'} answered ${failedCalls.map((c) => `#${c.seq} ${c.status ?? 'with no response'}`).join(', ')}.`,
        fix: 'Open the call for its request and response.',
        impactMs: null, impact: 'supplier error', count: plural(failedCalls.length, 'call'), seqs: failedCalls.map((c) => c.seq), keys: failedCalls.map((c) => `c${c.seq}`),
        chips: chips.filter((c) => failedCalls.some((x) => x.seq === c.seq)), source: 'SUPPLIER_FAILED', fingerprints: [],
      });
    }
    const hostMs = union(list.map((c) => ({ start: c.atMs, end: c.atMs + c.ms, seq: c.seq }))).reduce((n, b) => n + b.end - b.start, 0);
    if (hostMs >= SUPPLIER_NOTE_MIN_MS || (totalMs && hostMs / totalMs >= SUPPLIER_NOTE_MIN_SHARE)) {
      const parallel = list.some((c) => c.row > 0);
      findings.push({
        id: `supplier-time-${host}`, severity: 'note', icon: '🌐', title: `${host} answered in ${fmtMs(Math.max(...list.map((c) => c.ms)))}`,
        short: `${plural(list.length, 'call')}${parallel && list.length > 1 ? ' in parallel' : ''}${failedCalls.length ? '' : list.length > 1 ? ', all OK' : ', OK'}`,
        why: `The call waited ${fmtMs(hostMs)} on ${host} - ${totalMs ? Math.round((hostMs / totalMs) * 100) : 0}% of it. That time is the supplier's, not this application's.`,
        impactMs: hostMs, impact: totalMs ? `${Math.round((hostMs / totalMs) * 100)}%` : fmtMs(hostMs), count: plural(list.length, 'call'),
        seqs: list.map((c) => c.seq), keys: list.map((c) => `c${c.seq}`), chips, source: 'SUPPLIER_TIME', fingerprints: [],
      });
    }
  }
  const counted = ordered.filter((s) => !isTxEnd(s)).length;
  if (baselineMs >= ROUND_TRIP_NOTE_MIN_MS && counted >= ROUND_TRIP_NOTE_MIN_STATEMENTS) {
    const paid = baselineMs * counted;
    findings.push({
      id: 'round-trip', severity: 'note', icon: '📡', title: `Database round trip ≈ ${Math.round(baselineMs)} ms`,
      short: `${counted} statements pay it - ≈ ${fmtMs(paid)}`,
      why: `Even this call's fastest statements take ≈ ${Math.round(baselineMs)} ms - the database is far from the application (network), not slow. Every statement pays it, so fewer statements is what helps here.`,
      impactMs: paid, impact: fmtMs(paid), count: plural(counted, 'statement'), seqs: [], keys: [], chips: [], source: 'ROUND_TRIP', fingerprints: [],
    });
  }

  const rank: Record<FindingSeverity, number> = { bad: 0, warn: 1, note: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.impactMs ?? -1) - (a.impactMs ?? -1));

  const appPct = totalMs ? Math.round((appMs / totalMs) * 100) : 0;
  const shares = [
    { pct: appPct, text: `${appPct}% inside the app` },
    { pct: totalMs ? Math.round((dbMs / totalMs) * 100) : 0, text: `${totalMs ? Math.round((dbMs / totalMs) * 100) : 0}% in the database` },
    { pct: totalMs ? Math.round((supplierMs / totalMs) * 100) : 0, text: `${totalMs ? Math.round((supplierMs / totalMs) * 100) : 0}% waiting on suppliers` },
  ].sort((a, b) => b.pct - a.pct);
  const longest = [...idle].sort((a, b) => b.ms - a.ms)[0];
  const detail = longest
    ? `${plural(idle.length, 'idle stretch', 'idle stretches')}, the longest ${fmtMs(longest.ms)} ${longest.beforeSeq != null ? `before #${longest.beforeSeq}` : 'at the end'}`
    : `DB ${fmtMs(dbMs)}${supplierMs ? ` · suppliers ${fmtMs(supplierMs)}` : ''} · ${plural(counted, 'statement')}`;
  return {
    totalMs, dbMs, supplierMs, appPct, baselineMs, idle, suppliers: sup, kinds, findings,
    summary: `${fmtMs(totalMs)} · ${shares[0].text} - ${detail}`,
    share: shares[0].text,
    detail,
    errors: findings.filter((f) => f.severity === 'bad').length,
    toFix: findings.filter((f) => f.severity === 'warn').length,
  };
}

/** A finding as exports carry it - no chips, the statements by `seqs`. */
export function findingSummary(f: DbFinding): DbFindingSummary {
  return { severity: f.severity, title: f.title, short: f.short, why: f.why, ...(f.fix ? { fix: f.fix } : {}), impactMs: f.impactMs == null ? null : Math.round(f.impactMs),
    impact: f.impact, count: f.count, seqs: f.seqs, source: f.source };
}

export function idleKey(g: IdleStretch): string {
  return g.beforeSeq != null ? `i${g.beforeSeq}` : `i-end${g.afterSeq}`;
}
