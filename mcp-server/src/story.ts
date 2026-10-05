import type { AlfredClient } from './alfred-client.ts';
import { partsFor, select, toRow, withParts, type FieldName } from './calls.ts';
import { findCycle, listCycleCalls, type CycleEntry } from './cycle-calls.ts';
import { analysisOf, childrenOf, dbSummaries, loadCapture, nonNoteFindings } from './db-capture.ts';
import { emptyResultOf, layoutSpacers, softFailureOf, type CallRecord, type Comment, type CommentCount, type CycleSpacer } from './frontend.ts';
import { maskCall, maskContext, maskMeta, maskText, type MaskContext } from './masking.ts';
import { ok, preview, REPLY_BUDGET, text, type ToolReply } from './reply.ts';

/**
 * get_cycle's story: the cycle as a debugging narrative, one compact line per call in run order,
 * with what a reader looks for first right on that line - an error hidden in a 200, an empty
 * result, the supplier calls an inbound call made - and the spacers, comments and database
 * findings around it.
 */

export interface StoryInput {
  cycle: string;
  offset: number;
  limit: number;
  fields?: FieldName[];
  paths?: string[];
  includeDb: boolean;
  includeComments: boolean;
  includeOptions: boolean;
  checkBodies: boolean;
  bodyPreview: number;
  mask?: boolean;
}

interface DbView {
  summary: string;
  statements: number;
  findings: { severity: string; title: string; short: string; seqs: readonly number[] }[];
}

function hhmmss(timestamp: string): string {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? timestamp : d.toISOString().slice(11, 23);
}

function storyLine(n: number, call: CallRecord): string {
  const row = toRow(call);
  const status = row.status ?? (call.error ? `ERROR ${call.error}` : call.state ?? '-');
  const ms = row.durationMs != null ? `${Math.round(row.durationMs)} ms` : 'in progress';
  // ⚡: an interception rule (or a hand edit) changed this call - what is recorded is not what the caller sent or got.
  const applied = call.interception?.applied ?? [];
  const changed = applied.length ? ` ⚡ ${[...new Set(applied.map((a) => a.ruleName ?? a.action))].join(', ')}` : '';
  return `#${n} ${hhmmss(call.timestamp)} ${row.direction === 'inbound' ? 'IN ' : 'OUT'} ${call.method} ${row.url} → ${status} (${ms}) id=${call.id}${changed}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The flags a call's own body raises - the same detector the exports' "At a Glance" uses. */
function bodyFlags(ctx: MaskContext, call: CallRecord): string {
  const soft = softFailureOf(call);
  const empty = call.source === 'internal' ? emptyResultOf(call) : null;
  return (soft ? ` ✖ ${soft.code ? `${maskText(ctx, soft.code)}: ` : ''}${maskText(ctx, soft.message)}` : '')
    + (empty ? ` ∅ empty: ${empty.emptyKeys.join(', ')}` : '');
}

export async function cycleStory(client: AlfredClient, input: StoryInput): Promise<ToolReply> {
  const found = await findCycle(client, input.cycle);
  if ('candidates' in found) {
    return ok({ candidates: found.candidates }, `"${input.cycle}" matches ${found.candidates.length} cycles - ask which one, then call get_cycle with its id.`);
  }
  const cycle = found;
  const ctx = await maskContext(client, input.mask);
  const listed = await listCycleCalls(client, cycle.id);
  // CORS preflights say nothing about the flow and were half of a real 29-call cycle; the UI hides
  // them by default too. Hidden ones are counted, never silently dropped.
  const entries = input.includeOptions ? listed.entries : listed.entries.filter((e) => e.call.method !== 'OPTIONS');
  const hiddenOptions = listed.entries.length - entries.length;
  const calls = entries.map((e) => e.call);
  const numberOf = new Map(calls.map((c, i) => [c.id, i + 1]));

  // Placement is layoutSpacers' alone (the invariant every view and export follows), over the WHOLE
  // cycle so a spacer anchored to a call on another page still lands where the UI shows it.
  const before = new Map<number, CycleSpacer[]>();
  const tail: CycleSpacer[] = [];
  let pending: CycleSpacer[] = [];
  let index = 0;
  for (const entry of layoutSpacers(calls, (c) => c, listed.spacers, { descending: false, byTime: true }).merged) {
    if (entry.kind === 'spacer') {
      pending.push(entry.spacer);
    } else {
      if (pending.length) before.set(index, pending);
      pending = [];
      index++;
    }
  }
  tail.push(...pending);

  const pageEntries = entries.slice(input.offset, input.offset + input.limit);
  const wants = (f: FieldName) => !!input.fields?.includes(f);
  const needsDb = input.includeDb || wants('db');
  const summaries = needsDb ? await dbSummaries(client, pageEntries.filter((e) => e.call.source === 'internal').map((e) => e.call.id)) : {};
  // One counts request for the whole page; comment text is fetched only for calls that have some.
  const needsComments = input.includeComments || wants('comments');
  const commentCounts = needsComments && pageEntries.length
    ? await client.get<Record<string, CommentCount>>('/comments/counts', { query: { callIds: pageEntries.map((e) => e.call.id).join(',') } })
    : {};

  // Response bodies are read once per call and shared: the page's own calls and the supplier calls
  // listed under an inbound one both need theirs judged.
  const withBody = new Map<string, Promise<CallRecord>>();
  const bodied = (call: CallRecord): Promise<CallRecord> => {
    let found = withBody.get(call.id);
    if (!found) {
      found = withParts(client, { id: call.id, source: call.source ?? 'external', cycleId: cycle.id }, call, ['response-body'])
        .catch(() => call);
      withBody.set(call.id, found);
    }
    return found;
  };
  const readBodies = input.checkBodies || input.bodyPreview > 0;

  const blocks = await Promise.all(pageEntries.map(async (entry, i): Promise<string[]> => {
    const n = input.offset + i + 1;
    const lines: string[] = [];
    for (const s of before.get(input.offset + i) ?? []) lines.push(`── ${maskText(ctx, s.label)} ── (spacer ${s.id})`);

    let call = readBodies ? await bodied(entry.call) : entry.call;
    const parts = partsFor(input.fields, input.paths);
    if (parts.length) call = await withParts(client, { id: call.id, source: call.source ?? 'external', cycleId: cycle.id }, call, parts);
    call = maskCall(ctx, call);
    const flags = input.checkBodies ? bodyFlags(ctx, call) : '';

    const comments: Comment[] = needsComments && commentCounts[call.id]
      ? await client.get<Comment[]>('/comments', { query: { callId: call.id } }) : [];
    let db: DbView | null = null;
    if (needsDb && call.source === 'internal') {
      if (!(call.id in summaries)) Object.assign(summaries, await dbSummaries(client, [call.id]));
      if (summaries[call.id]) {
        const capture = await loadCapture(client, call.id);
        const analysis = analysisOf(call, capture, await childrenOf(client, call.id));
        db = {
          summary: maskText(ctx, analysis.summary ?? `${capture.statements.length} statements`), statements: capture.statements.length,
          findings: nonNoteFindings(analysis).map((f) => ({ severity: f.severity, title: maskText(ctx, f.title), short: maskText(ctx, f.short), seqs: f.seqs })),
        };
      }
    }

    // The supplier calls an inbound call made, by the live parent link and by the cycle copies' own
    // link (a copy may not carry it): one in this cycle is shown by its number, one not in it by id.
    let childEntries: CycleEntry[] = [];
    let liveChildren: CallRecord[] = [];
    if (call.source === 'internal') {
      const linked = await childrenOf(client, call.id);
      const ids = new Set([...linked.map((c) => c.id), ...listed.entries.filter((e) => e.call.parentCallId === call.id).map((e) => e.call.id)]);
      childEntries = listed.entries.filter((e) => ids.has(e.call.id));
      liveChildren = linked.filter((c) => !childEntries.some((e) => e.call.id === c.id));
    }
    const childLines = await Promise.all([
      ...childEntries.map(async (e) => {
        const child = maskCall(ctx, input.checkBodies ? await bodied(e.call) : e.call);
        const n = numberOf.get(child.id);
        return `${n ? `#${n}` : 'OPTIONS'} ${child.method} ${hostOf(child.url)} → ${child.response?.status ?? child.error ?? '-'}${input.checkBodies ? bodyFlags(ctx, child) : ''}`;
      }),
      ...liveChildren.map(async (c) => `${c.method} ${hostOf(c.url)} → ${c.response?.status ?? c.error ?? '-'} (not in this cycle, id=${c.id})`),
    ]);

    if (input.fields?.length || input.paths?.length) {
      // One compact line per call: its number and exactly the fields asked for, no repeated summary row.
      const extras = {
        children: wants('children') ? [
          ...childEntries.map((e) => ({ ...toRow(maskCall(ctx, e.call)), n: numberOf.get(e.call.id) ?? null, inCycle: true })),
          ...liveChildren.map((c) => ({ ...toRow(maskCall(ctx, c)), inCycle: false })),
        ] : undefined,
        comments: wants('comments') ? comments.map((c) => ({ id: c.id, block: c.block, line: c.lineIndex + 1, comment: preview(maskText(ctx, c.comment), 300, `list_comments commentId ${c.id}`) })) : undefined,
        db: wants('db') ? db : undefined,
      };
      const sel = select(call, input.fields, input.paths, extras, 0, 2000);
      lines.push(`#${n} ${JSON.stringify(sel.values)}${flags}${sel.missing.length ? ` missing=${JSON.stringify(sel.missing)}` : ''}`);
    } else {
      lines.push(`${storyLine(n, call)}${flags}`);
      if (childLines.length) lines.push(`   ↳ supplier calls: ${childLines.join('; ')}`);
    }
    if (input.bodyPreview > 0 && call.response?.body) {
      lines.push(`   ⤷ body: ${preview(call.response.body.replace(/\s*\n\s*/g, ' '), input.bodyPreview, `get_call_body id ${call.id}`)}`);
    }
    if (input.includeComments) {
      for (const c of comments) {
        // A comment can be a whole pasted stack trace; the story shows its start, list_comments the rest.
        const note = preview(maskText(ctx, c.comment).replace(/\s*\n\s*/g, ' ⏎ '), 300, `list_comments callId ${call.id} commentId ${c.id}`);
        lines.push(`   💬 [${c.block === 'call' ? 'call' : `${c.block} L${c.lineIndex + 1}`}] ${note} (comment ${c.id})`);
      }
    }
    if (db && input.includeDb) {
      lines.push(`   ◆ DB: ${db.summary}`);
      for (const f of db.findings) {
        lines.push(`   ${f.severity === 'bad' ? '✖' : '⚠'} ${f.title} - ${f.short} [#${f.seqs.slice(0, 12).join(', #')}${f.seqs.length > 12 ? ', …' : ''}]`);
      }
    }
    return lines;
  }));

  const head = `Cycle "${cycle.name}" (${cycle.id}) - ${cycle.status === 'RECORDING' ? 'RECORDING' : 'paused'}, ${entries.length} calls`
    + `${hiddenOptions ? ` (+${hiddenOptions} OPTIONS preflights hidden - includeOptions: true shows them)` : ''}, created ${cycle.createdAt}`;
  const out: string[] = [head, ''];
  let size = head.length + 400;
  let shown = 0;
  for (const block of blocks) {
    const blockSize = block.join('\n').length + 1;
    if (shown > 0 && size + blockSize > REPLY_BUDGET) break;
    out.push(...block);
    size += blockSize;
    shown++;
  }
  const end = input.offset + shown;
  if (end >= entries.length) for (const s of tail) out.push(`── ${maskText(ctx, s.label)} ── (spacer ${s.id})`);
  const nextOffset = end < entries.length ? end : null;
  out.push('', JSON.stringify({ cycleId: cycle.id, totalCalls: entries.length, hiddenOptions, offset: input.offset, shown, nextOffset, ...maskMeta(ctx) }));
  return text(out.join('\n'));
}
