import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { listCycleCalls, requireCycle } from '../cycle-calls.ts';
import type { CycleSpacer } from '../frontend.ts';
import { invalid, ok, run } from '../reply.ts';

const AfterCall = z.string().min(1).describe('Id of the call the spacer goes directly below, or "top" for above every call.');

/**
 * A spacer anchors to the call ABOVE it: that call's id plus its own timestamp, both null for the
 * top (CLAUDE.md's spacer rule) - so every view and export places it through layoutSpacers alike.
 */
async function anchorFor(client: AlfredClient, cycleId: string, afterCallId: string): Promise<{ afterCallId: string | null; anchorTimestamp: string | null }> {
  if (afterCallId === 'top') return { afterCallId: null, anchorTimestamp: null };
  const { entries } = await listCycleCalls(client, cycleId);
  const entry = entries.find((e) => e.call.id === afterCallId);
  if (!entry) throw invalid(`Call ${afterCallId} is not in this cycle - a spacer can only sit below one of its calls (or "top").`);
  return { afterCallId: entry.call.id, anchorTimestamp: entry.call.timestamp };
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('add_spacer', {
    description: 'Add a labelled spacer to a session cycle, directly below a call (or at the top). Spacers split a cycle\'s story into steps; calls themselves always stay in recorded-time order.',
    inputSchema: { cycleId: z.string().min(1), label: z.string().min(1).max(200), afterCallId: AfterCall },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    const anchor = await anchorFor(client, cycle.id, input.afterCallId);
    return ok(await client.post<CycleSpacer>(`/session-cycles/${seg(cycle.id)}/spacers`, { body: { label: input.label, ...anchor } }));
  }));

  server.registerTool('rename_spacer', {
    description: 'Change a spacer\'s label.',
    inputSchema: { cycleId: z.string().min(1), spacerId: z.string().min(1), label: z.string().min(1).max(200) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    return ok(await client.patch<CycleSpacer>(`/session-cycles/${seg(cycle.id)}/spacers/${seg(input.spacerId)}`, {
      body: { label: input.label }, notFound: `Spacer ${input.spacerId} not found in cycle ${cycle.id}.`,
    }));
  }));

  server.registerTool('move_spacer', {
    description: 'Move a spacer to directly below another call of the same cycle (or to the top) - the way to rearrange a cycle\'s story.',
    inputSchema: { cycleId: z.string().min(1), spacerId: z.string().min(1), afterCallId: AfterCall },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    const anchor = await anchorFor(client, cycle.id, input.afterCallId);
    return ok(await client.patch<CycleSpacer>(`/session-cycles/${seg(cycle.id)}/spacers/${seg(input.spacerId)}/move`, {
      body: anchor, notFound: `Spacer ${input.spacerId} not found in cycle ${cycle.id}.`,
    }));
  }));

  server.registerTool('delete_spacer', {
    description: 'Delete one spacer from a session cycle (calls are untouched).',
    inputSchema: { cycleId: z.string().min(1), spacerId: z.string().min(1) },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    await client.del(`/session-cycles/${seg(cycle.id)}/spacers/${seg(input.spacerId)}`, { notFound: `Spacer ${input.spacerId} not found in cycle ${cycle.id}.` });
    return ok({ deleted: true, spacerId: input.spacerId });
  }));
}
