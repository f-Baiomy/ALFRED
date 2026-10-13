import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { isErrorLine } from '../call-story.ts';
import { hydrate } from '../calls.ts';
import { cycleEntries, findCycle } from '../cycle-calls.ts';
import { dbSummaries, loadCapture } from '../db-capture.ts';
import { FlowIndex, parseBody, writtenColumns, type HopDiff, type Side } from '../flow-diff.ts';
import type { CallDbSummary, CallLogsPage, CallRecord, CallStatementFailures, LinkedLogLine, TriageEntry } from '../frontend.ts';
import { maskCall, maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { invalid, ok, REPLY_BUDGET, run, text } from '../reply.ts';
import { isError, lineKey, signalsOfEntry, type SignalName } from '../signals.ts';
import { statementFailuresOf, triageOf } from '../triage.ts';
import { MaskSchema } from './cycles.ts';
import { maskLines } from './logs.ts';
import { evidence, headLine, unavailableNote, type Item } from './triage.ts';
import { changesReply, parentsOf, type ChangesPage } from './board.ts';
import { liveAnswerer } from './live.ts';
import { waitForCalls } from './watch.ts';

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
const MAX_DIFFS_DEFAULT = 40;
/** A call's statements may arrive a moment after it ends: its writes are indexed once its capture is complete, or this long after. */
const WRITES_SETTLE_MS = 10_000;
/** A call with no triage mark this long after it ended will not get one. */
const MARK_WAIT_MS = 120_000;
/** Memory the snapshot indexes of all cycles may hold; the least recently used cycle's index is dropped (and rebuilt from Alfred when needed). */
const INDEX_BYTES_MAX = 256 * 1024 * 1024;
const MEMBERS_LISTED = 200;

interface CycleMemory {
  readonly index: FlowIndex;
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
  /** The calls the first page of a batch re-judged - the later pages of the same batch show the same groups. */
  page?: { key: string; ids: readonly string[] };
}

const memory = new Map<string, CycleMemory>();

function memoryOf(client: AlfredClient, cycleId: string): CycleMemory {
  const key = `${client.baseUrl}|${cycleId}`;
  let m = memory.get(key);
  if (m) {
    memory.delete(key); // most recently used last
  } else {
    m = { index: new FlowIndex(), diffsPending: new Set(), checked: new Map(), recheck: new Set() };
  }
  memory.set(key, m);
  let total = [...memory.values()].reduce((sum, x) => sum + x.index.bytes, 0);
  for (const [k, other] of memory) {
    if (total <= INDEX_BYTES_MAX || other === m) break;
    total -= other.index.bytes;
    // Dropping an index loses no diff: a later check re-reads those calls' bodies from Alfred and rebuilds it.
    memory.set(k, { index: new FlowIndex(), diffsPending: other.diffsPending, checked: other.checked, recheck: other.recheck });
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

function finished(call: CallRecord): boolean {
  return call.state !== 'IN_PROGRESS';
}

function endOf(call: CallRecord): number {
  return Date.parse(call.timestamp) + (call.duration_ms ?? 0);
}

/** A call's request and response bodies and the rows it wrote, as flow sides on one timeline. */
async function sidesOf(client: AlfredClient, cycleId: string, call: CallRecord, writes: boolean): Promise<Side[]> {
  const start = Date.parse(call.timestamp);
  const full = await hydrate(client, { id: call.id, source: call.source ?? 'internal', cycleId }, call).catch(() => call);
  const sides: Side[] = [];
  const req = parseBody(full.request?.body);
  const res = parseBody(full.response?.body);
  if (req !== undefined) sides.push({ callId: call.id, kind: 'req', at: start, root: req });
  if (res !== undefined) sides.push({ callId: call.id, kind: 'res', at: endOf(call), root: res });
  if (writes) {
    const capture = await loadCapture(client, call.id).catch(() => null);
    for (const st of capture?.statements ?? []) {
      if (!['INSERT', 'UPDATE', 'MERGE'].includes(st.kind)) continue;
      const cols = writtenColumns(st.sql);
      if (!cols) continue;
      for (const set of st.params) {
        const row: Record<string, string | null> = {};
        cols.columns.forEach((c, i) => { if (set[i]) row[c] = set[i].value; });
        sides.push({ callId: call.id, kind: 'db', at: start + st.offsetMicros / 1000, root: row, table: cols.table });
      }
    }
  }
  return sides;
}

/**
 * Indexes the finished calls not indexed yet. A call whose statements may still be arriving is indexed later: it stays
 * out of the index (and in diffsPending) until its capture is complete or has had time to settle.
 */
async function indexCalls(client: AlfredClient, cycleId: string, mem: CycleMemory, calls: readonly CallRecord[]): Promise<number> {
  const todo = calls.filter((c) => finished(c) && c.method !== 'OPTIONS' && !mem.index.has(c.id));
  if (!todo.length) return 0;
  const [summaries, projects] = await Promise.all([
    dbSummaries(client, todo.filter((c) => c.source === 'internal').map((c) => c.id)).catch(() => ({} as Record<string, CallDbSummary>)),
    client.get<{ project: string; enabled: boolean }[]>('/db-capture/projects').catch(() => [] as { project: string; enabled: boolean }[]),
  ]);
  const capturing = new Set(projects.filter((p) => p.enabled).map((p) => p.project));
  // "A while ago" on the cycle's own clock too: the newest call started well after this one ended.
  const latest = Math.max(...calls.map((c) => Date.parse(c.timestamp)));
  const now = Date.now();
  let noBody = 0;
  await mapLimit(todo, CONCURRENCY, async (c) => {
    const summary = summaries[c.id];
    const settled = summary ? summary.complete
      : c.source !== 'internal' || !capturing.has(c.service_name ?? '') || now - endOf(c) > WRITES_SETTLE_MS || latest - endOf(c) > WRITES_SETTLE_MS;
    if (!settled) { mem.diffsPending.add(c.id); return; }
    const sides = await sidesOf(client, cycleId, c, (summary?.writeCount ?? 0) > 0);
    if (!sides.length) noBody++;
    mem.index.add(c.id, sides);
  });
  return noBody;
}

/** "POST /api/bookings/:id" - one endpoint, whatever the ids in its path. */
function endpointOf(call: CallRecord): string {
  let path = call.original_url || call.url;
  try { path = new URL(path).pathname; } catch { /* keep as is */ }
  // any all-digit segment (/item/5), and longer ones holding a digit (/ODY-482, a UUID)
  return `${call.method} ${path.replace(/\/(?:\d+|(?=[^/]*\d)[^/]{3,})(?=\/|$)/g, '/:id')}`;
}

function slowNote(call: CallRecord, medians: ReadonlyMap<string, { median: number; samples: number }>): string | null {
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

/** The first error lines of each call that logged some - bounded, so 500 flagged calls are not 500 requests at once. */
async function errorLines(client: AlfredClient, ctx: MaskContext, entries: readonly TriageEntry[], cycleId: string): Promise<Map<string, LinkedLogLine[]>> {
  const out = new Map<string, LinkedLogLine[]>();
  const wanted = entries.filter((e) => (e.signals?.logErrors ?? 0) > 0 || (e.signals?.logExceptions ?? 0) > 0);
  await mapLimit(wanted, CONCURRENCY, async (e) => {
    const page = await client.get<CallLogsPage>(`/call-logs/${seg(e.callId)}`, { query: { cycleId, limit: 500 } }).catch(() => null);
    if (page) out.set(e.callId, maskLines(ctx, e.callId, page.lines.filter(isErrorLine)));
  });
  return out;
}

interface Flagged {
  readonly call: CallRecord;
  readonly entry: TriageEntry | null;
  readonly signals: SignalName[];
  readonly slow: string | null;
  readonly diffs: HopDiff[];
}

interface Group {
  readonly key: string;
  readonly members: Flagged[];
  readonly severity: number;
}

/**
 * The same problem on many calls is one group: same endpoint, same signals, same error (logger, exception, message
 * with its numbers and ids set aside), same failing statement, same soft failure, same hop-diff keys, same slowness.
 * Anything different - one more signal, another error - is another group, so a group never hides a second problem.
 */
function groupKey(f: Flagged, lines: ReadonlyMap<string, LinkedLogLine[]>, failures: Record<string, CallStatementFailures>): string {
  const firstError = lines.get(f.call.id)?.[0];
  const failed = failures[f.call.id]?.statements[0];
  return [
    endpointOf(f.call),
    f.signals.join(','),
    f.entry?.softFailure ? `${f.entry.softFailure.kind}:${f.entry.softFailure.code ?? ''}` : '',
    f.entry?.emptyKeys.length ? `empty:${f.entry.emptyKeys.join(',')}` : '',
    firstError ? lineKey(firstError) : '',
    failed ? `${failed.kind}:${failed.table ?? ''}:${failed.sqlState ?? ''}` : '',
    [...new Set(f.diffs.map((d) => `${d.kind}:${d.key}`))].sort().join(','),
    f.slow ? 'slow' : '',
    f.entry ? '' : 'nomark',
  ].join('¦');
}

function severityOf(f: Flagged): number {
  if (f.signals.some(isError) || (!f.entry && ((f.call.response?.status ?? 0) >= 400 || f.call.error))) return 0;
  if (f.diffs.length || f.entry?.softFailure) return 1;
  if (f.signals.length || f.entry?.emptyKeys.length) return 2;
  return 3;
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
  for (const [k, m] of memory) memory.set(k, { index: new FlowIndex(), diffsPending: m.diffsPending, checked: m.checked, recheck: m.recheck });
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('check_calls', {
    description: 'Check calls of a session cycle in one pass - every call, nothing skipped: HTTP status, errors inside 200s and empty results, '
      + 'ERROR/WARN log lines and exceptions, failed or flagged database statements (N+1, slow...), failing supplier calls, Redis failures, '
      + 'slow against the same endpoint, and HOP DIFFS - flows found from the values calls carry (an id in one response that comes back in a '
      + 'later request, supplier call or written row), with every value that changed, went missing or changed count between them. Flagged '
      + 'calls come in GROUPS - the same problem on many calls is one group (same endpoint, signals, error, diffs), judged once - with an '
      + 'example\'s evidence and every member listed; every other call is listed as clean, so each call is accounted for. Pass sinceCallId (the '
      + 'lastCallId of the previous reply) for a listen batch; nothing for the whole cycle (review); sweep: true at the end of listening to '
      + 're-judge only the calls whose mark changed since they were checked. Groups are paged: pass offset (the reply\'s next) with the same '
      + 'sinceCallId and untilCallId (the reply\'s lastCallId) for the rest. A call still running is pending and checked next time.',
    inputSchema: {
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
        + 'the same as board_changes by USER; pass the returned board.cursor next time'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    if (input.sweep && input.sinceCallId) throw invalid('A sweep covers the whole cycle - give sweep or sinceCallId, not both.');
    if (input.waitSec && !input.sinceCallId) throw invalid('waitSec waits for the calls after sinceCallId - pass the previous reply\'s lastCallId.');
    const found = await findCycle(client, input.cycle);
    if ('candidates' in found) {
      return ok({ candidates: found.candidates }, `"${input.cycle}" matches ${found.candidates.length} cycles - ask which one, then call check_calls with its id.`);
    }
    const mem = memoryOf(client, found.id);
    let waited: { timedOut: boolean } | null = null;
    if (input.waitSec && input.offset === 0) {
      const known = await cycleEntries(client, found.id);
      const callOf = new Map(known.map((e) => [e.call.id, e.call]));
      const recheckIds = [...mem.recheck].filter((id) => callOf.has(id));
      // a call checked too early whose log lines / statements arrived since: no reason to wait
      const changed = async () => {
        if (!recheckIds.length) return false;
        const marks = await triageOf(client, recheckIds, input.minStatus).catch(() => ({} as Record<string, TriageEntry>));
        return recheckIds.some((id) => mem.checked.get(id) !== markSignature(marks[id] ?? null, callOf.get(id)!));
      };
      waited = (await changed()) ? { timedOut: false }
        : await waitForCalls(client, found.id, input.sinceCallId, input.waitSec * 1000, 'any', input.settleSec * 1000,
          recheckIds.length ? { sockets: ['/ws/triage', '/ws/db-capture'], changed } : undefined);
    }
    const board = input.boardCursor === undefined ? null : await boardChanges(client, ctx, found.id, input.boardCursor);
    const all = await cycleEntries(client, found.id);
    const indexOf = (id: string, what: string) => {
      const at = all.findIndex((e) => e.call.id === id);
      if (at < 0) throw invalid(`Call ${id} (${what}) is not in cycle "${found.name}". Pass the lastCallId of a previous check_calls or wait_for_calls reply.`);
      return at;
    };
    const startAt = input.sinceCallId ? indexOf(input.sinceCallId, 'sinceCallId') + 1 : 0;
    // A call still running ends the batch: it and everything after it are checked next time, so none is checked half-done.
    const firstPending = all.findIndex((e, i) => i >= startAt && !finished(e.call));
    let endAt = firstPending >= 0 ? firstPending : all.length;
    if (input.untilCallId) endAt = Math.min(endAt, indexOf(input.untilCallId, 'untilCallId') + 1);
    const visible = (c: CallRecord) => input.includeOptions || c.method !== 'OPTIONS';
    const visibleAll = all.filter((e) => visible(e.call));
    const numberOf = new Map(visibleAll.map((e, i) => [e.call.id, i + 1]));
    const windowEntries = all.slice(startAt, endAt);
    // Not checked in this window: a call still running and everything after it (the next batch starts there).
    const pending = firstPending >= 0 && firstPending < (input.untilCallId ? endAt + 1 : Infinity)
      ? all.slice(endAt).filter((e) => visible(e.call)) : all.slice(endAt).filter((e) => visible(e.call) && !finished(e.call));
    // A call captured late but timed earlier (a supplier call reported after its parent's batch) sorts before
    // sinceCallId: never checked, it joins this batch instead of falling between two.
    const lateComers = input.sinceCallId && mem.checked.size
      ? all.slice(0, startAt).filter((e) => visible(e.call) && finished(e.call) && !mem.checked.has(e.call.id)).map((e) => e.call) : [];
    const windowCalls = [...lateComers, ...windowEntries.filter((e) => visible(e.call)).map((e) => e.call)];
    const hiddenOptions = windowEntries.length - (windowCalls.length - lateComers.length);
    const lastCallId = windowEntries.at(-1)?.call.id ?? input.sinceCallId ?? null;

    const head = `check_calls cycle "${found.name}" (${found.id})${input.sweep ? ' - sweep (calls not checked yet, or changed since)'
      : input.sinceCallId ? ` - the calls after ${numberOf.has(input.sinceCallId) ? `#${numberOf.get(input.sinceCallId)}` : input.sinceCallId}` : ' - every call'}`;
    // Calls checked before their capture settled: re-read their marks with this batch (never in a sweep - it reads all).
    const inCycle = new Set(all.map((e) => e.call.id));
    for (const id of mem.recheck) if (!inCycle.has(id)) mem.recheck.delete(id); // removed from the cycle since
    const windowIds = new Set(windowCalls.map((c) => c.id));
    const pageKey = `${input.sinceCallId ?? ''}|${input.untilCallId ?? lastCallId ?? ''}`;
    // A later page of the same batch: the calls its first page re-judged, so the groups (and their offsets) match.
    const continuing = input.offset > 0 && mem.page?.key === pageKey ? new Set(mem.page.ids) : null;
    const recheckCalls = input.sweep ? []
      : all.filter((e) => (continuing ? continuing.has(e.call.id) : mem.recheck.has(e.call.id)) && !windowIds.has(e.call.id)).map((e) => e.call);
    if (!windowCalls.length && !recheckCalls.length && !(input.hopDiffs && mem.diffsPending.size)) {
      return ok({ cycleId: found.id, checked: 0, groups: [], clean: 0, pending: pending.map((e) => numberOf.get(e.call.id)), lastCallId, recording: found.status === 'RECORDING', recheckPending: 0,
        ...(waited ? { waited: waited.timedOut ? 'nothing arrived' : 'calls arrived' } : {}), ...(board ? { board } : {}) },
        `${head}: no new finished calls${pending.length ? ` (${pending.length} still running - check again)` : ''}.`);
    }

    const marks = await triageOf(client, [...windowCalls, ...recheckCalls].map((c) => c.id), input.minStatus).catch(() => ({} as Record<string, TriageEntry>));
    // A call checked early whose mark changed since (a log line, a statement, a supplier call arrived late) is judged again now.
    const rechecked = continuing ? recheckCalls : recheckCalls.filter((c) => mem.checked.get(c.id) !== markSignature(marks[c.id] ?? null, c));
    if (!continuing) mem.page = { key: pageKey, ids: rechecked.map((c) => c.id) };
    // The sweep: only what was never checked, or whose mark changed since (a log line or statement that arrived late).
    const subject = input.sweep
      ? windowCalls.filter((c) => mem.checked.get(c.id) !== markSignature(marks[c.id] ?? null, c) || mem.diffsPending.has(c.id))
      : [...windowCalls, ...rechecked];
    const inboundIds = new Set(subject.filter((c) => c.source === 'internal').map((c) => c.id));
    const parentOf = (c: CallRecord) => marks[c.id]?.parentCallId ?? c.parentCallId ?? null;
    // A supplier call of an inbound call in this batch is evidence under that call (as triage shows it): its mark is in
    // its parent's failingSupplierCalls, and its hop diffs are shown under the parent.
    const owner = new Map(subject.map((c) => [c.id, c.source !== 'internal' && inboundIds.has(parentOf(c) ?? '') ? parentOf(c)! : c.id]));
    const heads = subject.filter((c) => owner.get(c.id) === c.id);

    // slow: against the same endpoint in the whole cycle
    const durations = new Map<string, number[]>();
    for (const e of visibleAll) {
      if (e.call.duration_ms == null) continue;
      const k = endpointOf(e.call);
      durations.set(k, [...(durations.get(k) ?? []), e.call.duration_ms]);
    }
    const medians = new Map([...durations].map(([k, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return [k, { median: sorted[Math.floor(sorted.length / 2)], samples: sorted.length }];
    }));

    // hop diffs: index what is new (each call once), then compare this batch - and calls whose writes arrived since -
    // against everything indexed before them
    let diffs: HopDiff[] = [];
    let flows: { callIds: readonly string[]; anchors: readonly string[] }[] = [];
    let noBody = 0;
    if (input.hopDiffs) {
      const upTo = all.slice(0, endAt).map((e) => e.call);
      const wasPending = new Set(mem.diffsPending);
      mem.diffsPending.clear();
      noBody = await indexCalls(client, found.id, mem, upTo);
      const report = new Set([...subject.map((c) => c.id), ...[...wasPending].filter((id) => mem.index.has(id))].filter((id) => mem.index.has(id)));
      diffs = mem.index.diffsFor(report);
      flows = mem.index.flowsFor(subject.map((c) => c.id));
      // a call whose writes arrived since an earlier batch is reported again, with its diffs
      for (const id of wasPending) {
        if (!mem.index.has(id) || owner.has(id)) continue;
        const e = all.find((x) => x.call.id === id);
        if (e && diffs.some((d) => d.to.callId === id)) {
          owner.set(id, id);
          heads.push(e.call);
        }
      }
    }
    const late = heads.filter((c) => !(c.id in marks)).map((c) => c.id).filter((id) => !windowCalls.some((w) => w.id === id));
    if (late.length) Object.assign(marks, await triageOf(client, late, input.minStatus).catch(() => ({})));
    const diffsOf = new Map<string, HopDiff[]>();
    for (const d of diffs) {
      const at = owner.get(d.to.callId) ?? d.to.callId;
      diffsOf.set(at, [...(diffsOf.get(at) ?? []), d]);
    }

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
    for (const c of subject) mem.checked.set(c.id, markSignature(marks[c.id] ?? null, c));
    // Still settling (no mark yet, or ended moments ago on both clocks): look again next batch; settled: done with it.
    const latestStart = Math.max(...all.map((e) => Date.parse(e.call.timestamp)));
    const nowMs = Date.now();
    for (const c of [...windowCalls, ...recheckCalls]) {
      const age = Math.max(nowMs - endOf(c), latestStart - endOf(c));
      // No mark a while after it ended: it never gets one (recorded before triage, past its cap) - stop asking.
      const settling = c.method !== 'OPTIONS' && (age < WRITES_SETTLE_MS || (!marks[c.id] && age < MARK_WAIT_MS));
      if (settling && !input.sweep) mem.recheck.add(c.id);
      else mem.recheck.delete(c.id);
    }

    const failures = await statementFailuresOf(client, flagged.map((f) => f.entry).filter((e): e is TriageEntry => !!e && e.failedStatements > 0).map((e) => e.callId))
      .catch(() => ({} as Record<string, CallStatementFailures>));
    const lines = await errorLines(client, ctx, flagged.map((f) => f.entry).filter((e): e is TriageEntry => !!e), found.id);

    const byKey = new Map<string, Flagged[]>();
    for (const f of flagged) {
      const k = groupKey(f, lines, failures);
      byKey.set(k, [...(byKey.get(k) ?? []), f]);
    }
    const groups: Group[] = [...byKey].map(([key, members]) => ({ key, members, severity: severityOf(members[0]) }))
      .sort((a, b) => a.severity - b.severity || b.members.length - a.members.length
        || numberOf.get(a.members[0].call.id)! - numberOf.get(b.members[0].call.id)!);

    const out: string[] = [
      `${head}: ${subject.length} checked (${heads.length} entries${subject.length - heads.length ? `, ${subject.length - heads.length} supplier calls under them` : ''}`
        + `${hiddenOptions ? `, ${hiddenOptions} OPTIONS skipped` : ''}${input.sweep ? `, ${windowCalls.length - subject.length} unchanged since checked` : ''})`
        + ` - ${flagged.length} flagged in ${groups.length} group${groups.length === 1 ? '' : 's'}, ${clean.length} clean`
        + `${pending.length ? `, ${pending.length} still running (next time)` : ''}`
        + `${rechecked.length ? ` - ${rechecked.length} earlier call${rechecked.length === 1 ? '' : 's'} re-judged (logs / SQL arrived late)` : ''}`
        + await unavailableNote(client, flagged.map((f) => ({ label: '', entry: f.entry, call: f.call }) as Item)),
      '',
    ];
    let size = out.join('\n').length + 2_000;
    let diffsShown = 0;
    const shownGroups: { group: string; calls: number[] | string }[] = [];
    let next: number | null = null;
    const page = groups.slice(input.offset, input.offset + input.limit);
    if (groups.length) {
      out.push(`Flagged (${flagged.length} calls in ${groups.length} groups${input.offset ? `, from group ${input.offset + 1}` : ''}) - each group needs one outcome: a card (linking all its calls), a link to a card, asked, or fine with the reason:`);
    }
    for (let gi = 0; gi < page.length; gi++) {
      const g = page[gi];
      const id = `G${input.offset + gi + 1}`;
      const example = g.members[0];
      const nums = g.members.map((m) => numberOf.get(m.call.id)!).sort((a, b) => a - b);
      const item: Item = { label: `#${numberOf.get(example.call.id)}`, entry: example.entry, call: maskCall(ctx, example.call) };
      const block = [
        `${id} · ${g.members.length} call${g.members.length === 1 ? '' : 's'} · ${endpointOf(example.call)}${example.signals.length ? ` · ${example.signals.join(', ')}` : ''}`,
        `  ${headLine(ctx, item)}`,
        ...(await evidence(ctx, item, numberOf, failures, lines)),
      ];
      if (example.slow) block.push(`    ${example.slow}`);
      const room = Math.max(0, input.maxDiffs - diffsShown);
      for (const d of example.diffs.slice(0, room)) block.push(diffLine(ctx, d, numberOf));
      diffsShown += Math.min(room, example.diffs.length);
      if (example.diffs.length > room) block.push(`    … ${example.diffs.length - room} more hop diffs - check_calls with a higher maxDiffs`);
      if (g.members.length > 1) {
        const listed = nums.length > MEMBERS_LISTED ? `${ranges(nums.slice(0, MEMBERS_LISTED))} … +${nums.length - MEMBERS_LISTED} more (last #${nums.at(-1)})` : ranges(nums);
        block.push(`  all ${g.members.length}: ${listed}`);
      }
      const blockSize = block.join('\n').length + 1;
      if (gi > 0 && size + blockSize > REPLY_BUDGET) { next = input.offset + gi; break; }
      out.push(...block);
      size += blockSize;
      shownGroups.push({ group: id, calls: nums.length > MEMBERS_LISTED ? `${nums.length} calls, #${nums[0]}..#${nums.at(-1)}` : nums });
    }
    if (next === null && input.offset + page.length < groups.length) next = input.offset + page.length;
    if (next !== null) out.push(`  … groups ${next + 1}-${groups.length} on the next page: check_calls with offset ${next}${lastCallId ? ` and untilCallId ${lastCallId}` : ''}`);
    if (input.offset === 0) {
      if (flows.length) {
        out.push('', `Flows (${flows.length}) - calls linked by the values they carry:`);
        for (const f of flows.slice(0, 10)) {
          const ns = f.callIds.map((cid) => numberOf.get(owner.get(cid) ?? cid)).filter((n): n is number => n != null);
          out.push(`  ${ranges([...new Set(ns)].sort((a, b) => a - b))} via ${f.anchors.slice(0, 4).map((a) => maskText(ctx, a)).join(', ')}${f.anchors.length > 4 ? ` +${f.anchors.length - 4}` : ''}`);
        }
        if (flows.length > 10) out.push(`  … ${flows.length - 10} more flows`);
      }
      if (clean.length) out.push('', `Clean (${clean.length}): ${ranges(clean.sort((a, b) => a - b))}`);
      if (unmarked.length) out.push(`No saved mark yet (${unmarked.length}, checked by status only - just captured, recorded before triage, or past its row cap; `
        + `re-checked next batch): ${ranges(unmarked)}`);
      if (mem.recheck.size) out.push(`Still settling (${mem.recheck.size}): their log lines / statements may still arrive - the next check_calls re-judges any that change, even with no new calls.`);
      if (noBody) out.push(`No JSON/XML body (${noBody}) - not in the hop diffs.`);
      if (mem.diffsPending.size) out.push(`Writes still arriving for ${mem.diffsPending.size} call${mem.diffsPending.size === 1 ? '' : 's'} - their hop diffs come in a later check.`);
    }
    out.push('', JSON.stringify({
      cycleId: found.id, checked: subject.length, flaggedCalls: flagged.length, totalGroups: groups.length, groups: shownGroups, next, clean: clean.length,
      pending: pending.map((e) => numberOf.get(e.call.id)), hopDiffs: diffs.length, lastCallId, recording: found.status === 'RECORDING',
      rechecked: rechecked.length, recheckPending: mem.recheck.size, ...(board ? { board } : {}), ...maskMeta(ctx),
    }));
    return text(out.join('\n'));
  }));
}
