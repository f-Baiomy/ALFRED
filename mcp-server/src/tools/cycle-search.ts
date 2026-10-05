import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { partsFor, select, toRow, withParts } from '../calls.ts';
import { listSource, requireCycle } from '../cycle-calls.ts';
import { callTime, softFailureOf, type CallEndpointSource } from '../frontend.ts';
import { maskCall, maskContext, maskMeta } from '../masking.ts';
import { fitItems, ok, run } from '../reply.ts';
import { passesFilters, wantsMarks } from './calls.ts';
import { triageOrNull } from '../triage.ts';
import { FieldsSchema, MaskSchema, PathsSchema } from './cycles.ts';

/**
 * search_calls for one cycle: the live log drops inbound calls after ~1,500, a cycle keeps them. Text,
 * supplier and project are narrowed by Alfred's cycle list endpoints; status, failure (an error
 * inside a 200 included), slowness and time by the same passesFilters search_calls uses. A cycle is
 * a bounded recording, so every page is read - no scan cap.
 */
export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('search_cycle', {
    description: 'Search inside one session cycle (its own copies - still there after the live log dropped the calls): text in method, URL, '
      + 'status, error, headers or bodies, direction, project, supplier, status/class, failed (errors inside 200s included), needsAttention, '
      + 'dbFailed (a failed database statement under a 200 too), slow, time range. '
      + 'Rows carry the call\'s number in the cycle (#n, as get_cycle shows it).',
    inputSchema: {
      cycle: z.string().min(1).describe('Cycle id, or text from its name'),
      text: z.string().optional(),
      direction: z.enum(['inbound', 'outbound', 'both']).default('both'),
      project: z.string().optional(),
      supplier: z.string().optional(),
      status: z.union([z.number().int(), z.string().regex(/^([1-5]xx|\d{3})$/i)]).optional(),
      failed: z.boolean().optional(),
      needsAttention: z.boolean().optional().describe('Status >= minStatus (default 300), an error, still running, or an error inside a successful body'),
      dbFailed: z.boolean().optional().describe('Inbound calls with a failed database statement, whatever their own status'),
      minStatus: z.number().int().min(300).max(600).optional(),
      slowMs: z.number().min(0).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      includeOptions: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      fields: FieldsSchema,
      paths: PathsSchema,
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycle);
    const ctx = await maskContext(client, input.mask);
    // Numbers as get_cycle gives them: the cycle's visible calls in run order, before any search.
    const [allOut, allIn] = await Promise.all([listSource(client, cycle.id, 'external'), listSource(client, cycle.id, 'internal')]);
    const visible = [...allOut, ...allIn].filter((e) => input.includeOptions || e.call.method !== 'OPTIONS')
      .sort((a, b) => callTime(a.call) - callTime(b.call));
    const numberOf = new Map(visible.map((e, i) => [e.call.id, i + 1]));

    const sources: CallEndpointSource[] = input.direction === 'inbound' ? ['internal'] : input.direction === 'outbound' ? ['external'] : ['internal', 'external'];
    const narrowed = !!(input.text || input.supplier || input.project);
    const lists = await Promise.all(sources.map((source) => narrowed
      ? listSource(client, cycle.id, source, 'oldest-call', {
        search: input.text, supplier: source === 'external' ? input.supplier : undefined, serviceNames: source === 'internal' ? input.project : undefined,
      })
      : Promise.resolve((source === 'internal' ? allIn : allOut))));
    const fromMs = input.from ? Date.parse(input.from) : undefined;
    const toMs = input.to ? Date.parse(input.to) : undefined;
    const candidates = lists.flat().map((e) => e.call)
      .filter((c) => input.includeOptions || c.method !== 'OPTIONS')
      .filter((c) => (fromMs === undefined || callTime(c) >= fromMs) && (toMs === undefined || callTime(c) <= toMs))
      .sort((a, b) => callTime(a) - callTime(b));
    // The saved marks, one request per 500 calls, answer failed / needsAttention / dbFailed without reading bodies.
    const marks = wantsMarks(input) ? await triageOrNull(client, candidates.map((c) => c.id), input.minStatus) : null;
    const matches = [];
    for (const call of candidates) {
      const pass = await passesFilters(call, input, async () => {
        const bodied = await withParts(client, { id: call.id, source: call.source ?? 'external', cycleId: cycle.id }, call, ['response-body']).catch(() => call);
        return !!softFailureOf(bodied);
      }, marks?.[call.id]);
      if (pass) matches.push(call);
    }

    const page = matches.slice(input.offset, input.offset + input.limit);
    const selective = !!(input.fields?.length || input.paths?.length);
    const parts = partsFor(input.fields, input.paths);
    const rows = await Promise.all(page.map(async (summary) => {
      const call = maskCall(ctx, parts.length ? await withParts(client, { id: summary.id, source: summary.source ?? 'external', cycleId: cycle.id }, summary, parts) : summary);
      const n = numberOf.get(call.id) ?? null;
      if (!selective) return { n, ...toRow(call) };
      const sel = select(call, input.fields, input.paths, {}, 0, 2000);
      return { n, id: call.id, ...sel.values, ...(sel.missing.length ? { missing: sel.missing } : {}) };
    }));
    const fitted = fitItems(rows, 400);
    const end = input.offset + fitted.items.length;
    return ok({
      cycleId: cycle.id, total: matches.length, offset: input.offset, nextOffset: end < matches.length ? end : null,
      calls: fitted.items, ...maskMeta(ctx),
    });
  }));
}
