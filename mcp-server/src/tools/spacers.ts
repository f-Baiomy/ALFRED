import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { listCycleCalls, requireCycle } from '../cycle-calls.ts';
import { callTime, type CallRecord, type CycleSpacer } from '../frontend.ts';
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

  server.registerTool('suggest_spacers', {
    description: 'Propose spacers for a cycle: calls grouped where the user paused (a gap with no calls) or moved to another area of the app '
      + '(the first path segments of inbound URLs). Writes nothing - add the ones that fit with add_spacer (afterCallId is given for each), '
      + 'renamed as the user likes.',
    inputSchema: {
      cycleId: z.string().min(1),
      gapMs: z.number().int().min(200).max(600_000).default(3000).describe('A pause at least this long starts a new step'),
      includeOptions: z.boolean().default(false),
    },
  }, (input) => run(async () => {
    const cycle = await requireCycle(client, input.cycleId);
    const { entries, spacers } = await listCycleCalls(client, cycle.id);
    const calls = entries.map((e) => e.call).filter((c) => input.includeOptions || c.method !== 'OPTIONS');
    return ok({ cycleId: cycle.id, existingSpacers: spacers.length, suggestions: suggestSpacers(calls, input.gapMs) });
  }));
}

/**
 * An inbound URL's area: the first path segment after the app's own root (`/odeysysadmin/Booking2/flight-search/search` →
 * `Booking2`). Coarse on purpose: one segment deeper turned every page of a login flow into its own step.
 */
export function areaOf(call: CallRecord): string | null {
  if (call.source !== 'internal') return null;
  let path: string;
  try {
    path = new URL(call.original_url || call.url).pathname;
  } catch {
    return null;
  }
  const parts = path.split('/').filter(Boolean);
  // The first segment is the app's own root (odeysysadmin) on every call; the next says where in it.
  return parts.length > 1 ? parts[1] : parts[0] ?? null;
}

/** The page a call belongs to, for the label: the area and the segment after it (`Booking2/flight-search`). */
function pageOf(call: CallRecord): string | null {
  try {
    const parts = new URL(call.original_url || call.url).pathname.split('/').filter(Boolean);
    return parts.length > 2 ? parts.slice(1, 3).join('/') : null;
  } catch {
    return null;
  }
}

export interface SpacerSuggestion {
  readonly label: string;
  readonly afterCallId: string;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

/** Calls in run order → steps. Outbound calls never start a step: they belong to the inbound call that made them. */
export function suggestSpacers(calls: readonly CallRecord[], gapMs: number): SpacerSuggestion[] {
  const groups: { start: number; end: number; paths: string[]; reason: string }[] = [];
  let lastEnd = -Infinity;
  let lastArea: string | null = null;
  calls.forEach((call, i) => {
    const start = callTime(call);
    const area = areaOf(call);
    const paused = start - lastEnd >= gapMs;
    const moved = area !== null && lastArea !== null && area !== lastArea;
    if (groups.length === 0 || (call.source === 'internal' && (paused || moved))) {
      groups.push({ start: i, end: i, paths: [], reason: groups.length === 0 ? 'first call' : paused ? `${Math.round((start - lastEnd) / 100) / 10} s pause` : `moved to ${area}` });
    }
    const group = groups[groups.length - 1];
    group.end = i;
    if (area) {
      group.paths.push(pageOf(call) ?? area);
      lastArea = area;
    }
    lastEnd = Math.max(lastEnd, start + (call.duration_ms ?? 0));
  });
  const steps = groups.map((g) => {
    const counts = new Map<string, number>();
    for (const a of g.paths) counts.set(a, (counts.get(a) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return {
      label: top ? top.replace(/[-_/]+/g, ' ').trim() : 'supplier calls',
      afterCallId: g.start === 0 ? 'top' : calls[g.start - 1].id,
      from: g.start + 1,
      to: g.end + 1,
      reason: g.reason,
    };
  });
  // Pauses inside one page (typing an airport, then another) are not new steps: neighbours with one label merge.
  return steps.reduce<SpacerSuggestion[]>((merged, step) => {
    const last = merged[merged.length - 1];
    if (last && last.label === step.label) merged[merged.length - 1] = { ...last, to: step.to };
    else merged.push(step);
    return merged;
  }, []);
}
