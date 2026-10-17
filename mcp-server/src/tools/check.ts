import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BoardRow } from '../board-scope.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient } from '../alfred-client.ts';
import { isErrorLine } from '../call-story.ts';
import { hydrate } from '../calls.ts';
import { cycleEntries, findCycle } from '../cycle-calls.ts';
import { dbSummaries, loadCapture } from '../db-capture.ts';
import { FlowIndex, parseBody, writtenColumns, type HopDiff, type Side } from '../flow-diff.ts';
import { areaOf } from './spacers.ts';
import {
  callTime, type CallDbSummary, type CallLogsPage, type CallRecord, type CallStatementFailures, type LinkedLogLine, type SessionCycle, type TriageEntry,
} from '../frontend.ts';
import { maskCall, maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { invalid, ok, REPLY_BUDGET, run, text } from '../reply.ts';
import { isError, lineKey, normaliseMessage, signalsOfEntry, type SignalName } from '../signals.ts';
import { outcomeOf, statementFailuresOf, triageOf } from '../triage.ts';
import { MaskSchema } from './cycles.ts';
import { maskLines } from './logs.ts';
import { evidence, headLine, hostOf, unavailableNote, unavailableNotes, type Item } from './triage.ts';
import { changesReply, parentsOf, type ChangesPage } from './board.ts';
import { liveAnswerer } from './live.ts';
import { blocking, finished, waitForCalls, type Wake, type Waited } from './watch.ts';

/**
 * check_calls (listen and review, rules "Batches"): every call of a cycle - or of the calls after `sinceCallId` -
 * checked in code, nothing skipped: its triage mark (HTTP, log, database, supplier and Redis signals, errors inside
 * 200s, empty results), slow against the same endpoint in the cycle, and the flows' hop diffs (a value that changed,
 * went missing or changed count between the calls that carry the same thing, including the rows they wrote).
 *
 * Built to stay as fast at call 9,000 as at call 50: the cycle is read incrementally, each call's bodies are parsed
 * once into a per-cycle index of small snapshots (never the bodies), flagged calls with the same problem come as one
 * group, groups are paged, and the sweep re-judges only what changed since it was checked.
 */

const SLOW_MS = 2_000;
const CONCURRENCY = 8;
const MAX_DIFFS_DEFAULT = 200;
/** A call's statements may arrive a moment after it ends: its writes are indexed once its capture is complete, or this long after. */
const WRITES_SETTLE_MS = 10_000;
/** A call checked less than this long after it ended is looked at again: its log lines, statements and supplier calls keep arriving for a while. */
const RECHECK_SETTLE_MS = 30_000;
/** A call with no triage mark this long after it ended will not get one. */
const MARK_WAIT_MS = 120_000;
/** Memory the snapshot indexes of all cycles may hold; the least recently used cycle's index is dropped (and rebuilt from Alfred when needed). */
const INDEX_BYTES_MAX = 256 * 1024 * 1024;
const MEMBERS_LISTED = 200;
/** Member call ids a group lists in the reply's JSON. */
const IDS_LISTED = 50;
/** Pages of a call's log lines read to find its first error / WARN line. */
const LOG_PAGES = 5;
const ERROR_LINES_WANTED = 3;
/** A call whose bodies could not be read is tried again in the next batches, this many times in all. */
const INDEX_TRIES = 3;
const STALE_LISTED = 10;
/** Calls whose time is remembered, for a sinceCallId that has left the cycle. */
const LAST_TIMES_KEPT = 50;

/** Everything a reply shows, worked out once on the first page and kept: a mark that changes between two pages must not move a group. */
interface Batch {
  /** What the window is: a later page with the same key shows these groups again, one with another key is worked out from scratch. */
  readonly key: string;
  readonly head: string;
  readonly cycleId: string;
  readonly recording: boolean;
  readonly lastCallId: string | null;
  readonly resumed: boolean;
  /** Calls judged (subject), the entries among them (heads), and the earlier calls reported again because their writes arrived. */
  readonly checked: number;
  readonly entries: number;
  readonly lateWrites: readonly number[];
  readonly hiddenOptions: number;
  /** A sweep: the calls it left alone because nothing changed since they were checked. */
  readonly unchanged: number | null;
  readonly rechecked: number;
  readonly flagged: readonly Flagged[];
  readonly groups: readonly Group[];
  readonly clean: readonly number[];
  readonly unmarked: readonly number[];
  readonly flows: readonly { callIds: readonly string[]; anchors: readonly string[] }[];
  readonly hopDiffs: number;
  readonly noBody: number;
  readonly indexFailed: number;
  readonly lines: LogLines;
  readonly failures: Record<string, CallStatementFailures>;
  readonly numberOf: ReadonlyMap<string, number>;
  readonly owner: ReadonlyMap<string, string>;
  readonly pending: readonly number[];
  readonly stale: readonly StaleRow[];
  readonly recheckPending: number;
  readonly diffsPending: number;
  readonly gaps: string;
  readonly captureGaps: readonly string[];
  /** Each call's request shape (field names and kinds, no values) - a fine verdict is re-judged when a new one shows. */
  readonly shapes: ReadonlyMap<string, string>;
  /** The batch's calls cut into actions (a pause or another area starts one) - for the judge, no change to the batch. */
  readonly actions: readonly Action[];
  readonly actionGapMs: number;
}

/** One user (or script) action: the calls it fired, and what started it. */
interface Action {
  readonly calls: readonly number[];
  readonly reason: string;
}

interface CycleMemory {
  /** Dropped (and rebuilt from Alfred) when all cycles together hold too much. */
  index: FlowIndex;
  /** Calls indexed without their writes yet (statements still arriving): their diffs are reported when they are. */
  readonly diffsPending: Set<string>;
  /** What each call looked like when it was checked - the sweep re-judges only calls whose mark changed since. */
  readonly checked: Map<string, string>;
  /**
   * Calls a batch checked before their capture had settled (no triage mark yet, or ended moments ago - log lines,
   * statements and supplier calls still arriving). Every later batch re-reads their marks and re-judges the ones that
   * changed, so listen sees what review sees without waiting for the sweep.
   */
  readonly recheck: Set<string>;
  /** Calls reported as never completed: each is a flagged group once, so it gets an outcome, and is only listed after. */
  readonly hungReported: Set<string>;
  /** Times the bodies of a call could not be read. */
  readonly indexTries: Map<string, number>;
  /** The time of the last call each reply returned: where to continue if that call is removed from the cycle. */
  readonly lastTimes: Map<string, number>;
  /** A check was made: calls that finished later than the window they sat in are the next batch's late-comers. */
  started: boolean;
  /** The first page of the last batch - the later pages of the same batch show it again. */
  page?: Batch;
  /** Each call's request shape, kept when the index is dropped (a few bytes a call). */
  readonly shapes: Map<string, string>;
}

const memory = new Map<string, CycleMemory>();

function memoryOf(client: AlfredClient, cycleId: string, listener?: string): CycleMemory {
  const key = `${client.baseUrl}|${cycleId}|${listener || 'shared'}`;
  let m = memory.get(key);
  if (m) {
    memory.delete(key); // most recently used last
  } else {
    m = {
      index: new FlowIndex(), diffsPending: new Set(), checked: new Map(), recheck: new Set(), hungReported: new Set(), indexTries: new Map(),
      lastTimes: new Map(), started: false, shapes: new Map(),
    };
  }
  memory.set(key, m);
  let total = [...memory.values()].reduce((sum, x) => sum + x.index.bytes, 0);
  for (const other of memory.values()) {
    if (total <= INDEX_BYTES_MAX || other === m) break;
    total -= other.index.bytes;
    // Dropping an index loses no diff: a later check re-reads those calls' bodies from Alfred and rebuilds it. Everything
    // else the memory holds (what was checked, the page) stays - the memory is changed in place, never copied.
    other.index = new FlowIndex();
  }
  return m;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

function endOf(call: CallRecord): number {
  return Date.parse(call.timestamp) + (call.duration_ms ?? 0);
}

/** A call's request and response bodies and the rows it wrote, as flow sides on one timeline. Throws when Alfred could not be asked. */
async function sidesOf(client: AlfredClient, cycleId: string, call: CallRecord, writes: boolean): Promise<Side[]> {
  const start = Date.parse(call.timestamp);
  // A call Alfred no longer has has no body; any other failure is for the caller to retry.
  const full = await hydrate(client, { id: call.id, source: call.source ?? 'internal', cycleId }, call)
    .catch((error) => { if (error instanceof AlfredError && error.kind === 'not_found') return call; throw error; });
  const sides: Side[] = [];
  const req = parseBody(full.request?.body);
  const res = parseBody(full.response?.body);
  const endpoint = endpointOf(call);
  if (req !== undefined) sides.push({ callId: call.id, kind: 'req', at: start, root: req, endpoint });
  if (res !== undefined) sides.push({ callId: call.id, kind: 'res', at: endOf(call), root: res, endpoint });
  if (writes) {
    const capture = await loadCapture(client, call.id)
      .catch((error) => { if (error instanceof AlfredError && error.kind === 'not_found') return null; throw error; });
    for (const st of capture?.statements ?? []) {
      if (!['INSERT', 'UPDATE', 'MERGE'].includes(st.kind)) continue;
      const cols = writtenColumns(st.sql);
      if (!cols) continue;
      for (const set of st.params) {
        const row: Record<string, string | null> = {};
        cols.columns.forEach((c, i) => { if (set[i]) row[c] = set[i].value; });
        sides.push({ callId: call.id, kind: 'db', at: start + st.offsetMicros / 1000, root: row, table: cols.table, endpoint });
      }
    }
  }
  return sides;
}

interface Indexed {
  /** Calls indexed with nothing to compare (no JSON/XML body, no written row). */
  noBody: number;
  /** Calls whose bodies Alfred could not give this time. */
  failed: number;
  /** The calls indexed by this run. */
  readonly fresh: Set<string>;
  /** Calls indexed earlier that now follow one of the fresh calls on a flow's timeline: their diffs against it are new. */
  readonly affected: Set<string>;
}

/**
 * Indexes the finished calls not indexed yet. A call whose statements may still be arriving is indexed later: it stays
 * out of the index (and in diffsPending) until its capture is complete or has had time to settle. A call whose bodies
 * could not be read stays out too and is tried again next batch - a few times, then it is indexed without.
 */
async function indexCalls(client: AlfredClient, cycleId: string, mem: CycleMemory, calls: readonly CallRecord[], now: number): Promise<Indexed> {
  const result: Indexed = { noBody: 0, failed: 0, fresh: new Set(), affected: new Set() };
  const todo = calls.filter((c) => finished(c) && c.method !== 'OPTIONS' && !mem.index.has(c.id));
  if (!todo.length) return result;
  const [summaries, projects] = await Promise.all([
    dbSummaries(client, todo.filter((c) => c.source === 'internal').map((c) => c.id)).catch(() => ({} as Record<string, CallDbSummary>)),
    client.get<{ project: string; enabled: boolean }[]>('/db-capture/projects').catch(() => [] as { project: string; enabled: boolean }[]),
  ]);
  const capturing = new Set(projects.filter((p) => p.enabled).map((p) => p.project));
  // "A while ago" on the cycle's own clock too: the newest call started well after this one ended.
  let latest = -Infinity;
  for (const c of calls) latest = Math.max(latest, Date.parse(c.timestamp));
  await mapLimit(todo, CONCURRENCY, async (c) => {
    const summary = summaries[c.id];
    const ended = endOf(c);
    const settled = !!summary?.complete || c.source !== 'internal' || !capturing.has(c.service_name ?? '')
      || now - ended > WRITES_SETTLE_MS || latest - ended > WRITES_SETTLE_MS;
    if (!settled) { mem.diffsPending.add(c.id); return; }
    let sides: Side[] = [];
    try {
      sides = await sidesOf(client, cycleId, c, (summary?.writeCount ?? 0) > 0);
      mem.indexTries.delete(c.id);
      const req = sides.find((x) => x.kind === 'req');
      const shape = req ? shapeOf(req.root) : null;
      if (shape) {
        mem.shapes.set(c.id, shape);
        if (mem.shapes.size > SHAPES_KEPT) mem.shapes.delete(mem.shapes.keys().next().value!);
      }
      if (!sides.length) result.noBody++;
    } catch {
      result.failed++;
      const tries = (mem.indexTries.get(c.id) ?? 0) + 1;
      mem.indexTries.set(c.id, tries);
      if (tries < INDEX_TRIES) return; // not indexed: its bodies are asked for again next batch
    }
    for (const id of mem.index.add(c.id, sides)) result.affected.add(id);
    result.fresh.add(c.id);
  });
  return result;
}

const SHAPES_KEPT = 50_000;

/**
 * A request body's shape: its field names (two levels deep) and whether each is a list, an object or a value - no
 * values, and a null field is left out (it matches anything). Two bodies of one shape carry the same kind of request;
 * old code sending `branchId` and new code sending `branchIds` have two.
 */
export function shapeOf(root: unknown): string | null {
  if (root === null || typeof root !== 'object') return null;
  if (Array.isArray(root)) return 'list';
  const parts: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string, depth: number) => {
    for (const key of Object.keys(node).sort()) {
      const v = node[key];
      if (v === null || v === undefined) continue;
      const p = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(v)) parts.push(`${p}:list`);
      else if (typeof v === 'object') {
        parts.push(`${p}:obj`);
        if (depth < 2) walk(v as Record<string, unknown>, p, depth + 1);
      } else parts.push(`${p}:val`);
    }
  };
  walk(root as Record<string, unknown>, '', 1);
  return createHash('sha1').update(parts.join(',')).digest('hex').slice(0, 10);
}

/** The pause that ends an action, learned from the cycle: 4 x the usual gap inside a burst, 250 ms to 3 s (3 s until 10 gaps). */
export function actionGap(calls: readonly CallRecord[]): number {
  const timeline = calls.filter((c) => c.source === 'internal' && c.method !== 'OPTIONS').map((c) => ({ start: callTime(c), end: endOf(c) }))
    .sort((a, b) => a.start - b.start);
  const gaps: number[] = [];
  let lastEnd = -Infinity;
  for (const t of timeline) {
    const gap = t.start - lastEnd;
    if (Number.isFinite(gap) && gap >= 0 && gap < 3_000) gaps.push(gap);
    lastEnd = Math.max(lastEnd, t.end);
  }
  if (gaps.length < 10) return 3_000;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(3_000, Math.max(250, Math.round(4 * median)));
}

/** The batch's inbound calls cut into actions: a pause of at least `gapMs` since the calls before it ended, or another area. */
export function actionsOf(window: readonly CallRecord[], before: readonly CallRecord[], gapMs: number,
                          numberOf: ReadonlyMap<string, number>): Action[] {
  const inbound = (c: CallRecord) => c.source === 'internal' && c.method !== 'OPTIONS' && numberOf.has(c.id);
  const calls = window.filter(inbound).sort((a, b) => callTime(a) - callTime(b));
  if (!calls.length) return [];
  let lastEnd = -Infinity;
  let lastArea: string | null = null;
  for (const c of before.filter(inbound)) {
    if (callTime(c) > callTime(calls[0])) continue;
    lastEnd = Math.max(lastEnd, endOf(c));
    lastArea = areaOf(c) ?? lastArea;
  }
  const out: { calls: number[]; reason: string }[] = [];
  for (const c of calls) {
    const area = areaOf(c);
    const gap = callTime(c) - lastEnd;
    const reason = !out.length ? (Number.isFinite(gap) ? `${pause(gap)} pause` : 'first call')
      : gap >= gapMs ? `${pause(gap)} pause` : area && lastArea && area !== lastArea ? `area ${area}` : null;
    if (reason) out.push({ calls: [], reason });
    out[out.length - 1].calls.push(numberOf.get(c.id)!);
    lastEnd = Math.max(lastEnd, endOf(c));
    lastArea = area ?? lastArea;
  }
  return out;
}

function pause(ms: number): string {
  return ms < 1_000 ? `${Math.max(0, Math.round(ms))} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** "POST /api/bookings/:id" - one endpoint, whatever the ids in its path. */
function endpointOf(call: CallRecord): string {
  let path = call.original_url || call.url;
  try { path = new URL(path).pathname; } catch { /* keep as is */ }
  // any all-digit segment (/item/5), and longer ones holding a digit (/ODY-482, a UUID)
  return `${call.method} ${path.replace(/\/(?:\d+|(?=[^/]*\d)[^/]{3,})(?=\/|$)/g, '/:id')}`;
}

type Medians = ReadonlyMap<string, { median: number; samples: number }>;

/** The usual duration of each endpoint among these calls. */
function mediansOf(calls: readonly CallRecord[]): Medians {
  const durations = new Map<string, number[]>();
  for (const c of calls) {
    if (c.duration_ms == null) continue;
    const k = endpointOf(c);
    const list = durations.get(k);
    if (list) list.push(c.duration_ms); else durations.set(k, [c.duration_ms]);
  }
  return new Map([...durations].map(([k, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return [k, { median: sorted[Math.floor(sorted.length / 2)], samples: sorted.length }];
  }));
}

function slowNote(call: CallRecord, medians: Medians): string | null {
  const d = call.duration_ms;
  if (d == null) return null;
  const m = medians.get(endpointOf(call));
  if (d >= SLOW_MS) return `⏱ ${Math.round(d)} ms (over ${SLOW_MS / 1000} s${m && m.samples >= 3 ? `, usual ${Math.round(m.median)} ms` : ''})`;
  if (m && m.samples >= 3 && d >= 500 && d >= 3 * m.median) return `⏱ ${Math.round(d)} ms (${Math.round(d / m.median)}× the usual ${Math.round(m.median)} ms of this endpoint in the cycle)`;
  return null;
}

function ranges(numbers: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    out.push(j > i + 1 ? `#${numbers[i]}-#${numbers[j]}` : j === i + 1 ? `#${numbers[i]} #${numbers[j]}` : `#${numbers[i]}`);
    i = j;
  }
  return out.join(' ');
}

function diffLine(ctx: MaskContext, d: HopDiff, numberOf: ReadonlyMap<string, number>): string {
  const n = (id: string) => (numberOf.has(id) ? `#${numberOf.get(id)}` : `id=${id}`);
  return `    Δ ${d.kind} ${d.key}: ${maskText(ctx, d.from.value)} (${n(d.from.callId)} ${d.from.side} ${maskText(ctx, d.from.path)})`
    + ` → ${maskText(ctx, d.to.value)} (${n(d.to.callId)} ${d.to.side} ${maskText(ctx, d.to.path)}) via ${maskText(ctx, d.anchor)}`;
}

/** What a call's mark says, as a string - a change of it after a check means the call needs judging again. */
function markSignature(entry: TriageEntry | null, call: CallRecord): string {
  if (!entry) return `nomark|${call.response?.status ?? ''}|${call.error ?? ''}`;
  const s = entry.signals ?? {};
  return [entry.status, entry.error, entry.failedStatements, entry.failingSupplierCalls.length, entry.softFailure?.code ?? entry.softFailure?.message ?? '',
    entry.emptyKeys.length, s.logErrors ?? 0, s.logWarnings ?? 0, s.logExceptions ?? 0, (s.dbFlags ?? []).join(','), s.redisFailed ?? 0, s.redisCold ?? 0].join('|');
}

/** The mark and whether the call is slow now: a call that became slow (the cycle's median moved, a duration arrived) needs judging again. */
function signatureOf(entry: TriageEntry | null, call: CallRecord, medians: Medians): string {
  return `${markSignature(entry, call)}|${slowNote(call, medians) ? 'slow' : ''}`;
}

/** Still taking in log lines, statements and supplier calls (ended moments ago on either clock), or waiting for the mark it may still get. */
function settling(call: CallRecord, marked: boolean, now: number, latestStart: number): boolean {
  if (call.method === 'OPTIONS') return false;
  const age = Math.max(now - endOf(call), latestStart - endOf(call));
  return age < RECHECK_SETTLE_MS || (!marked && age < MARK_WAIT_MS);
}

/** The first error and WARN lines of the calls that logged some - raw, masked only when shown. */
interface LogLines {
  readonly errors: ReadonlyMap<string, LinkedLogLine[]>;
  readonly warns: ReadonlyMap<string, LinkedLogLine[]>;
}

const isWarnLine = (l: LinkedLogLine) => ['WARN', 'WARNING'].includes((l.level ?? '').toUpperCase());

/**
 * The first error lines and the first WARN line of each call that logged some - bounded, so 500 flagged calls are not
 * 500 requests at once, and a call is read page by page (up to LOG_PAGES) until it has what is wanted of it.
 */
async function logLinesOf(client: AlfredClient, entries: readonly TriageEntry[], cycleId: string): Promise<LogLines> {
  const errors = new Map<string, LinkedLogLine[]>();
  const warns = new Map<string, LinkedLogLine[]>();
  const wanted = entries.filter((e) => (e.signals?.logErrors ?? 0) > 0 || (e.signals?.logExceptions ?? 0) > 0 || (e.signals?.logWarnings ?? 0) > 0);
  await mapLimit(wanted, CONCURRENCY, async (e) => {
    const wantErrors = (e.signals?.logErrors ?? 0) > 0 || (e.signals?.logExceptions ?? 0) > 0;
    const wantWarn = (e.signals?.logWarnings ?? 0) > 0;
    const errs: LinkedLogLine[] = [];
    const warnLines: LinkedLogLine[] = [];
    let after: string | undefined;
    let read = false;
    for (let n = 0; n < LOG_PAGES; n++) {
      const page = await client.get<CallLogsPage>(`/call-logs/${seg(e.callId)}`, { query: { cycleId, limit: 500, after } }).catch(() => null);
      if (!page) break;
      read = true;
      for (const l of page.lines) {
        if (isErrorLine(l)) errs.push(l);
        if (isWarnLine(l)) warnLines.push(l);
      }
      if (!page.next || ((!wantErrors || errs.length >= ERROR_LINES_WANTED) && (!wantWarn || warnLines.length > 0))) break;
      after = page.next;
    }
    if (read) {
      errors.set(e.callId, errs);
      warns.set(e.callId, warnLines);
    }
  });
  return { errors, warns };
}

interface Flagged {
  readonly call: CallRecord;
  readonly entry: TriageEntry | null;
  readonly signals: SignalName[];
  readonly slow: string | null;
  readonly diffs: HopDiff[];
  /** Still running long after it started, and passed over: it never completed. */
  readonly hung?: boolean;
}

interface Group {
  readonly key: string;
  /** The key, short: a group that comes back in a later batch is found by it. */
  readonly hash: string;
  readonly members: Flagged[];
  readonly severity: number;
}

/** A supplier call's outcome as grouping reads it: a transport error's message with its numbers and ids set aside. */
function outcomeKey(s: TriageEntry['failingSupplierCalls'][number]): string {
  return s.error ? `ERROR ${normaliseMessage(s.error)}` : outcomeOf(s);
}

/**
 * The same problem on many calls is one group: same endpoint, same exact status, same signals, same error (logger,
 * exception, message with its numbers and ids set aside), same WARN, same failing supplier outcome, same database flags,
 * same failing statement, same soft failure, same hop-diff keys, same slowness. Anything different - one more signal,
 * another error, a 400 where the rest are 500 - is another group, so a group never hides a second problem.
 */
function groupKey(f: Flagged, lines: LogLines, failures: Record<string, CallStatementFailures>): string {
  const id = f.call.id;
  const e = f.entry;
  const firstError = lines.errors.get(id)?.[0];
  const firstWarn = (e?.signals?.logWarnings ?? 0) > 0 ? lines.warns.get(id)?.[0] : undefined;
  const failed = failures[id]?.statements[0];
  const status = e ? (e.error ? `noanswer:${normaliseMessage(e.error)}` : String(e.status ?? ''))
    : `${f.call.response?.status ?? ''}|${f.call.error ?? ''}`;
  const suppliers = e ? [...new Set(e.failingSupplierCalls.map((s) => `${hostOf(s.url)}:${outcomeKey(s)}:${s.softFailure?.code ?? ''}`))].sort().join(',') : '';
  const soft = e?.softFailure ? `${e.softFailure.kind}:${e.softFailure.code ?? ''}${e.softFailure.code ? '' : `:${normaliseMessage(e.softFailure.message)}`}` : '';
  return [
    endpointOf(f.call),
    status,
    f.signals.join(','),
    suppliers,
    [...(e?.signals?.dbFlags ?? [])].sort().join(','),
    soft,
    e?.emptyKeys.length ? `empty:${e.emptyKeys.join(',')}` : '',
    firstError ? lineKey(firstError) : '',
    firstWarn ? lineKey(firstWarn) : '',
    failed ? `${failed.kind}:${failed.table ?? ''}:${failed.sqlState ?? ''}` : '',
    [...new Set(f.diffs.map((d) => `${d.kind}:${d.key}`))].sort().join(','),
    f.slow ? 'slow' : '',
    e ? '' : 'nomark',
    f.hung ? 'hung' : '',
  ].join('¦');
}

function severityOf(f: Flagged): number {
  if (f.hung || f.signals.some(isError) || (!f.entry && ((f.call.response?.status ?? 0) >= 400 || f.call.error))) return 0;
  if (f.diffs.length || f.entry?.softFailure) return 1;
  if (f.signals.length || f.entry?.emptyKeys.length) return 2;
  return 3;
}

/** A changed value or count is a lead; a missing key is often just a shorter message - the leads come first when the lines run out. */
const diffRank = (d: HopDiff) => (d.kind === 'missing' ? 1 : 0);

/** The group's diffs, each distinct one once (with how many of the group's calls carry it), leads first. */
function distinctDiffs(members: readonly Flagged[]): { diff: HopDiff; calls: number }[] {
  const seen = new Map<string, { diff: HopDiff; calls: number }>();
  for (const m of members) {
    const mine = new Set<string>();
    for (const d of m.diffs) {
      const k = `${d.kind}|${d.key}|${d.from.value}|${d.to.value}`;
      if (mine.has(k)) continue;
      mine.add(k);
      const known = seen.get(k);
      if (known) known.calls++; else seen.set(k, { diff: d, calls: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => diffRank(a.diff) - diffRank(b.diff));
}

/** The user's changes on a cycle's board after a cursor - board_changes by USER, folded into a listen batch. */
async function boardChanges(client: AlfredClient, ctx: MaskContext, cycleId: string, cursor: string): Promise<Record<string, unknown>> {
  try {
    const page = await client.get<ChangesPage>('/board/changes', { query: { cursor, cycleId, actor: 'USER', limit: 50 } });
    const reply = changesReply(ctx, page, await parentsOf(client, page));
    const live = page.entries.length ? await liveAnswerer(client, page.entries[0].project) : null;
    return { ...reply, ...(live ? { live: '/alfred-live is answering the user - only note these changes' } : {}) };
  } catch (error) {
    return { error: `board changes not read: ${(error as Error).message}`, cursor };
  }
}

/** Tests: drop every cycle's snapshot index (as the memory cap would), keeping what was checked. */
export function dropIndexesForTests(): void {
  for (const m of memory.values()) m.index = new FlowIndex();
}

const inputShape = {
  cycle: z.string().min(1).describe('Cycle id or text from its name'),
  sinceCallId: z.string().optional().describe('Check only the calls after this one (the previous reply\'s lastCallId)'),
  untilCallId: z.string().optional().describe('Check only up to this call - pass the first page\'s lastCallId when paging, so the window stays put'),
  sweep: z.boolean().default(false).describe('The whole cycle, but only calls never checked or whose mark changed since (late log lines, statements) - listen\'s last step'),
  offset: z.number().int().min(0).default(0).describe('The first group to show (the previous page\'s next)'),
  limit: z.number().int().min(1).max(100).default(15).describe('Groups per page'),
  minStatus: z.number().int().min(300).max(600).default(400).describe('A status at or over this is an error (400 by default)'),
  hopDiffs: z.boolean().default(true).describe('Compare the values calls carry between them (reads bodies and written rows in Alfred, not in the reply)'),
  maxDiffs: z.number().int().min(1).max(200).default(MAX_DIFFS_DEFAULT).describe('Hop-diff lines shown on this page'),
  includeOptions: z.boolean().default(false),
  waitSec: z.number().int().min(0).max(60).default(0).describe('Listen in one call: with sinceCallId, first wait up to this long for new calls '
    + '(returning once none came for settleSec) or for the late log lines / SQL of a call still settling - then check. 0 = check now'),
  settleSec: z.number().int().min(0).max(30).default(5).describe('With waitSec: the pause that ends a burst of calls'),
  boardCursor: z.string().max(100).optional().describe('Also return what the user changed on this cycle\'s board after this cursor ("now" to start) - '
    + 'the same as board_changes by USER; pass the returned board.cursor next time. With waitSec the user\'s comment ends the wait too'),
  listener: z.string().max(100).optional().describe('Who is listening: what was checked and what is still settling is remembered per listener ("shared" by default), '
    + 'so two listeners on one cycle - a runner and a session - each see every call'),
  mask: MaskSchema,
};

type CheckInput = z.infer<z.ZodObject<typeof inputShape>>;

/** A call that is still running long after it started: where it sits, so the batch can say it never completed. */
interface StaleRow {
  readonly callId: string;
  readonly number: number;
  readonly endpoint: string;
  readonly startedAt: string;
  readonly ageSec: number;
}

/**
 * The wait of a listen batch: for new calls (until none came for settleSec), for the late log lines / statements of a
 * call checked too early, for a call that was still waiting for its writes to settle, and - with a board cursor - for the
 * user's comment. Returns at once when one of the late things already happened.
 */
async function listenWait(client: AlfredClient, cycle: SessionCycle, mem: CycleMemory, input: CheckInput): Promise<Waited> {
  const known = await cycleEntries(client, cycle.id);
  const callOf = new Map(known.map((e) => [e.call.id, e.call]));
  const medians = mediansOf(known.map((e) => e.call).filter((c) => input.includeOptions || c.method !== 'OPTIONS'));
  const recheckIds = [...mem.recheck].filter((id) => callOf.has(id));
  // only the calls the next batch will reach: one behind a call that is still running is not indexed before that ends
  const cutAt = known.findIndex((e) => blocking(e.call, client.now()));
  const writeIds = input.hopDiffs ? known.slice(0, cutAt < 0 ? known.length : cutAt).map((e) => e.call.id).filter((id) => mem.diffsPending.has(id)) : [];
  const wakes: Wake[] = [];
  // a call checked too early whose log lines / statements arrived since: no reason to wait
  const marksChanged = async () => {
    if (!recheckIds.length) return false;
    const marks = await triageOf(client, recheckIds, input.minStatus).catch(() => ({} as Record<string, TriageEntry>));
    return recheckIds.some((id) => mem.checked.get(id) !== signatureOf(marks[id] ?? null, callOf.get(id)!, medians));
  };
  // a call whose writes were still arriving is indexed once its capture is complete, or has had time to settle
  const writesSettled = async () => {
    if (!writeIds.length) return false;
    const nowMs = client.now();
    if (writeIds.some((id) => nowMs - endOf(callOf.get(id)!) > WRITES_SETTLE_MS)) return true;
    const summaries = await dbSummaries(client, writeIds).catch(() => ({} as Record<string, CallDbSummary>));
    return writeIds.some((id) => summaries[id]?.complete);
  };
  if (recheckIds.length || writeIds.length) {
    const nowMs = client.now();
    wakes.push({
      sockets: ['/ws/triage', '/ws/db-capture'],
      changed: async () => (await marksChanged()) || (await writesSettled()),
      // settling by the clock sends no signal: ask again when the first of them has had its time
      ...(writeIds.length ? { afterMs: Math.max(0, Math.min(...writeIds.map((id) => endOf(callOf.get(id)!) + WRITES_SETTLE_MS + 1 - nowMs))) } : {}),
      label: 'late log lines / SQL arrived',
    });
  }
  if (input.boardCursor !== undefined) {
    // "now" moves with every ask: pin it to where the board is as the wait begins
    let cursor = input.boardCursor;
    if (cursor === 'now') {
      cursor = await client.get<ChangesPage>('/board/changes', { query: { cursor, cycleId: cycle.id, actor: 'USER', limit: 1 } }).then((p) => p.cursor ?? cursor).catch(() => cursor);
    }
    wakes.push({
      sockets: ['/ws/board'],
      changed: async () => (await client.get<ChangesPage>('/board/changes', { query: { cursor, cycleId: cycle.id, actor: 'USER', limit: 1 } })).entries.length > 0,
      label: 'the board changed',
    });
  }
  for (const w of wakes) {
    if (await w.changed().catch(() => false)) {
      return { newEntries: [], total: known.length, timedOut: false, recording: cycle.status === 'RECORDING', matched: [], ...(w.label ? { woke: w.label } : {}) };
    }
  }
  // a call running now that finishes counts as new even when it sits before sinceCallId (a stale one, or one a review passed over)
  const watch = new Set(known.filter((e) => !finished(e.call)).map((e) => e.call.id));
  return waitForCalls(client, cycle.id, input.sinceCallId, input.waitSec * 1000, 'any', input.settleSec * 1000, wakes, { watch, minStatus: input.minStatus });
}

/** Where a window is and what is in it - the cheap part of a check, no request but the cycle's own read. */
interface Scope {
  readonly all: readonly { readonly call: CallRecord }[];
  readonly byId: ReadonlyMap<string, CallRecord>;
  readonly numberOf: ReadonlyMap<string, number>;
  readonly medians: Medians;
  /** Alfred's clock. */
  readonly now: number;
  readonly endAt: number;
  readonly latestStart: number;
  readonly head: string;
  readonly resumed: boolean;
  readonly cycle: SessionCycle;
  readonly key: string;
  readonly windowCalls: readonly CallRecord[];
  readonly recheckCalls: readonly CallRecord[];
  /** Never completed and not reported before. */
  readonly hungNew: readonly CallRecord[];
  readonly stale: readonly StaleRow[];
  readonly pending: readonly number[];
  readonly hiddenOptions: number;
  readonly lastCallId: string | null;
}

/** Worked out from scratch: the marks, the hop diffs, the groups. `judgeAll`: a sweep's later page that lost its first page re-judges the whole window. */
async function computeBatch(client: AlfredClient, input: CheckInput, mem: CycleMemory, s: Scope, judgeAll: boolean): Promise<Batch> {
  const { all, numberOf, medians, now } = s;
  const sigOf = (c: CallRecord, mark: TriageEntry | null | undefined) => signatureOf(mark ?? null, c, medians);
  const marks = await triageOf(client, [...s.windowCalls, ...s.recheckCalls, ...s.hungNew].map((c) => c.id), input.minStatus)
    .catch(() => ({} as Record<string, TriageEntry>));
  // A call checked early whose mark changed since (a log line, a statement, a supplier call arrived late) is judged again now.
  const rechecked = s.recheckCalls.filter((c) => mem.checked.get(c.id) !== sigOf(c, marks[c.id]));
  // The sweep: only what was never checked, or whose mark changed since (a log line or statement that arrived late), or is still settling.
  const subject = input.sweep && !judgeAll
    ? s.windowCalls.filter((c) => mem.checked.get(c.id) !== sigOf(c, marks[c.id]) || mem.diffsPending.has(c.id) || mem.recheck.has(c.id))
    : [...s.windowCalls, ...rechecked];
  const subjectIds = new Set(subject.map((c) => c.id));
  const inboundIds = new Set(subject.filter((c) => c.source === 'internal').map((c) => c.id));
  const parentOf = (c: CallRecord) => marks[c.id]?.parentCallId ?? c.parentCallId ?? null;
  // A supplier call of an inbound call in this batch is evidence under that call (as triage shows it): its mark is in
  // its parent's failingSupplierCalls, and its hop diffs are shown under the parent.
  const owner = new Map(subject.map((c) => [c.id, c.source !== 'internal' && inboundIds.has(parentOf(c) ?? '') ? parentOf(c)! : c.id]));
  const heads = subject.filter((c) => owner.get(c.id) === c.id);

  // hop diffs: index what is new (each call once), then compare this batch - and calls whose writes arrived since,
  // and calls that now follow a call indexed late - against everything indexed before them
  let diffs: HopDiff[] = [];
  let flows: Batch['flows'] = [];
  let noBody = 0;
  let indexFailed = 0;
  if (input.hopDiffs) {
    const upTo = all.slice(0, s.endAt).map((e) => e.call);
    const wasPending = new Set(mem.diffsPending);
    mem.diffsPending.clear();
    const indexed = await indexCalls(client, s.cycle.id, mem, upTo, now);
    noBody = indexed.noBody;
    indexFailed = indexed.failed;
    const later = new Set([...wasPending].filter((id) => mem.index.has(id)));
    const reported = new Set([...subjectIds, ...later, ...indexed.affected]);
    // A call that only follows a call indexed late keeps what that call added - not the diffs it was already reported with. A call
    // indexed late is one that is new to the judging, or was waiting for its writes: not one re-indexed after the index was dropped
    // or in a new process, whose place in the flow was judged long ago.
    const indexedLate = (id: string) => indexed.fresh.has(id) && (later.has(id) || !mem.checked.has(id));
    diffs = mem.index.diffsFor(reported).filter((d) => subjectIds.has(d.to.callId) || later.has(d.to.callId) || indexedLate(d.from.callId));
    flows = mem.index.flowsFor(subject.map((c) => c.id));
    // a call whose writes arrived since an earlier batch is reported again, with its diffs
    for (const id of new Set([...later, ...indexed.affected])) {
      const call = s.byId.get(id);
      if (!call || !mem.index.has(id) || owner.has(id) || !numberOf.has(id)) continue;
      if (diffs.some((d) => d.to.callId === id)) {
        owner.set(id, id);
        heads.push(call);
      }
    }
  }
  const lateHeads = heads.filter((c) => !subjectIds.has(c.id));
  const late = lateHeads.filter((c) => !(c.id in marks)).map((c) => c.id);
  if (late.length) Object.assign(marks, await triageOf(client, late, input.minStatus).catch(() => ({})));
  const diffsOf = new Map<string, HopDiff[]>();
  for (const d of diffs) {
    const at = owner.get(d.to.callId) ?? d.to.callId;
    const list = diffsOf.get(at);
    if (list) list.push(d); else diffsOf.set(at, [d]);
  }
  for (const list of diffsOf.values()) list.sort((a, b) => diffRank(a) - diffRank(b));

  const flagged: Flagged[] = [];
  const clean: number[] = [];
  const unmarked: number[] = [];
  for (const c of heads) {
    const entry = marks[c.id] ?? null;
    const signals = entry ? signalsOfEntry(entry, input.minStatus) : [];
    let problem = false;
    if (entry) {
      problem = signals.length > 0 || !!entry.softFailure || (entry.emptyKeys.length > 0 && c.source === 'internal') || entry.failingSupplierCalls.length > 0;
    } else {
      unmarked.push(numberOf.get(c.id)!);
      problem = (c.response?.status ?? 0) >= input.minStatus || !!c.error;
    }
    const slow = slowNote(c, medians);
    const own = diffsOf.get(c.id) ?? [];
    if (problem || slow || own.length) flagged.push({ call: c, entry, signals, slow, diffs: own });
    else clean.push(numberOf.get(c.id)!);
  }
  // A call that never completed is a finding of its own - reported once, so it gets an outcome and is not asked about again.
  for (const c of s.hungNew) {
    flagged.push({ call: c, entry: marks[c.id] ?? null, signals: [], slow: null, diffs: [], hung: true });
    mem.hungReported.add(c.id);
  }
  for (const c of subject) mem.checked.set(c.id, sigOf(c, marks[c.id]));
  // Still settling (no mark yet, or ended moments ago on both clocks): look again next batch; settled: done with it.
  for (const c of [...s.windowCalls, ...s.recheckCalls]) {
    if (settling(c, !!marks[c.id], now, s.latestStart)) mem.recheck.add(c.id); else mem.recheck.delete(c.id);
  }

  const entriesOf = flagged.map((f) => f.entry).filter((e): e is TriageEntry => !!e);
  const failures = await statementFailuresOf(client, entriesOf.filter((e) => e.failedStatements > 0).map((e) => e.callId))
    .catch(() => ({} as Record<string, CallStatementFailures>));
  const lines = await logLinesOf(client, entriesOf, s.cycle.id);

  const byKey = new Map<string, Flagged[]>();
  for (const f of flagged) {
    const k = groupKey(f, lines, failures);
    const members = byKey.get(k);
    if (members) members.push(f); else byKey.set(k, [f]);
  }
  const groups: Group[] = [...byKey].map(([key, members]) => ({
    key, hash: createHash('sha1').update(key).digest('hex').slice(0, 12), members, severity: severityOf(members[0]),
  })).sort((a, b) => a.severity - b.severity || b.members.length - a.members.length
    || (numberOf.get(a.members[0].call.id) ?? 0) - (numberOf.get(b.members[0].call.id) ?? 0));

  const upTo = all.slice(0, s.endAt).map((e) => e.call);
  const actionGapMs = actionGap(upTo);
  const actions = actionsOf(heads, upTo.filter((c) => !subjectIds.has(c.id)), actionGapMs, numberOf);
  const itemOf = (c: CallRecord, entry: TriageEntry | null) => ({ label: '', entry, call: c }) as Item;
  const gaps = await unavailableNote(client, flagged.map((f) => itemOf(f.call, f.entry)));
  const captureGaps = await unavailableNotes(client, heads.map((c) => itemOf(c, marks[c.id] ?? null)));
  mem.started = true;

  return {
    key: s.key, head: s.head, cycleId: s.cycle.id, recording: s.cycle.status === 'RECORDING', lastCallId: s.lastCallId, resumed: s.resumed,
    checked: subject.length, entries: heads.length - lateHeads.length, lateWrites: lateHeads.map((c) => numberOf.get(c.id)!),
    hiddenOptions: s.hiddenOptions, unchanged: input.sweep ? s.windowCalls.length - subject.length : null, rechecked: rechecked.length,
    flagged, groups, clean, unmarked, flows, hopDiffs: diffs.length, noBody, indexFailed, lines, failures, numberOf, owner,
    pending: s.pending, stale: s.stale, recheckPending: mem.recheck.size, diffsPending: mem.diffsPending.size, gaps, captureGaps,
    shapes: mem.shapes, actions, actionGapMs,
  };
}

/** One page of a batch: the header, the groups from `offset` (as many as fit), and - on the first page - the rest of the picture. */
async function renderPage(ctx: MaskContext, input: CheckInput, b: Batch, extra: { board: Record<string, unknown> | null; waited: Waited | null }): Promise<string> {
  const { groups, numberOf } = b;
  const supplierCalls = b.checked - b.entries;
  const inside = [`${b.entries} entries`];
  if (supplierCalls) inside.push(`${supplierCalls} supplier calls under them`);
  if (b.lateWrites.length) inside.push(`${b.lateWrites.length} earlier call${b.lateWrites.length === 1 ? '' : 's'} reported again (their writes arrived)`);
  if (b.hiddenOptions) inside.push(`${b.hiddenOptions} OPTIONS skipped`);
  if (b.unchanged !== null) inside.push(`${b.unchanged} unchanged since checked`);
  const out: string[] = [
    `${b.head}: ${b.checked} checked (${inside.join(', ')})`
      + ` - ${b.flagged.length} flagged in ${groups.length} group${groups.length === 1 ? '' : 's'}, ${b.clean.length} clean`
      + `${b.pending.length ? `, ${b.pending.length} still running (next time)` : ''}`
      + `${b.rechecked ? ` - ${b.rechecked} earlier call${b.rechecked === 1 ? '' : 's'} re-judged (logs / SQL arrived late)` : ''}`
      + b.gaps,
    '',
  ];
  let size = out.join('\n').length + 1_500;
  let diffsShown = 0;
  const shownGroups: Record<string, unknown>[] = [];
  let next: number | null = null;
  const page = groups.slice(input.offset, input.offset + input.limit);
  if (groups.length) {
    out.push(`Flagged (${b.flagged.length} calls in ${groups.length} groups${input.offset ? `, from group ${input.offset + 1}` : ''}) - each group needs one outcome: a card (linking all its calls), a link to a card, asked, or fine with the reason:`);
  }
  for (let gi = 0; gi < page.length; gi++) {
    const g = page[gi];
    const id = `G${input.offset + gi + 1}`;
    const example = g.members[0];
    const nums = g.members.map((m) => numberOf.get(m.call.id)!).sort((a, b) => a - b);
    const item: Item = { label: `#${numberOf.get(example.call.id)}`, entry: example.entry, call: maskCall(ctx, example.call) };
    // the log lines of the example, masked now (the first page may have been asked for with other masking)
    const errors = new Map<string, LinkedLogLine[]>();
    const warns = new Map<string, LinkedLogLine[]>();
    const rawErrors = b.lines.errors.get(example.call.id);
    const rawWarns = b.lines.warns.get(example.call.id);
    if (rawErrors) errors.set(example.call.id, maskLines(ctx, example.call.id, rawErrors));
    if (rawWarns) warns.set(example.call.id, maskLines(ctx, example.call.id, rawWarns));
    const block = [
      `${id} · ${g.members.length} call${g.members.length === 1 ? '' : 's'} · ${endpointOf(example.call)}${example.signals.length ? ` · ${example.signals.join(', ')}` : ''}${example.hung ? ' · never completed' : ''}`,
      `  ${headLine(ctx, item)}`,
      ...(await evidence(ctx, item, numberOf, b.failures, errors, warns)),
    ];
    if (example.slow) block.push(`    ${example.slow}`);
    const distinct = distinctDiffs(g.members);
    const room = Math.max(0, input.maxDiffs - diffsShown);
    // 200 lines are allowed, the reply is not that long: the lines stop where it is full (five at least, for the first group)
    let diffChars = 0;
    let listedDiffs = 0;
    for (const { diff, calls } of distinct.slice(0, room)) {
      const line = `${diffLine(ctx, diff, numberOf)}${calls > 1 ? ` · ${calls} calls` : ''}`;
      if (listedDiffs >= 5 && size + block.join('\n').length + diffChars + line.length + 400 > REPLY_BUDGET) break;
      block.push(line);
      diffChars += line.length + 1;
      listedDiffs++;
    }
    diffsShown += listedDiffs;
    if (distinct.length > listedDiffs) {
      block.push(`    … ${distinct.length - listedDiffs} more hop diffs - ${listedDiffs === room ? (input.maxDiffs < 200 ? 'check_calls with a higher maxDiffs' : 'the limit of 200')
        : 'the reply is full: a narrower window (sinceCallId / untilCallId) shows them'}`);
    }
    if (g.members.length > 1) {
      const listed = nums.length > MEMBERS_LISTED ? `${ranges(nums.slice(0, MEMBERS_LISTED))} … +${nums.length - MEMBERS_LISTED} more (last #${nums.at(-1)})` : ranges(nums);
      block.push(`  all ${g.members.length}: ${listed}`);
    }
    const json = {
      group: id, key: g.hash, calls: nums.length > MEMBERS_LISTED ? `${nums.length} calls, #${nums[0]}..#${nums.at(-1)}` : nums,
      callIds: g.members.slice(0, IDS_LISTED).map((m) => m.call.id), exampleCallId: example.call.id, endpoint: endpointOf(example.call),
      severity: g.severity, signals: example.signals,
      shapes: [...new Set(g.members.map((m) => b.shapes.get(m.call.id)).filter((x): x is string => !!x))].slice(0, 5),
    };
    const blockSize = block.join('\n').length + 1 + JSON.stringify(json).length + 1;
    if (gi > 0 && size + blockSize > REPLY_BUDGET) { next = input.offset + gi; break; }
    out.push(...block);
    size += blockSize;
    shownGroups.push(json);
  }
  if (next === null && input.offset + page.length < groups.length) next = input.offset + page.length;
  if (next !== null) out.push(`  … groups ${next + 1}-${groups.length} on the next page: check_calls with offset ${next}${b.lastCallId ? ` and untilCallId ${b.lastCallId}` : ''}`);
  if (input.offset === 0) {
    if (b.flows.length) {
      out.push('', `Flows (${b.flows.length}) - calls linked by the values they carry:`);
      for (const f of b.flows.slice(0, 10)) {
        const ns = f.callIds.map((cid) => numberOf.get(b.owner.get(cid) ?? cid)).filter((n): n is number => n != null);
        out.push(`  ${ranges([...new Set(ns)].sort((a, c) => a - c))} via ${f.anchors.slice(0, 4).map((a) => maskText(ctx, a)).join(', ')}${f.anchors.length > 4 ? ` +${f.anchors.length - 4}` : ''}`);
      }
      if (b.flows.length > 10) out.push(`  … ${b.flows.length - 10} more flows`);
    }
    if (b.clean.length) out.push('', `Clean (${b.clean.length}): ${ranges([...b.clean].sort((a, c) => a - c))}`);
    if (b.actions.length > 1) {
      out.push('', `Actions (${b.actions.length}, a pause of ${pause(b.actionGapMs)} or another area starts one - learned from this cycle): `
        + b.actions.slice(0, 20).map((a, i) => `A${i + 1} ${ranges(a.calls)} (${a.reason})`).join(' · ') + (b.actions.length > 20 ? ` · … +${b.actions.length - 20}` : ''));
    }
    if (b.unmarked.length) out.push(`No saved mark yet (${b.unmarked.length}, checked by status only - just captured, recorded before triage, or past its row cap; `
      + `re-checked next batch): ${ranges(b.unmarked)}`);
    if (b.stale.length) out.push(staleText(b.stale));
    if (b.recheckPending) out.push(`Still settling (${b.recheckPending}): their log lines / statements may still arrive - the next check_calls re-judges any that change, even with no new calls.`);
    if (b.noBody) out.push(`No JSON/XML body (${b.noBody}) - not in the hop diffs.`);
    if (b.indexFailed) out.push(`Bodies not readable for ${b.indexFailed} call${b.indexFailed === 1 ? '' : 's'} (Alfred did not give them) - asked again next batch, left out of the hop diffs after ${INDEX_TRIES} tries.`);
    if (b.diffsPending) out.push(`Writes still arriving for ${b.diffsPending} call${b.diffsPending === 1 ? '' : 's'} - their hop diffs come in a later check.`);
  }
  out.push('', JSON.stringify({
    cycleId: b.cycleId, checked: b.checked, flaggedCalls: b.flagged.length, totalGroups: groups.length, groups: shownGroups, next, clean: b.clean.length,
    pending: b.pending, stale: b.stale.slice(0, STALE_LISTED), hopDiffs: b.hopDiffs, lastCallId: b.lastCallId, recording: b.recording,
    rechecked: b.rechecked, recheckPending: b.recheckPending, lateWrites: b.lateWrites, captureGaps: b.captureGaps,
    ...(b.actions.length > 1 ? { actions: b.actions.slice(0, 30).map((a) => ({ calls: ranges(a.calls), reason: a.reason })) } : {}),
    ...(b.indexFailed ? { indexFailed: b.indexFailed } : {}), ...(b.resumed ? { resumed: true } : {}), ...waitedJson(extra.waited),
    ...(extra.board ? { board: extra.board } : {}), ...maskMeta(ctx),
  }));
  return out.join('\n');
}

function waitedJson(waited: Waited | null): Record<string, unknown> {
  return waited ? { waited: waited.timedOut ? 'nothing arrived' : waited.woke ?? 'calls arrived' } : {};
}

/** "Never completed (2): #4 POST /api/x · running 12 min · started 09:00:45; #9 …" */
function staleText(stale: readonly StaleRow[]): string {
  const listed = stale.slice(0, STALE_LISTED).map((r) => `#${r.number} ${r.endpoint} · running ${Math.max(1, Math.round(r.ageSec / 60))} min · started ${r.startedAt.slice(11, 19)}`);
  return `Never completed (${stale.length}): ${listed.join('; ')}${stale.length > STALE_LISTED ? `; … +${stale.length - STALE_LISTED} more` : ''}`;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('check_calls', {
    description: 'Check calls of a session cycle in one pass - every call, nothing skipped: HTTP status, errors inside 200s and empty results, '
      + 'ERROR/WARN log lines and exceptions, failed or flagged database statements (N+1, slow...), failing supplier calls, Redis failures, '
      + 'slow against the same endpoint, and HOP DIFFS - flows found from the values calls carry (an id in one response that comes back in a '
      + 'later request, supplier call or written row), with every value that changed, went missing or changed count between them. Flagged '
      + 'calls come in GROUPS - the same problem on many calls is one group (same endpoint, exact status, signals, supplier outcome, DB flags, '
      + 'ERROR/WARN text, diffs), judged once - with an example\'s evidence and every member listed (JSON: callIds, key); every other call is '
      + 'listed as clean, so each call is accounted for. Pass sinceCallId (the lastCallId of the previous reply) for a listen batch; nothing for '
      + 'the whole cycle (review); sweep: true at the end of listening to re-judge only the calls whose mark changed since they were checked. '
      + 'Groups are paged: pass offset (the reply\'s next) with the same sinceCallId (or sweep) and untilCallId (the reply\'s lastCallId) for the '
      + 'rest - the pages are one frozen batch. A call still running (under 5 minutes) ends a listen batch and is checked next time; one running '
      + 'longer is passed over, reported once as never completed (stale), and checked when it finishes.',
    inputSchema: inputShape,
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    if (input.sweep && input.sinceCallId) throw invalid('A sweep covers the whole cycle - give sweep or sinceCallId, not both.');
    if (input.waitSec && !input.sinceCallId) throw invalid('waitSec waits for the calls after sinceCallId - pass the previous reply\'s lastCallId.');
    const found = await findCycle(client, input.cycle);
    if ('candidates' in found) {
      return ok({ candidates: found.candidates }, `"${input.cycle}" matches ${found.candidates.length} cycles - ask which one, then call check_calls with its id.`);
    }
    const mem = memoryOf(client, found.id, input.listener);
    const waited = input.waitSec && input.offset === 0 ? await listenWait(client, found, mem, input) : null;
    const board = input.boardCursor === undefined ? null : await boardChanges(client, ctx, found.id, input.boardCursor);
    const all = await cycleEntries(client, found.id);
    const now = client.now();
    const positions = new Map(all.map((e, i) => [e.call.id, i]));
    const byId = new Map(all.map((e) => [e.call.id, e.call]));
    const visible = (c: CallRecord) => input.includeOptions || c.method !== 'OPTIONS';
    const visibleAll = all.filter((e) => visible(e.call));
    const numberOf = new Map(visibleAll.map((e, i) => [e.call.id, i + 1]));
    const medians = mediansOf(visibleAll.map((e) => e.call));
    let latestStart = 0;
    for (const e of all) latestStart = Math.max(latestStart, Date.parse(e.call.timestamp));
    const indexOf = (id: string, what: string) => {
      const at = positions.get(id);
      if (at === undefined) throw invalid(`Call ${id} (${what}) is not in cycle "${found.name}". Pass the lastCallId of a previous check_calls or wait_for_calls reply.`);
      return at;
    };
    let startAt = 0;
    let resumedAt: number | null = null;
    if (input.sinceCallId) {
      const at = positions.get(input.sinceCallId);
      if (at !== undefined) {
        startAt = at + 1;
      } else {
        // The call this reply series ended on was removed from the cycle: go on after the time it had, instead of failing the listener.
        resumedAt = mem.lastTimes.get(input.sinceCallId) ?? null;
        if (resumedAt === null) indexOf(input.sinceCallId, 'sinceCallId');
        const from = all.findIndex((e) => callTime(e.call) >= resumedAt!);
        startAt = from < 0 ? all.length : from;
      }
    }
    // A process that did not do the earlier batches (restarted) takes what is before sinceCallId as checked, as its marks say now -
    // or the next batch would find all of it unchecked and judge the whole cycle again as late-comers.
    if (input.sinceCallId && !mem.started && mem.checked.size === 0 && startAt > 0) {
      const before = all.slice(0, startAt).map((e) => e.call).filter((c) => visible(c) && finished(c));
      const seedMarks = await triageOf(client, before.map((c) => c.id), input.minStatus).catch(() => ({} as Record<string, TriageEntry>));
      for (const c of before) {
        mem.checked.set(c.id, signatureOf(seedMarks[c.id] ?? null, c, medians));
        if (settling(c, !!seedMarks[c.id], now, latestStart)) mem.recheck.add(c.id);
      }
    }
    // A young call still running ends a listen batch: it and everything after it are checked next time, so none is checked
    // half-done. A sweep and a whole-cycle check are not cut by it - when it finishes it is the next batch's late-comer.
    // One running for minutes has hung: it is passed over, and the calls behind it are checked.
    const cutAt = input.sinceCallId ? all.findIndex((e, i) => i >= startAt && blocking(e.call, now)) : -1;
    let endAt = cutAt >= 0 ? cutAt : all.length;
    if (input.untilCallId) endAt = Math.min(endAt, indexOf(input.untilCallId, 'untilCallId') + 1);
    const windowSlice = all.slice(startAt, Math.max(startAt, endAt));
    const pendingCalls = all.slice(startAt).map((e) => e.call).filter((c) => visible(c) && blocking(c, now));
    const staleCalls = windowSlice.map((e) => e.call).filter((c) => visible(c) && !finished(c) && !blocking(c, now));
    const stale: StaleRow[] = staleCalls.map((c) => ({
      callId: c.id, number: numberOf.get(c.id)!, endpoint: endpointOf(c), startedAt: new Date(Date.parse(c.timestamp)).toISOString(),
      ageSec: Math.round((now - Date.parse(c.timestamp)) / 1000),
    }));
    // A call captured late but timed earlier (a supplier call reported after its parent's batch, a call that was still
    // running) sorts before sinceCallId: never checked, it joins this batch instead of falling between two.
    const lateComers = input.sinceCallId && (mem.started || mem.checked.size)
      ? all.slice(0, startAt).map((e) => e.call).filter((c) => visible(c) && finished(c) && !mem.checked.has(c.id)) : [];
    const windowCalls = [...lateComers, ...windowSlice.map((e) => e.call)
      .filter((c) => visible(c) && finished(c) && !(resumedAt !== null && mem.checked.has(c.id)))];
    const hiddenOptions = windowSlice.filter((e) => !visible(e.call)).length;
    const lastCallId = windowSlice.at(-1)?.call.id ?? input.sinceCallId ?? null;
    const lastCall = lastCallId ? byId.get(lastCallId) : undefined;
    if (lastCall) {
      mem.lastTimes.delete(lastCall.id);
      mem.lastTimes.set(lastCall.id, callTime(lastCall));
      while (mem.lastTimes.size > LAST_TIMES_KEPT) mem.lastTimes.delete(mem.lastTimes.keys().next().value!);
    }

    const sinceText = input.sinceCallId ? (numberOf.has(input.sinceCallId) ? `#${numberOf.get(input.sinceCallId)}` : input.sinceCallId) : '';
    const head = `check_calls cycle "${found.name}" (${found.id})${input.sweep ? ' - sweep (calls not checked yet, or changed since)'
      : resumedAt !== null ? ` - the calls from ${new Date(resumedAt).toISOString().slice(11, 19)} on (call ${input.sinceCallId} is no longer in the cycle)`
      : input.sinceCallId ? ` - the calls after ${sinceText}` : ' - every call'}`;
    // Calls checked before their capture settled: re-read their marks with this batch (never in a sweep - it reads all).
    const windowIds = new Set(windowCalls.map((c) => c.id));
    const recheckCalls = input.sweep ? []
      : all.filter((e) => mem.recheck.has(e.call.id) && finished(e.call) && !windowIds.has(e.call.id)).map((e) => e.call);
    const hungNew = staleCalls.filter((c) => !mem.hungReported.has(c.id));
    // The window the first page of this batch worked out, and what the later pages ask for again (the same sinceCallId or
    // sweep, the same untilCallId = its lastCallId).
    const key = `${input.sweep ? 'S' : ''}|${input.sinceCallId ?? ''}|${input.untilCallId ?? lastCallId ?? ''}|${input.minStatus}|${input.hopDiffs}|${input.includeOptions}`;
    const kept = input.offset > 0 && mem.page?.key === key ? mem.page : null;
    // a later page of a batch changes nothing the memory holds
    if (!kept) for (const id of mem.recheck) if (!positions.has(id)) mem.recheck.delete(id); // removed from the cycle since
    if (!kept && !windowCalls.length && !recheckCalls.length && !hungNew.length && !(input.hopDiffs && mem.diffsPending.size)) {
      mem.started = true;
      return ok({
        cycleId: found.id, checked: 0, groups: [], clean: 0, pending: pendingCalls.map((c) => numberOf.get(c.id)), stale: stale.slice(0, STALE_LISTED), lastCallId,
        recording: found.status === 'RECORDING', recheckPending: 0, lateWrites: [], captureGaps: [], ...(resumedAt !== null ? { resumed: true } : {}),
        ...waitedJson(waited), ...(board ? { board } : {}),
      }, `${head}: no new finished calls${pendingCalls.length ? ` (${pendingCalls.length} still running - check again)` : ''}.${stale.length ? `\n${staleText(stale)}` : ''}`);
    }
    const batch = kept ?? await computeBatch(client, input, mem, {
      all, byId, numberOf, medians, now, endAt, latestStart, head, resumed: resumedAt !== null, cycle: found, key, windowCalls, recheckCalls, hungNew,
      stale, pending: pendingCalls.map((c) => numberOf.get(c.id)!), hiddenOptions, lastCallId,
    }, input.sweep && input.offset > 0);
    if (!kept) mem.page = batch;
    // specs/027: one listen per cycle - a cycle on several boards sends each finding to its home (research R5)
    const boardsOn = await client.get<BoardRow[]>(`/board/cycles/${seg(found.id)}/boards`).catch(() => [] as BoardRow[]);
    const page = await renderPage(ctx, input, batch, { board, waited });
    return text(boardsOn.length > 1 ? `${page}

This cycle is on ${boardsOn.length} boards: `
      + boardsOn.map((b) => `${b.id} ("${b.name}"${b.state === 'OPEN' ? '' : ', ' + b.state.toLowerCase()})`).join(', ')
      + ' - before board_add, ask board_home where each finding goes (EVIDENCE / HOME / ASK).' : page);
  }));
}
