import { z } from 'zod';
import type { AlfredClient } from './alfred-client.ts';
import { requireCycle } from './cycle-calls.ts';
import { invalid } from './reply.ts';

/**
 * Which calls a cross-call question looks at (specs/010-mcp-log-investigation): the live calls (default), one cycle,
 * several cycles (optionally with the live calls), or everything. A call held in several places counts once and says
 * where it is held.
 */
export const ScopeSchema = z.object({
  live: z.literal(true).optional().describe('The live inbound calls (the default)'),
  cycle: z.string().optional().describe('One session cycle, by id or name'),
  cycles: z.array(z.string()).max(50).optional().describe('Several session cycles, by id or name'),
  includeLive: z.boolean().optional().describe('With cycles: the live calls too'),
  all: z.literal(true).optional().describe('The live calls and every session cycle'),
}).optional().describe('Which calls to look at: {live:true} (default), {cycle:"name"}, {cycles:[...], includeLive}, or {all:true}');

export type Scope = z.infer<typeof ScopeSchema>;

export interface ScopeBody {
  readonly kind: 'live' | 'cycles' | 'all';
  readonly cycleIds?: string[];
  readonly includeLive?: boolean;
}

/** The backend's scope body; cycle names become ids (an ambiguous name is an error naming the candidates). */
export async function scopeBody(client: AlfredClient, scope: Scope): Promise<ScopeBody> {
  if (!scope) return { kind: 'live' };
  const named = [...(scope.cycle ? [scope.cycle] : []), ...(scope.cycles ?? [])];
  const kinds = [scope.all ? 1 : 0, named.length ? 1 : 0].reduce((a, b) => a + b, 0);
  if (kinds > 1) throw invalid('Pick one scope: all, or cycle/cycles (with includeLive), or live.');
  if (scope.all) return { kind: 'all' };
  if (named.length) {
    const ids = await Promise.all(named.map(async (n) => (await requireCycle(client, n)).id));
    return { kind: 'cycles', cycleIds: [...new Set(ids)], includeLive: !!scope.includeLive };
  }
  return { kind: 'live' };
}

/** "live + cycle «impo»" - where a call is held, for a list line. */
export function heldInText(heldIn: readonly string[] | undefined): string {
  if (!heldIn?.length) return '';
  return heldIn.map((h) => (h.startsWith('cycle:') ? `cycle «${h.slice(6)}»` : h)).join(' + ');
}
