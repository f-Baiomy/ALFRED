import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient } from '../alfred-client.ts';
import { hydrate, liveSummary, partsFor, select, toRow, withParts, FIELD_NAMES, type Direction, type FieldName } from '../calls.ts';
import { cycleCallCount, findCycle, listCycleCalls, requireCycle, segmentOf, type CycleEntry } from '../cycle-calls.ts';
import { analysisOf, childrenOf, dbSummaries, loadCapture, nonNoteFindings } from '../db-capture.ts';
import {
  layoutSpacers, type CallEndpointSource, type CallRecord, type Comment, type CycleSpacer, type SessionCycle,
} from '../frontend.ts';
import { maskCall, maskContext, maskMeta, maskText } from '../masking.ts';
import { invalid, ok, preview, run, REPLY_BUDGET, text } from '../reply.ts';

export const CallRefSchema = z.object({
  id: z.string().min(1),
  direction: z.enum(['inbound', 'outbound']).optional().describe('inbound = into a project Alfred fronts (e.g. odeysys); outbound = to a supplier. Detected when omitted.'),
});
export const FieldsSchema = z.array(z.enum(FIELD_NAMES)).max(FIELD_NAMES.length).optional()
  .describe('Return only these fields per call. Header/body fields fetch only the parts named.');
export const PathsSchema = z.array(z.string().regex(/^[A-Za-z0-9_.\-]+$/)).max(20).optional()
  .describe('Extra dot paths into the call record, e.g. response.headers.content-type or request.body');
export const MaskSchema = z.boolean().optional().describe('Override this session\'s maskSecrets for this one request.');

const COPY_BATCH = 20;

function hhmmss(timestamp: string): string {
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? timestamp : d.toISOString().slice(11, 23);
}

function storyLine(n: number, call: CallRecord): string {
  const row = toRow(call);
  const status = row.status ?? (call.error ? `ERROR ${call.error}` : call.state ?? '-');
  const ms = row.durationMs != null ? `${Math.round(row.durationMs)} ms` : 'in progress';
  return `#${n} ${hhmmss(call.timestamp)} ${row.direction === 'inbound' ? 'IN ' : 'OUT'} ${call.method} ${row.url} → ${status} (${ms}) id=${call.id}`;
}

async function commentsOf(client: AlfredClient, callId: string): Promise<Comment[]> {
  return client.get<Comment[]>('/comments', { query: { callId } });
}

/** A cycle's record that cannot be one: Relive's own run cycles are not session cycles to edit. */
function assertEditable(cycle: SessionCycle): void {
  if (cycle.reliveRunId) throw invalid(`Cycle "${cycle.name}" belongs to a Relive run; it holds that run's calls and is not edited from here.`);
}

interface CopyReport { added: number; skipped: number; notFound: string[] }

/** Hydrates every call (summary + full detail, as the UI's bulk bar does) and copies it in, grouped by direction. */
export async function copyIntoCycle(client: AlfredClient, cycleId: string, refs: readonly { id: string; direction?: Direction }[]): Promise<CopyReport> {
  const report: CopyReport = { added: 0, skipped: 0, notFound: [] };
  const hydrated = await Promise.all(refs.map(async (ref) => {
    try {
      const { call, source } = await liveSummary(client, ref.id, ref.direction);
      return hydrate(client, { id: ref.id, source }, call);
    } catch (error) {
      if (error instanceof AlfredError && error.kind === 'not_found') {
        report.notFound.push(ref.id);
        return null;
      }
      throw error;
    }
  }));
  const bySource = new Map<CallEndpointSource, CallRecord[]>();
  for (const call of hydrated) {
    if (!call) continue;
    const source = call.source ?? 'external';
    bySource.set(source, [...(bySource.get(source) ?? []), call]);
  }
  for (const [source, calls] of bySource) {
    for (let i = 0; i < calls.length; i += COPY_BATCH) {
      const result = await client.post<{ added: number; skipped: number }>(`/session-cycles/${seg(cycleId)}/${segmentOf(source)}/copy`, {
        body: { calls: calls.slice(i, i + COPY_BATCH) },
        notFound: `Session cycle ${cycleId} not found.`,
      });
      report.added += result.added;
      report.skipped += result.skipped;
    }
  }
  return report;
}

interface StoryInput {
  cycle: string; offset: number; limit: number; fields?: FieldName[]; paths?: string[];
  includeDb: boolean; includeComments: boolean; mask?: boolean;
}

async function cycleStory(client: AlfredClient, input: StoryInput) {
  const found = await findCycle(client, input.cycle);
  if ('candidates' in found) {
    return ok({ candidates: found.candidates }, `"${input.cycle}" matches ${found.candidates.length} cycles - ask which one, then call get_cycle with its id.`);
  }
  const cycle = found;
  const ctx = await maskContext(client, input.mask);
  const { entries, spacers } = await listCycleCalls(client, cycle.id);
  const calls = entries.map((e) => e.call);

  // Placement is layoutSpacers' alone (the invariant every view and export follows), over the WHOLE
  // cycle so a spacer anchored to a call on another page still lands where the UI shows it.
  const layout = layoutSpacers(calls, (c) => c, spacers, { descending: false, byTime: true });
  const before = new Map<number, CycleSpacer[]>();
  const tail: CycleSpacer[] = [];
  let pending: CycleSpacer[] = [];
  let index = 0;
  for (const entry of layout.merged) {
    if (entry.kind === 'spacer') {
      pending.push(entry.spacer);
    } else {
      if (pending.length) before.set(index, pending);
      pending = [];
      index++;
    }
  }
  tail.push(...pending);

  const page = calls.slice(input.offset, input.offset + input.limit);
  const pageEntries = entries.slice(input.offset, input.offset + input.limit);
  const inbound = page.filter((c) => c.source === 'internal').map((c) => c.id);
  const summaries = input.includeDb ? await dbSummaries(client, inbound) : {};

  const blocks = await Promise.all(pageEntries.map(async (entry, i) => {
    const n = input.offset + i + 1;
    const lines: string[] = [];
    for (const s of before.get(input.offset + i) ?? []) lines.push(`── ${maskText(ctx, s.label)} ── (spacer ${s.id})`);
    let call = entry.call;
    const parts = partsFor(input.fields, input.paths);
    if (parts.length) call = await withParts(client, { id: call.id, source: call.source ?? 'external', cycleId: cycle.id }, call, parts);
    call = maskCall(ctx, call);
    lines.push(storyLine(n, call));
    const wants = (f: FieldName) => !!input.fields?.includes(f);
    const comments = input.includeComments || wants('comments') ? await commentsOf(client, call.id) : [];
    let db: { summary: string; statements: number; findings: { severity: string; title: string; short: string; seqs: readonly number[] }[] } | null = null;
    if ((input.includeDb || wants('db')) && call.source === 'internal') {
      if (!input.includeDb && !(call.id in summaries)) Object.assign(summaries, await dbSummaries(client, [call.id]));
      if (summaries[call.id]) {
        const capture = await loadCapture(client, call.id);
        const analysis = analysisOf(call, capture, await childrenOf(client, call.id));
        db = {
          summary: maskText(ctx, analysis.summary ?? `${capture.statements.length} statements`), statements: capture.statements.length,
          findings: nonNoteFindings(analysis).map((f) => ({ severity: f.severity, title: maskText(ctx, f.title), short: maskText(ctx, f.short), seqs: f.seqs })),
        };
      }
    }
    if (input.fields?.length || input.paths?.length) {
      // The supplier calls this inbound call made: its copies in this cycle, else the live parent link.
      const inCycle = calls.filter((c) => c.parentCallId === call.id);
      const children = wants('children') && call.source === 'internal'
        ? (inCycle.length ? inCycle : await childrenOf(client, call.id)).map((c) => ({ ...toRow(maskCall(ctx, c)), inCycle: inCycle.includes(c) }))
        : undefined;
      const extras = {
        children: wants('children') ? children ?? [] : undefined,
        comments: wants('comments') ? comments.map((c) => ({ id: c.id, block: c.block, line: c.lineIndex + 1, comment: preview(maskText(ctx, c.comment), 300, `list_comments commentId ${c.id}`) })) : undefined,
        db: wants('db') ? db : undefined,
      };
      const sel = select(call, input.fields, input.paths, extras, 0, 2000);
      lines.push(`   ${JSON.stringify(sel.values)}${sel.missing.length ? ` missing=${JSON.stringify(sel.missing)}` : ''}`);
    }
    if (input.includeComments) {
      for (const c of comments) {
        // A comment can be a whole pasted stack trace; the story shows its start, list_comments the rest.
        const note = preview(maskText(ctx, c.comment).replace(/\s*\n\s*/g, ' ⏎ '), 300, `list_comments callId ${call.id} commentId ${c.id}`);
        lines.push(`   💬 [${c.block} L${c.lineIndex + 1}] ${note} (comment ${c.id})`);
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

  const head = `Cycle "${cycle.name}" (${cycle.id}) - ${cycle.status === 'RECORDING' ? 'RECORDING' : 'paused'}, ${entries.length} calls, created ${cycle.createdAt}`;
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
  const meta = { cycleId: cycle.id, totalCalls: entries.length, offset: input.offset, shown, nextOffset, ...maskMeta(ctx) };
  out.push('', JSON.stringify(meta));
  return text(out.join('\n'));
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('list_cycles', {
    description: 'List Alfred session cycles (recorded or assembled sets of calls) with id, name, status (RECORDING/PAUSED), creation time and call count.',
    inputSchema: {
      nameContains: z.string().optional(),
      status: z.enum(['recording', 'paused']).optional(),
    },
  }, (input) => run(async () => {
    const cycles = (await client.get<SessionCycle[]>('/session-cycles'))
      .filter((c) => !input.nameContains || c.name.toLowerCase().includes(input.nameContains.toLowerCase()))
      .filter((c) => !input.status || c.status === input.status.toUpperCase());
    const rows = await Promise.all(cycles.map(async (c) => ({
      id: c.id, name: c.name, status: c.status, createdAt: c.createdAt, assignedTo: c.assignedTo, callCount: await cycleCallCount(client, c.id),
    })));
    return ok({ cycles: rows });
  }));

  server.registerTool('get_cycle', {
    description: 'THE debugging view of a session cycle: its calls in run order (inbound and outbound together) with status and time, '
      + 'spacers in place, comments under their call, and for calls with database capture the summary line and findings worth acting on. '
      + 'Pass a cycle id or part of its name. Page with offset/limit; nextOffset says where the next page starts.',
    inputSchema: {
      cycle: z.string().min(1).describe('Cycle id, or text from its name'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      fields: FieldsSchema,
      paths: PathsSchema,
      includeDb: z.boolean().default(true),
      includeComments: z.boolean().default(true),
      mask: MaskSchema,
    },
  }, (input) => run(() => cycleStory(client, input)));

  server.registerTool('create_cycle', {
    description: 'Create a session cycle, empty or directly from live calls (copied in, originals stay in the live log). '
      + 'It is left paused unless record is true - a new cycle that records captures every live call from then on.',
    inputSchema: {
      name: z.string().min(1).max(500),
      calls: z.array(CallRefSchema).max(200).optional(),
      record: z.boolean().default(false).describe('Start recording live calls into it right away'),
    },
  }, (input) => run(async () => {
    let cycle = await client.post<SessionCycle>('/session-cycles', { body: { name: input.name } });
    // Alfred creates a cycle already RECORDING (the UI's "new cycle, then reproduce" flow). A cycle
    // assembled from chosen calls must not also fill up with whatever live traffic happens next.
    if (cycle.status === 'RECORDING' && !input.record) cycle = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/pause`);
    if (cycle.status !== 'RECORDING' && input.record) cycle = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/record`);
    const copy = input.calls?.length ? await copyIntoCycle(client, cycle.id, input.calls) : undefined;
    return ok({ cycle, ...(copy ? { copy } : {}) });
  }));

  server.registerTool('rename_cycle', {
    description: 'Rename a session cycle.',
    inputSchema: { cycleId: z.string().min(1), name: z.string().min(1).max(500) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    assertEditable(cycle);
    return ok(await client.patch<SessionCycle>(`/session-cycles/${seg(cycle.id)}`, { body: { name: input.name } }));
  }));

  server.registerTool('start_recording', {
    description: 'Start recording a session cycle: new calls are captured into it until stop_recording. Several cycles may record at once; the reply lists the others.',
    inputSchema: { cycleId: z.string().min(1) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    assertEditable(cycle);
    const after = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/record`);
    const others = (await client.get<SessionCycle[]>('/session-cycles')).filter((c) => c.status === 'RECORDING' && c.id !== cycle.id);
    return ok({ cycle: after, changed: cycle.status !== after.status, otherRecording: others.map((c) => ({ id: c.id, name: c.name })) });
  }));

  server.registerTool('stop_recording', {
    description: 'Stop (pause) recording a session cycle. Calls already captured stay.',
    inputSchema: { cycleId: z.string().min(1) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    assertEditable(cycle);
    const after = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/pause`);
    return ok({ cycle: after, changed: cycle.status !== after.status });
  }));

  server.registerTool('add_calls_to_cycle', {
    description: 'Copy live calls (inbound and/or outbound, by id) into a session cycle. Reports added, skipped (already in it) and not found.',
    inputSchema: { cycleId: z.string().min(1), calls: z.array(CallRefSchema).min(1).max(200) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    assertEditable(cycle);
    return ok(await copyIntoCycle(client, cycle.id, input.calls));
  }));

  server.registerTool('remove_calls_from_cycle', {
    description: 'Remove calls (by call id) from a session cycle. Only the cycle\'s copies go; the live log is untouched.',
    inputSchema: { cycleId: z.string().min(1), calls: z.array(CallRefSchema).min(1).max(200) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    assertEditable(cycle);
    const { entries } = await listCycleCalls(client, cycle.id);
    // Remove takes the cycle's own entry id, not the call id Claude knows the call by.
    const byCallId = new Map<string, CycleEntry>();
    for (const e of entries) byCallId.set(e.call.id, e);
    const notFound: string[] = [];
    const bySource = new Map<CallEndpointSource, string[]>();
    for (const ref of input.calls) {
      const entry = byCallId.get(ref.id) ?? entries.find((e) => e.capturedId === ref.id);
      if (!entry) { notFound.push(ref.id); continue; }
      const source = entry.call.source ?? 'external';
      bySource.set(source, [...(bySource.get(source) ?? []), entry.capturedId]);
    }
    let removed = 0;
    for (const [source, ids] of bySource) {
      const result = await client.post<{ removed: number; notFound: number }>(`/session-cycles/${seg(cycle.id)}/${segmentOf(source)}/remove`, { body: { callIds: ids } });
      removed += result.removed;
    }
    return ok({ removed, notFound });
  }));
}

