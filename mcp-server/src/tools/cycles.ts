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
import { invalid, ok, run } from '../reply.ts';
import { cycleStory } from '../story.ts';

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
      + 'errors hidden in 200 responses (✖ code: message), empty results (∅), the supplier calls each inbound call made (↳), '
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
      includeOptions: z.boolean().default(false).describe('Show CORS OPTIONS preflights (hidden and counted by default, as in the UI)'),
      checkBodies: z.boolean().default(true).describe('Read each response body to flag errors inside 200s (✖) and empty results (∅)'),
      bodyPreview: z.number().int().min(0).max(500).default(0).describe('Show the first N characters of each response body'),
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
      board: z.string().min(1).max(200).optional().describe('Relate the new cycle to this board (task)'),
    },
  }, (input) => run(async () => {
    let cycle = await client.post<SessionCycle>('/session-cycles', { body: { name: input.name } });
    // related paused, then started through the guard: one project records into one cycle at a time (FR-008)
    if (input.board) {
      if (cycle.status === 'RECORDING') cycle = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/pause`);
      await client.put(`/board/boards/${seg(input.board)}/cycles/${seg(cycle.id)}`);
      if (input.record) {
        try {
          cycle = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/record`);
        } catch (e) {
          if (!(e instanceof AlfredError && e.code === 'RECORDING_CONFLICT')) throw e;
          const copy = input.calls?.length ? await copyIntoCycle(client, cycle.id, input.calls) : undefined;
          return ok({ cycle, ...(copy ? { copy } : {}), recording: 'RUNNING',
            note: e.message.replace(/^Alfred rejected the request \(409\): /, '') + ' - ask the user; start_recording with onRunning PAUSE_OTHER' });
        }
      }
      const copy = input.calls?.length ? await copyIntoCycle(client, cycle.id, input.calls) : undefined;
      return ok({ cycle, board: input.board, ...(copy ? { copy } : {}) });
    }
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

  server.registerTool('cycle_summary', {
    description: "Write Claude's summary of a session cycle (specs/033): 2-4 sentences under the user's description - which cards "
      + 'pass, what still fails (with the call and the line), what was not reached. Never changes the description; replaces '
      + "your earlier summary. Refused when the user switched Claude's summaries off on the board.",
    inputSchema: {
      cycleId: z.string().min(1),
      summary: z.string().min(1).max(8000),
      board: z.string().min(1).max(200).optional().describe("The board you write it for - its \"Claude's summaries\" switch is checked"),
    },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    if (input.board) {
      const prefs = await client.get<{ claudeSummaries: boolean }>(`/board/boards/${seg(input.board)}/cycle-prefs`).catch(() => ({ claudeSummaries: true }));
      if (!prefs.claudeSummaries) throw invalid("The user switched Claude's cycle summaries off on this board - write nothing");
    }
    const saved = await client.put<SessionCycle>(`/session-cycles/${seg(cycle.id)}/notes`, { body: { summary: input.summary } });
    return ok({ cycleId: saved.id, summary: saved.summary });
  }));

  server.registerTool('start_recording', {
    description: 'Start recording a session cycle: new calls are captured into it until stop_recording. One project records into one '
      + 'cycle at a time: when another cycle of the same project records, onRunning ASK (default) answers RUNNING - ask the '
      + 'user, then call again with PAUSE_OTHER to pause it. The reply lists the other cycles recording.',
    inputSchema: { cycleId: z.string().min(1), onRunning: z.enum(['ASK', 'PAUSE_OTHER']).default('ASK') },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    assertEditable(cycle);
    let after: SessionCycle;
    try {
      after = await client.post<SessionCycle>(`/session-cycles/${seg(cycle.id)}/record`, { query: { onRunning: input.onRunning } });
    } catch (e) {
      if (e instanceof AlfredError && e.code === 'RECORDING_CONFLICT') {
        return ok({ result: 'RUNNING', note: e.message.replace(/^Alfred rejected the request \(409\): /, ''),
          next: 'Ask the user; start_recording again with onRunning PAUSE_OTHER pauses the other one' });
      }
      throw e;
    }
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

