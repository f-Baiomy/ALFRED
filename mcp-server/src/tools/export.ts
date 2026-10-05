import { createWriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { liveSummary } from '../calls.ts';
import { listSource, requireCycle } from '../cycle-calls.ts';
import { analysisOf, childrenOf } from '../db-capture.ts';
import {
  buildExportFile,
  type BuiltExport, type CallDbCapture, type CallDetail, type CallOverlapCandidate, type CallRecord, type Comment,
  type ExportedCycle, type ExportedSpacer, type ExportFormData, type ExportMetadata, type SessionCycle, type CycleSpacer,
} from '../frontend.ts';
import { maskContext } from '../masking.ts';
import { invalid, ok, run } from '../reply.ts';
import { session } from '../session.ts';
import { CallRefSchema } from './cycles.ts';
import { searchCalls, SearchSchema, SCAN_CAP } from './calls.ts';

const FORMATS = { md: 'markdown', json: 'json', html: 'html' } as const;

/**
 * Exports go through buildExportFile - the export dialog's own path - so the file is the one the UI
 * would write: same builder, same name, same masking (always on for files, whatever the session's
 * reply masking says). What is repeated here is only the fetching, mirrored from
 * cycle-export.service.ts (a whole cycle) and the bulk actions bar (a selection).
 */

interface Gathered {
  calls: CallRecord[];
  commentsByCallId: Map<string, readonly Comment[]>;
  overlapCandidates: readonly CallOverlapCandidate[];
  metadata: ExportMetadata | null;
  cycle: ExportedCycle | null;
  spacers: readonly ExportedSpacer[];
  listOrder: 'chronological' | 'as-shown';
}

function exportedCycleOf(cycle: SessionCycle): ExportedCycle {
  return { id: cycle.id, name: cycle.name, assignedTo: cycle.assignedTo, status: cycle.status, createdAt: cycle.createdAt ?? null };
}

function timeRange(calls: readonly CallRecord[]): { from: string; to: string } | null {
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const call of calls) {
    const start = new Date(call.timestamp).getTime();
    if (Number.isNaN(start)) continue;
    minStart = Math.min(minStart, start);
    maxEnd = Math.max(maxEnd, start + (call.duration_ms ?? 0));
  }
  return Number.isFinite(minStart) && Number.isFinite(maxEnd) ? { from: new Date(minStart).toISOString(), to: new Date(maxEnd).toISOString() } : null;
}

const NO_FILTERS = { search: '', supplier: '', sessionId: '', operationId: '', requestId: '' };

async function commentsFor(client: AlfredClient, calls: readonly CallRecord[]): Promise<Map<string, readonly Comment[]>> {
  const entries = await Promise.all(calls.map(async (c) =>
    [c.id, await client.get<Comment[]>('/comments', { query: { callId: c.id } }).catch(() => [] as Comment[])] as const));
  return new Map(entries);
}

async function gatherCycle(client: AlfredClient, cycleId: string): Promise<Gathered> {
  const cycle = await requireCycle(client, cycleId);
  // cycle-export.service: both directions, each paged in stored order, outbound first.
  const [external, internal] = await Promise.all([listSource(client, cycle.id, 'external', 'oldest'), listSource(client, cycle.id, 'internal', 'oldest')]);
  const summaries = [...external, ...internal].map((e) => e.call);
  if (summaries.length === 0) throw invalid(`"${cycle.name}" has no captured calls to export.`);
  const calls = await Promise.all(summaries.map(async (call) => ({
    ...call,
    ...await client.get<CallDetail>(`/session-cycles/${seg(cycle.id)}/${call.source === 'internal' ? 'internal-calls' : 'calls'}/${seg(call.id)}/detail`),
  } as CallRecord)));
  const range = timeRange(calls);
  const [commentsByCallId, overlapCandidates, metadata, spacers] = await Promise.all([
    commentsFor(client, calls),
    range ? client.get<CallOverlapCandidate[]>(`/session-cycles/${seg(cycle.id)}/call-overlaps`, { query: { ...range, ...NO_FILTERS } }).catch(() => []) : Promise.resolve([]),
    client.post<ExportMetadata>('/calls/export-metadata', { body: calls[0] }).catch(() => null),
    client.get<CycleSpacer[]>(`/session-cycles/${seg(cycle.id)}/spacers`)
      .then((list) => list.map((s) => ({ label: s.label, afterCallId: s.afterCallId ?? null, anchorTimestamp: s.anchorTimestamp ?? null })))
      .catch(() => [] as ExportedSpacer[]),
  ]);
  return { calls, commentsByCallId, overlapCandidates, metadata, cycle: exportedCycleOf(cycle), spacers, listOrder: 'chronological' };
}

/** A selection (ids, or a search's result) exports like the bulk actions bar: live detail, in the order given. */
async function gatherSelection(client: AlfredClient, summaries: readonly CallRecord[]): Promise<Gathered> {
  if (summaries.length === 0) throw invalid('Nothing to export: no calls matched.');
  const calls = await Promise.all(summaries.map(async (call) => ({
    ...call,
    ...await client.get<CallDetail>(`/${call.source === 'internal' ? 'internal-calls' : 'calls'}/${seg(call.id)}/detail`),
  } as CallRecord)));
  const range = timeRange(calls);
  const [commentsByCallId, overlapCandidates, metadata] = await Promise.all([
    commentsFor(client, calls),
    range ? client.get<CallOverlapCandidate[]>('/call-overlaps', { query: { ...range, ...NO_FILTERS } }).catch(() => []) : Promise.resolve([]),
    client.post<ExportMetadata>('/calls/export-metadata', { body: calls[0] }).catch(() => null),
  ]);
  return { calls, commentsByCallId, overlapCandidates, metadata, cycle: null, spacers: [], listOrder: 'as-shown' };
}

/** As ExportDialogComponent.loadDbCaptures: each inbound call's whole capture plus where its time went; 404 = not captured. */
async function withDbCaptures(client: AlfredClient, calls: readonly CallRecord[]): Promise<CallRecord[]> {
  return Promise.all(calls.map(async (call) => {
    const stripped: CallRecord = call.dbCapture ? { ...call, dbCapture: undefined } : call;
    if (call.source !== 'internal') return stripped;
    try {
      const [capture, children] = await Promise.all([client.get<CallDbCapture>(`/db-capture/calls/${seg(call.id)}/export`), childrenOf(client, call.id)]);
      const analysis = call.duration_ms ? analysisOf(call, capture, children) : undefined;
      // 'grouped' is the dialog's default layout (its "Group by transaction" preference starts on).
      return { ...stripped, dbCapture: { ...capture, analysis, layout: 'grouped' as const } };
    } catch {
      return stripped;
    }
  }));
}

/** Absolute path → used. Relative or none → under the session's export folder. Neither → ask. */
export function resolveTarget(path: string | undefined, suggestedName: string): { path: string } | { needsPath: true } {
  if (path && isAbsolute(path)) return { path: resolve(path) };
  if (!session.exportFolder) return { needsPath: true };
  return { path: resolve(join(session.exportFolder, path || suggestedName)) };
}

/** Streams the file to a temp name and renames it into place - a big .json is never one string, and a failed write leaves no half file. */
async function writeExport(target: string, built: BuiltExport): Promise<number> {
  const temp = `${target}.tmp-${process.pid}`;
  const out = createWriteStream(temp, { encoding: 'utf8' });
  const done = new Promise<void>((res, rej) => { out.on('finish', () => res()); out.on('error', rej); });
  const write = (chunk: string) => (out.write(chunk) ? Promise.resolve() : new Promise<void>((res) => out.once('drain', () => res())));
  try {
    if (built.kind === 'lines') {
      // Same joining as export-file-io's exportBlob: a newline between lines, none after the last.
      for (let i = 0; i < built.lines.length; i++) await write(i < built.lines.length - 1 ? `${built.lines[i]}\n` : built.lines[i]);
    } else {
      await write(built.kind === 'payload' ? JSON.stringify(built.payload, null, 2) : built.content);
    }
    out.end();
    await done;
    await rename(temp, target);
  } catch (error) {
    out.destroy();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return (await stat(target)).size;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('export_calls', {
    description: 'Export calls as .md, .json or .html - the same file Alfred\'s export dialog writes (never truncated, masked by Alfred\'s Redactions, '
      + '.json re-importable). Source: a whole cycle, a list of call ids, or a live search. Saves to `path` (absolute), or under the session\'s '
      + 'export folder (relative path or none). With neither, nothing is written and the reply asks for a location - ask the user where to save.',
    inputSchema: {
      format: z.enum(['md', 'json', 'html']),
      path: z.string().min(1).optional(),
      overwrite: z.boolean().default(false),
      cycleId: z.string().min(1).optional().describe('Export this whole cycle'),
      calls: z.array(CallRefSchema).min(1).max(500).optional().describe('Or these calls, in this order'),
      search: z.object(SearchSchema).partial().optional().describe('Or every call a live search finds (same filters as search_calls)'),
      includeDb: z.boolean().default(true).describe('Include database statements and analysis for captured inbound calls'),
      rows: z.enum(['all', 'sample']).default('all').describe('.json: every stored DB row, or the first rows per statement'),
      description: z.string().max(4000).optional(),
      environment: z.enum(['Production', 'Staging']).optional(),
      fileName: z.string().max(200).optional().describe('File name when saving into the export folder (default: Alfred\'s generated name)'),
    },
  }, (input) => run(async () => {
    const sources = [input.cycleId, input.calls, input.search].filter((s) => s !== undefined).length;
    if (sources !== 1) throw invalid('Give exactly one of cycleId, calls or search.');
    // Cheap check first: with no path and no folder, ask before fetching anything.
    if (!(input.path && isAbsolute(input.path)) && !session.exportFolder) {
      return ok({ needsPath: true, message: 'No save location. Ask the user for a path, or to set a default folder for this session (session_settings exportFolder).' });
    }

    const gathered = input.cycleId
      ? await gatherCycle(client, input.cycleId)
      : await gatherSelection(client, input.calls
        ? await Promise.all(input.calls.map(async (ref) => (await liveSummary(client, ref.id, ref.direction)).call))
        : (await searchCalls(client, { direction: 'both', sort: 'newest', ...input.search }, SCAN_CAP)).calls);
    const calls = input.includeDb ? await withDbCaptures(client, gathered.calls) : gathered.calls;

    const masking = await maskContext(client, true);
    const form: ExportFormData = {
      supplierName: gathered.metadata?.supplierName ?? '',
      credentialsUsed: gathered.metadata?.credentialsUsed ?? '',
      apiKey: gathered.metadata?.apiKey ?? '',
      url: gathered.metadata?.url ?? calls[0]?.url ?? '',
      environment: input.environment ?? 'Staging',
      description: input.description ?? '',
    };
    const built = buildExportFile(FORMATS[input.format], {
      calls, form, commentsByCallId: gathered.commentsByCallId, overlapCandidates: gathered.overlapCandidates, statusFilter: 'all',
      cycle: gathered.cycle, spacers: gathered.spacers, listOrder: gathered.listOrder, redactions: masking.redactions, rows: input.rows,
      exportedAt: new Date().toISOString(), fileName: '',
    });

    const target = resolveTarget(input.fileName && !input.path ? input.fileName : input.path, built.filename);
    if ('needsPath' in target) return ok({ needsPath: true, suggestedName: built.filename });
    const existing = await stat(target.path).catch(() => null);
    if (existing && !input.overwrite) throw invalid(`${target.path} already exists. Ask the user, then pass overwrite: true or another path.`);
    const parent = await stat(dirname(target.path)).catch(() => null);
    if (!parent?.isDirectory()) throw invalid(`Folder does not exist: ${dirname(target.path)}`);
    const bytes = await writeExport(target.path, built);
    return ok({ path: target.path, bytes, format: input.format, calls: calls.length, redactedValues: built.redactedValueCount });
  }));
}
