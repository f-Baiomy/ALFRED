import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { toRow } from '../calls.ts';
import { findCycle, listCycleCalls } from '../cycle-calls.ts';
import { dbSummaries } from '../db-capture.ts';
import type { CallRecord, CallStatementFailures, CommentCount, TriageEntry } from '../frontend.ts';
import { maskCall, maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { invalid, ok, REPLY_BUDGET, run, text } from '../reply.ts';
import { resolveFrames } from '../source.ts';
import { GROUP_TITLES, outcomeOf, statementFailuresOf, triageCounts, triageLive, triageOf } from '../triage.ts';
import { MaskSchema } from './cycles.ts';

/**
 * triage: "what needs attention first", from the marks Alfred saves as calls arrive (backend-triage) - a cycle of any
 * size costs one request for the marks and one for the failed statements, and no body is read. Every call is in
 * exactly one group, its highest, with all its evidence; group 6 holds the rest and is never left out: the groups are
 * a reading order, not a filter.
 */

const STATEMENTS_SHOWN = 5;
const SIGNAL_DB_FLAGS = new Set(['QUERY_FAN_OUT', 'DUPLICATE', 'REPEATED_QUERY', 'SLOW', 'HUGE_RESULT', 'LOCK_DURING_SUPPLIER_CALL',
  'NO_WHERE', 'LARGE_DELETE', 'TX_PER_STATEMENT', 'ROLLED_BACK']);

interface Item {
  /** "#12" in a cycle, a short id live. */
  readonly label: string;
  readonly entry: TriageEntry | null;
  /** The cycle's copy (masked) - null for live triage, which works from the marks alone. */
  readonly call: CallRecord | null;
}

function hostOf(url: string | null | undefined): string {
  try {
    return new URL(url ?? '').host;
  } catch {
    return url ?? '';
  }
}

function ms(value: number | null | undefined): string {
  return value == null ? '' : ` (${Math.round(value)} ms)`;
}

/** The first frame of a statement's chain, resolved to a file of the project Claude is working in. */
async function frameLine(chain: readonly string[]): Promise<string | null> {
  if (!chain.length) return null;
  const first = (await resolveFrames(chain))[0];
  const where = first.source ?? (first.candidates ? first.candidates.join(' | ') : null);
  return `at ${first.frame}${where ? ` → ${where}` : ''}`;
}

async function evidence(ctx: MaskContext, item: Item, numberOf: ReadonlyMap<string, number>, failures: Record<string, CallStatementFailures>): Promise<string[]> {
  const e = item.entry;
  if (!e) return [];
  const lines: string[] = [];
  for (const s of e.failingSupplierCalls) {
    const n = numberOf.get(s.callId);
    const soft = s.softFailure ? ` ✖ ${s.softFailure.code ? `${maskText(ctx, s.softFailure.code)}: ` : ''}${maskText(ctx, s.softFailure.message)}` : '';
    lines.push(`    ↳ ${n ? `#${n}` : `id=${s.callId}`} ${s.method ?? ''} ${maskText(ctx, hostOf(s.url))} → ${maskText(ctx, outcomeOf(s))}${soft}`);
  }
  const failed = failures[e.callId];
  if (failed) {
    for (const st of failed.statements.slice(0, STATEMENTS_SHOWN)) {
      const tags = [st.swallowed ? 'swallowed' : '', st.undone ? 'rolled back' : ''].filter(Boolean).join(' · ');
      lines.push(`    ✖ DB #${st.seq} ${st.kind}${st.table ? ` ${st.table}` : ''} failed ${st.sqlState ?? ''} ${maskText(ctx, st.message ?? '')}`.trimEnd()
        + `${tags ? ` · ${tags}` : ''} (statement ${st.id})`);
      const at = await frameLine(st.callers?.length ? st.callers : st.codeLocation ? [st.codeLocation] : []);
      if (at) lines.push(`      ${at}`);
    }
    if (failed.failedCount > STATEMENTS_SHOWN) {
      lines.push(`    … ${failed.failedCount - STATEMENTS_SHOWN} more failed statements - db_statements callId ${e.callId} failedOnly: true`);
    }
  } else if (e.failedStatements) {
    lines.push(`    ✖ DB ${e.failedStatements} failed statement${e.failedStatements > 1 ? 's' : ''} - db_statements callId ${e.callId} failedOnly: true`);
  }
  if (e.softFailure) {
    lines.push(`    ✖ inside its body: ${e.softFailure.code ? `${maskText(ctx, e.softFailure.code)}: ` : ''}${maskText(ctx, e.softFailure.message)}`);
  }
  if (e.emptyKeys.length && e.direction === 'INBOUND') lines.push(`    ∅ empty result: ${e.emptyKeys.join(', ')}`);
  return lines;
}

function headLine(ctx: MaskContext, item: Item): string {
  if (item.call) {
    const row = toRow(item.call);
    const outcome = item.entry ? outcomeOf(item.entry) : row.status ?? (item.call.error ? `ERROR ${item.call.error}` : item.call.state ?? '-');
    return `${item.label} ${row.direction === 'inbound' ? 'IN ' : 'OUT'} ${item.call.method} ${row.url} → ${outcome}${ms(row.durationMs)} id=${item.call.id}`;
  }
  const e = item.entry!;
  return `${item.label} ${e.direction === 'INBOUND' ? 'IN ' : 'OUT'} ${e.method ?? ''} ${maskText(ctx, e.url ?? '')} → ${maskText(ctx, outcomeOf(e))}${ms(e.durationMs)}`
    + ` id=${e.callId}${e.project ? ` (${e.project})` : ''}`;
}

/** Group 6's own order: calls with something worth a look (comments, database findings, much slower than the rest) first. */
async function signalsOf(client: AlfredClient, items: readonly Item[]): Promise<Map<string, string[]>> {
  const signals = new Map<string, string[]>();
  const add = (id: string, s: string) => signals.set(id, [...(signals.get(id) ?? []), s]);
  const ids = items.map((i) => i.entry?.callId ?? i.call?.id).filter((x): x is string => !!x);
  if (!ids.length) return signals;
  const counts: Record<string, CommentCount> = {};
  for (let i = 0; i < ids.length; i += 500) {
    Object.assign(counts, await client.get<Record<string, CommentCount>>('/comments/counts', { query: { callIds: ids.slice(i, i + 500).join(',') } }).catch(() => ({})));
  }
  for (const [id, c] of Object.entries(counts)) if (c.total) add(id, `💬 ${c.total}`);
  const inbound = items.filter((i) => (i.entry?.direction ?? (i.call?.source === 'internal' ? 'INBOUND' : 'OUTBOUND')) === 'INBOUND')
    .map((i) => i.entry?.callId ?? i.call!.id);
  for (let i = 0; i < inbound.length; i += 500) {
    const summaries = await dbSummaries(client, inbound.slice(i, i + 500)).catch(() => ({}));
    for (const [id, s] of Object.entries(summaries)) {
      const flags = [...new Set(s.flags.filter((f) => SIGNAL_DB_FLAGS.has(f.type)).map((f) => f.type.toLowerCase().replace(/_/g, ' ')))];
      if (flags.length) add(id, `◆ DB ${flags.join(', ')}`);
    }
  }
  const durations = items.map((i) => i.entry?.durationMs ?? i.call?.duration_ms ?? null).filter((d): d is number => d != null).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
  for (const i of items) {
    const d = i.entry?.durationMs ?? i.call?.duration_ms ?? null;
    if (d != null && d >= 1000 && d >= 3 * median) add(i.entry?.callId ?? i.call!.id, `${Math.round(d)} ms (${median ? `${Math.round(d / median)}× the median` : 'slow'})`);
  }
  return signals;
}

interface RenderInput {
  readonly groupOnly?: number;
  readonly offset: number;
  readonly limit: number;
}

async function render(client: AlfredClient, ctx: MaskContext, head: string, items: Item[], numberOf: ReadonlyMap<string, number>, input: RenderInput,
                      trailer: Record<string, unknown>, otherCount = 0): Promise<string> {
  const groups = new Map<number, Item[]>();
  for (const item of items) {
    const p = item.entry?.priority ?? 6;
    groups.set(p, [...(groups.get(p) ?? []), item]);
  }
  const totals: Record<number, number> = {};
  for (let p = 1; p <= 6; p++) totals[p] = (groups.get(p)?.length ?? 0) + (p === 6 ? otherCount : 0);

  // Evidence for what this reply will show: one request for every failed statement among them.
  const showing = (p: number) => (input.groupOnly === undefined || input.groupOnly === p);
  const pageOf = (p: number) => (groups.get(p) ?? []).slice(showing(p) && input.groupOnly ? input.offset : 0, (showing(p) && input.groupOnly ? input.offset : 0) + input.limit);
  const needFailures = [1, 2, 3, 4, 5].filter(showing).flatMap(pageOf).map((i) => i.entry).filter((e): e is TriageEntry => !!e && e.failedStatements > 0);
  const failures = await statementFailuresOf(client, needFailures.map((e) => e.callId)).catch(() => ({} as Record<string, CallStatementFailures>));

  const out: string[] = [head, ''];
  let size = head.length + 800;
  const shown: Record<number, number> = {};
  const next: Record<number, number> = {};
  let full = false;
  for (let p = 1; p <= 6; p++) {
    if (!showing(p)) continue;
    const all = groups.get(p) ?? [];
    if (!all.length && !(p === 6 && otherCount)) continue;
    const start = input.groupOnly ? input.offset : 0;
    if (full) { next[p] = start; continue; }
    out.push(`${p} · ${GROUP_TITLES[p]} (${totals[p]})`);
    let count = 0;
    if (p < 6) {
      for (const item of all.slice(start, start + input.limit)) {
        const block = [`  ${headLine(ctx, item)}`, ...(await evidence(ctx, item, numberOf, failures))];
        const blockSize = block.join('\n').length + 1;
        if (count > 0 && size + blockSize > REPLY_BUDGET) { full = true; break; }
        out.push(...block);
        size += blockSize;
        count++;
      }
    } else {
      const signals = await signalsOf(client, all);
      const ordered = [...all].sort((a, b) => Number(signals.has(b.entry?.callId ?? b.call!.id)) - Number(signals.has(a.entry?.callId ?? a.call!.id)));
      const rest: string[] = [];
      for (const item of ordered.slice(start, start + input.limit)) {
        const id = item.entry?.callId ?? item.call!.id;
        const s = signals.get(id);
        if (s) {
          const line = `  ${headLine(ctx, item)}  ${s.join(' · ')}`;
          if (count > 0 && size + line.length + 1 > REPLY_BUDGET) { full = true; break; }
          out.push(line);
          size += line.length + 1;
        } else {
          rest.push(item.label);
        }
        count++;
      }
      if (rest.length) {
        const line = `  ${rest.join(' ')} - nothing flagged`;
        out.push(line);
        size += line.length + 1;
      }
      if (otherCount) out.push(`  … ${otherCount} more calls in the window with nothing flagged - search_calls lists them`);
    }
    shown[p] = count;
    if (start + count < all.length) next[p] = start + count;
    out.push('');
  }
  out.push(JSON.stringify({
    ...trailer, totals, shown, ...(Object.keys(next).length ? { next, more: 'triage again with group and offset for the rest of a group' } : {}), ...maskMeta(ctx),
  }));
  return out.join('\n');
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('triage', {
    description: 'START HERE when debugging: what needs attention first, with the evidence attached - for a session cycle, or for the live calls of a '
      + 'project in a time window. Groups, in reading order: 1 failed (status >= minStatus or an error) with failing supplier calls; 2 failed with '
      + 'failed database statements; 3 other failed; 4 succeeded but a supplier call or statement under it failed (hidden failures); 5 succeeded '
      + 'with an error inside its body (e.g. OTA Error 322 in a 200) or an empty result; 6 everything else, commented/slow/flagged first. Every '
      + 'call is listed once, in its highest group. Read from Alfred\'s saved marks - fast for any size. Groups order the work; they exclude nothing.',
    inputSchema: {
      cycle: z.string().optional().describe('Cycle id or text from its name. Without it: the live calls (project / from / to)'),
      project: z.string().optional().describe('Live only: the project, e.g. odeysys'),
      from: z.string().datetime({ offset: true }).optional().describe('Live only: window start (default: minutes ago)'),
      to: z.string().datetime({ offset: true }).optional(),
      minutes: z.number().int().min(1).max(10_080).default(60).describe('Live only: the window when from is not given'),
      minStatus: z.number().int().min(300).max(600).default(300).describe('A status at or above this needs attention (300 counts redirects)'),
      includeOptions: z.boolean().default(false).describe('Cycle only: list CORS OPTIONS preflights too'),
      group: z.number().int().min(1).max(6).optional().describe('Only this group (to page through it with offset)'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(20).describe('Calls per group'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const page = { groupOnly: input.group, offset: input.offset, limit: input.limit };
    if (input.cycle) {
      if (input.project || input.from || input.to) throw invalid('Give either cycle, or project/from/to for the live calls - not both.');
      const found = await findCycle(client, input.cycle);
      if ('candidates' in found) {
        return ok({ candidates: found.candidates }, `"${input.cycle}" matches ${found.candidates.length} cycles - ask which one, then call triage with its id.`);
      }
      const listed = await listCycleCalls(client, found.id);
      const visible = input.includeOptions ? listed.entries : listed.entries.filter((e) => e.call.method !== 'OPTIONS');
      const calls = visible.map((e) => e.call);
      const numberOf = new Map(calls.map((c, i) => [c.id, i + 1]));
      const marks = await triageOf(client, calls.map((c) => c.id), input.minStatus);
      // A supplier call made by an inbound call of this cycle is evidence under that call, not an entry of its own.
      const inbound = new Set(calls.filter((c) => c.source === 'internal').map((c) => c.id));
      const parentOf = (c: CallRecord) => marks[c.id]?.parentCallId ?? c.parentCallId ?? null;
      const items: Item[] = calls
        .filter((c) => c.source === 'internal' || !inbound.has(parentOf(c) ?? ''))
        .map((c) => ({ label: `#${numberOf.get(c.id)}`, entry: marks[c.id] ?? null, call: maskCall(ctx, c) }));
      const unmarked = items.filter((i) => !i.entry).length;
      const head = `triage cycle "${found.name}" (${found.id}) - ${calls.length} calls, minStatus ${input.minStatus}`
        + `${listed.entries.length - visible.length ? ` (+${listed.entries.length - visible.length} OPTIONS hidden)` : ''}`
        + `${unmarked ? ` - ${unmarked} have no saved mark (recorded before triage, or past its row cap) and are listed under 6` : ''}`;
      return text(await render(client, ctx, head, items, numberOf, page, { cycleId: found.id, calls: calls.length, minStatus: input.minStatus }));
    }
    const since = input.from ?? new Date(Date.now() - input.minutes * 60_000).toISOString();
    const [entries, counts] = await Promise.all([
      triageLive(client, { project: input.project, since, to: input.to, maxPriority: 5, minStatus: input.minStatus, limit: 500 }),
      triageCounts(client, input.project, since, input.to),
    ]);
    const all = Object.values(counts).reduce((a, b) => a + b, 0);
    const items: Item[] = entries.map((e) => ({ label: `${e.callId.slice(0, 8)}…`, entry: e, call: null }));
    const head = `triage live${input.project ? ` project "${input.project}"` : ''}, ${since}${input.to ? ` to ${input.to}` : ' to now'} - `
      + `${all} calls, minStatus ${input.minStatus}`;
    return text(await render(client, ctx, head, items, new Map(), page,
      { project: input.project ?? null, since, to: input.to ?? null, calls: all, minStatus: input.minStatus }, Math.max(0, all - entries.length)));
  }));
}

