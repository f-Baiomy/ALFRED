import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { hydrate } from '../calls.ts';
import { findCycle, listCycleCalls } from '../cycle-calls.ts';
import { dbSummaries, loadCapture } from '../db-capture.ts';
import { analyseFlows, parseBody, writtenColumns, type HopDiff, type Side } from '../flow-diff.ts';
import type { CallRecord, CallStatementFailures, TriageEntry } from '../frontend.ts';
import { maskCall, maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { invalid, ok, REPLY_BUDGET, run, text } from '../reply.ts';
import { signalsOfEntry } from '../signals.ts';
import { statementFailuresOf, triageOf } from '../triage.ts';
import { MaskSchema } from './cycles.ts';
import { errorLinesOf, evidence, headLine, unavailableNote, type Item } from './triage.ts';

/**
 * check_calls (listen and review, rules "Batches"): every call of a cycle - or of the calls after `sinceCallId` -
 * checked in code, nothing skipped: its triage mark (HTTP, log, database, supplier and Redis signals, errors inside
 * 200s, empty results), slow against the same endpoint in the cycle, and the flows' hop diffs (a value that changed,
 * went missing or changed count between the calls that carry the same thing, including the rows they wrote).
 * Claude reads only what is flagged; every call is accounted for in the reply, so a batch can never silently drop one.
 */

const SLOW_MS = 2_000;
const BODY_CONCURRENCY = 8;
const MAX_DIFFS_DEFAULT = 40;

/** Parsed bodies and written rows of finished cycle calls - a cycle copy does not change once the call completed. */
const sideCache = new Map<string, Side[]>();
const SIDE_CACHE_MAX = 5_000;

function remember(key: string, sides: Side[]): void {
  if (sideCache.size >= SIDE_CACHE_MAX) sideCache.delete(sideCache.keys().next().value!);
  sideCache.set(key, sides);
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

/** A call's request and response bodies and the rows it wrote, as flow sides on one timeline. */
async function sidesOf(client: AlfredClient, cycleId: string, call: CallRecord, writes: boolean): Promise<{ sides: Side[]; compared: boolean }> {
  const key = `${cycleId}:${call.id}`;
  const cached = sideCache.get(key);
  if (cached) return { sides: cached, compared: cached.length > 0 };
  const start = Date.parse(call.timestamp);
  const end = start + (call.duration_ms ?? 0);
  const full = await hydrate(client, { id: call.id, source: call.source ?? 'internal', cycleId }, call).catch(() => call);
  const sides: Side[] = [];
  const req = parseBody(full.request?.body);
  const res = parseBody(full.response?.body);
  if (req !== undefined) sides.push({ callId: call.id, kind: 'req', at: start, root: req });
  if (res !== undefined) sides.push({ callId: call.id, kind: 'res', at: end, root: res });
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
  if (finished(call)) remember(key, sides);
  return { sides, compared: sides.length > 0 };
}

/** "POST /api/bookings/:id" - one endpoint, whatever the ids in its path. */
function endpointOf(call: CallRecord): string {
  let path = call.original_url || call.url;
  try { path = new URL(path).pathname; } catch { /* keep as is */ }
  return `${call.method} ${path.replace(/\/(?=[^/]*\d)[^/]{3,}/g, '/:id')}`;
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
  const what = d.kind === 'changed' ? 'changed' : d.kind === 'count' ? 'count' : 'missing';
  return `    Δ ${what} ${d.key}: ${maskText(ctx, d.from.value)} (${n(d.from.callId)} ${d.from.side} ${maskText(ctx, d.from.path)})`
    + ` → ${maskText(ctx, d.to.value)} (${n(d.to.callId)} ${d.to.side} ${maskText(ctx, d.to.path)}) via ${maskText(ctx, d.anchor)}`;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('check_calls', {
    description: 'Check calls of a session cycle in one pass - every call, nothing skipped: HTTP status, errors inside 200s and empty results, '
      + 'ERROR/WARN log lines and exceptions, failed or flagged database statements (N+1, slow...), failing supplier calls, Redis failures, '
      + 'slow against the same endpoint, and HOP DIFFS - flows found from the values calls carry (an id in one response that comes back in a '
      + 'later request, supplier call or written row), with every value that changed, went missing or changed count between them. Returns the '
      + 'flagged calls with their evidence, the flows, and every other call as "clean", so each call is accounted for. Pass sinceCallId (the '
      + 'lastCallId of the previous reply) to check only the calls after it - what listen does per batch; without it, the whole cycle (review, '
      + 'and listen\'s final sweep). A call still running is reported as pending and checked again next time.',
    inputSchema: {
      cycle: z.string().min(1).describe('Cycle id or text from its name'),
      sinceCallId: z.string().optional().describe('Check only the calls after this one (the previous reply\'s lastCallId)'),
      minStatus: z.number().int().min(300).max(600).default(400).describe('A status at or over this is an error (400 by default)'),
      hopDiffs: z.boolean().default(true).describe('Compare the values calls carry between them (reads bodies and written rows in Alfred, not in the reply)'),
      maxDiffs: z.number().int().min(1).max(200).default(MAX_DIFFS_DEFAULT),
      includeOptions: z.boolean().default(false),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const found = await findCycle(client, input.cycle);
    if ('candidates' in found) {
      return ok({ candidates: found.candidates }, `"${input.cycle}" matches ${found.candidates.length} cycles - ask which one, then call check_calls with its id.`);
    }
    const listed = await listCycleCalls(client, found.id);
    const all = listed.entries;
    let startAt = 0;
    if (input.sinceCallId) {
      const at = all.findIndex((e) => e.call.id === input.sinceCallId);
      if (at < 0) throw invalid(`Call ${input.sinceCallId} is not in cycle "${found.name}". Pass the lastCallId of a previous check_calls or wait_for_calls reply.`);
      startAt = at + 1;
    }
    // A call still running ends the batch: it and everything after it are checked next time, so none is checked half-done.
    const firstPending = all.findIndex((e, i) => i >= startAt && !finished(e.call));
    const endAt = firstPending >= 0 ? firstPending : all.length;
    const windowEntries = all.slice(startAt, endAt);
    const pending = all.slice(endAt).filter((e) => input.includeOptions || e.call.method !== 'OPTIONS');
    const visibleAll = all.filter((e) => input.includeOptions || e.call.method !== 'OPTIONS');
    const numberOf = new Map(visibleAll.map((e, i) => [e.call.id, i + 1]));
    const windowCalls = windowEntries.filter((e) => input.includeOptions || e.call.method !== 'OPTIONS').map((e) => e.call);
    const hiddenOptions = windowEntries.length - windowCalls.length;
    const lastCallId = windowEntries.at(-1)?.call.id ?? input.sinceCallId ?? null;

    const head = `check_calls cycle "${found.name}" (${found.id})${input.sinceCallId ? ` - the calls after ${numberOf.has(input.sinceCallId) ? `#${numberOf.get(input.sinceCallId)}` : input.sinceCallId}` : ' - every call'}`;
    if (!windowCalls.length) {
      return ok({ cycleId: found.id, checked: 0, flagged: [], clean: [], pending: pending.map((e) => numberOf.get(e.call.id)), lastCallId, recording: found.status === 'RECORDING' },
        `${head}: no new finished calls${pending.length ? ` (${pending.length} still running - check again)` : ''}.`);
    }

    const marks = await triageOf(client, windowCalls.map((c) => c.id), input.minStatus).catch(() => ({} as Record<string, TriageEntry>));
    const inboundIds = new Set(windowCalls.filter((c) => c.source === 'internal').map((c) => c.id));
    const parentOf = (c: CallRecord) => marks[c.id]?.parentCallId ?? c.parentCallId ?? null;
    // A supplier call of an inbound call in this batch is evidence under that call (as triage shows it), never lost: its
    // mark is in its parent's failingSupplierCalls, and its hop diffs are shown under the parent.
    const owner = new Map(windowCalls.map((c) => [c.id, c.source !== 'internal' && inboundIds.has(parentOf(c) ?? '') ? parentOf(c)! : c.id]));
    const heads = windowCalls.filter((c) => owner.get(c.id) === c.id);

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

    // hop diffs: every finished call up to the end of the batch is a possible "from"; only the batch's calls are reported as "to"
    let diffs: HopDiff[] = [];
    let flows: { callIds: readonly string[]; anchors: readonly string[] }[] = [];
    let notCompared = 0;
    if (input.hopDiffs) {
      const upTo = all.slice(0, endAt).filter((e) => e.call.method !== 'OPTIONS').map((e) => e.call);
      const summaries = await dbSummaries(client, upTo.filter((c) => c.source === 'internal').map((c) => c.id)).catch(() => ({} as Awaited<ReturnType<typeof dbSummaries>>));
      const parts = await mapLimit(upTo, BODY_CONCURRENCY, (c) => sidesOf(client, found.id, c, (summaries[c.id]?.writeCount ?? 0) > 0));
      notCompared = parts.filter((p, i) => !p.compared && windowCalls.some((w) => w.id === upTo[i].id)).length;
      const inWindow = new Set(windowCalls.map((c) => c.id));
      const analysis = analyseFlows(parts.flatMap((p) => p.sides), (id) => inWindow.has(id));
      diffs = [...analysis.diffs];
      flows = analysis.flows.filter((f) => f.callIds.some((id) => inWindow.has(id)));
    }
    const diffsOf = new Map<string, HopDiff[]>();
    for (const d of diffs) {
      const at = owner.get(d.to.callId) ?? d.to.callId;
      diffsOf.set(at, [...(diffsOf.get(at) ?? []), d]);
    }

    const flagged: { item: Item; why: string[]; diffs: HopDiff[] }[] = [];
    const clean: number[] = [];
    const unmarked: number[] = [];
    for (const c of heads) {
      const entry = marks[c.id] ?? null;
      const why: string[] = [];
      if (entry) {
        const signals = signalsOfEntry(entry, input.minStatus);
        if (signals.length || entry.softFailure || (entry.emptyKeys.length && c.source === 'internal') || entry.failingSupplierCalls.length) why.push('mark');
      } else {
        unmarked.push(numberOf.get(c.id)!);
        if ((c.response?.status ?? 0) >= input.minStatus || c.error) why.push('status');
      }
      const slow = slowNote(c, medians);
      if (slow) why.push(slow);
      const own = diffsOf.get(c.id) ?? [];
      if (own.length) why.push('diff');
      if (why.length) flagged.push({ item: { label: `#${numberOf.get(c.id)}`, entry, call: maskCall(ctx, c) }, why, diffs: own });
      else clean.push(numberOf.get(c.id)!);
    }

    const failures = await statementFailuresOf(client, flagged.map((f) => f.item.entry).filter((e): e is TriageEntry => !!e && e.failedStatements > 0).map((e) => e.callId))
      .catch(() => ({} as Record<string, CallStatementFailures>));
    const logLines = await errorLinesOf(client, ctx, flagged.map((f) => f.item.entry).filter((e): e is TriageEntry => !!e), found.id);

    const out: string[] = [
      `${head}: ${windowCalls.length} checked (${heads.length} entries${windowCalls.length - heads.length ? `, ${windowCalls.length - heads.length} supplier calls under them` : ''}${hiddenOptions ? `, ${hiddenOptions} OPTIONS skipped` : ''})`
        + ` - ${flagged.length} flagged, ${clean.length} clean${pending.length ? `, ${pending.length} still running (next time)` : ''}`
        + await unavailableNote(client, flagged.map((f) => f.item)),
      '',
    ];
    let size = out.join('\n').length + 1_500;
    const shownFlagged: number[] = [];
    const notShown: number[] = [];
    let diffsShown = 0;
    if (flagged.length) out.push(`Flagged (${flagged.length}) - each needs a card, a link to a card, or a reason it is fine:`);
    for (const f of flagged) {
      const block = [`  ${headLine(ctx, f.item)}`, ...(await evidence(ctx, f.item, numberOf, failures, logLines))];
      for (const w of f.why) if (w.startsWith('⏱')) block.push(`    ${w}`);
      const room = Math.max(0, input.maxDiffs - diffsShown);
      for (const d of f.diffs.slice(0, room)) block.push(diffLine(ctx, d, numberOf));
      diffsShown += Math.min(room, f.diffs.length);
      if (f.diffs.length > room) block.push(`    … ${f.diffs.length - room} more hop diffs - check_calls with a higher maxDiffs`);
      const blockSize = block.join('\n').length + 1;
      if (shownFlagged.length && size + blockSize > REPLY_BUDGET) { notShown.push(numberOf.get(f.item.call!.id)!); continue; }
      out.push(...block);
      size += blockSize;
      shownFlagged.push(numberOf.get(f.item.call!.id)!);
    }
    if (notShown.length) out.push(`  … ${notShown.length} more flagged calls did not fit: ${ranges(notShown)} - triage or investigate_call them`);
    if (flows.length) {
      out.push('', `Flows (${flows.length}) - calls linked by the values they carry:`);
      for (const f of flows.slice(0, 10)) {
        const ns = f.callIds.map((id) => numberOf.get(owner.get(id) ?? id)).filter((n): n is number => n != null);
        out.push(`  ${ranges([...new Set(ns)].sort((a, b) => a - b))} via ${f.anchors.slice(0, 4).map((a) => maskText(ctx, a)).join(', ')}${f.anchors.length > 4 ? ` +${f.anchors.length - 4}` : ''}`);
      }
    }
    if (clean.length) out.push('', `Clean (${clean.length}): ${ranges(clean)}`);
    if (unmarked.length) out.push(`No saved mark (${unmarked.length}, checked by status only - recorded before triage, or past its row cap): ${ranges(unmarked)}`);
    if (notCompared) out.push(`No JSON/XML body (${notCompared}) - not in the hop diffs.`);
    out.push('', JSON.stringify({
      cycleId: found.id, checked: windowCalls.length, flagged: flagged.map((f) => numberOf.get(f.item.call!.id)), clean: clean.length,
      pending: pending.map((e) => numberOf.get(e.call.id)), hopDiffs: diffs.length, lastCallId, recording: found.status === 'RECORDING', ...maskMeta(ctx),
    }));
    return text(out.join('\n'));
  }));
}
