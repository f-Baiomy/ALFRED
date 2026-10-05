import { seg, type AlfredClient } from './alfred-client.ts';
import { callTime, toCallRecord, type CallEndpointSource, type CallRecord, type CallSummaryDto, type CycleSpacer, type SessionCycle } from './frontend.ts';
import { invalid, notFound } from './reply.ts';

/** One call in a cycle: the cycle's own entry id (what remove takes) and the copied call (whose id detail, spacers and comments use). */
export interface CycleEntry {
  readonly capturedId: string;
  readonly capturedAt: string;
  readonly call: CallRecord;
}

interface CapturedPage {
  readonly calls: readonly { readonly id: string; readonly capturedAt: string; readonly call: CallSummaryDto }[];
  readonly total: number;
}

const PAGE = 200;

export function segmentOf(source: CallEndpointSource): 'calls' | 'internal-calls' {
  return source === 'internal' ? 'internal-calls' : 'calls';
}

/** One source's captured calls, every page - summaries only, never bodies. */
export async function listSource(client: AlfredClient, cycleId: string, source: CallEndpointSource, sort: 'oldest' | 'oldest-call' = 'oldest-call'): Promise<CycleEntry[]> {
  const out: CycleEntry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await client.get<CapturedPage>(`/session-cycles/${seg(cycleId)}/${segmentOf(source)}`, {
      query: { paged: true, sort, offset, limit: PAGE },
      notFound: `Session cycle ${cycleId} not found.`,
    });
    out.push(...page.calls.map((c) => ({ capturedId: c.id, capturedAt: c.capturedAt, call: toCallRecord(c.call, source) })));
    if (page.calls.length < PAGE || out.length >= page.total) return out;
  }
}

/**
 * A cycle's whole story in run order: outbound and inbound copies merged by their own call time
 * (what the cycle page's "oldest call" order shows), plus its spacers. Shared by get_cycle, the
 * spacer tools and export so all three see the same order.
 */
export async function listCycleCalls(client: AlfredClient, cycleId: string): Promise<{ entries: CycleEntry[]; spacers: CycleSpacer[] }> {
  const [outbound, inbound, spacers] = await Promise.all([
    listSource(client, cycleId, 'external'),
    listSource(client, cycleId, 'internal'),
    client.get<CycleSpacer[]>(`/session-cycles/${seg(cycleId)}/spacers`),
  ]);
  const entries = [...outbound, ...inbound].sort((a, b) => callTime(a.call) - callTime(b.call));
  return { entries, spacers };
}

export async function cycleCallCount(client: AlfredClient, cycleId: string): Promise<number> {
  const [outbound, inbound] = await Promise.all((['external', 'internal'] as const).map((source) =>
    client.get<CapturedPage>(`/session-cycles/${seg(cycleId)}/${segmentOf(source)}`, { query: { paged: true, offset: 0, limit: 1 } })));
  return outbound.total + inbound.total;
}

/** Finds a cycle by exact id, else by case-insensitive name text; several matches are returned for Claude to ask about. */
export async function findCycle(client: AlfredClient, idOrName: string): Promise<SessionCycle | { candidates: { id: string; name: string }[] }> {
  const cycles = await client.get<SessionCycle[]>('/session-cycles');
  const byId = cycles.find((c) => c.id === idOrName);
  if (byId) return byId;
  const needle = idOrName.trim().toLowerCase();
  const exact = cycles.filter((c) => c.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const matches = exact.length > 1 ? exact : cycles.filter((c) => c.name.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw notFound(`No session cycle with id or name "${idOrName}". Use list_cycles to see them.`);
  return { candidates: matches.map((c) => ({ id: c.id, name: c.name })) };
}

/** A cycle that must be one cycle - several name matches are an error naming them. */
export async function requireCycle(client: AlfredClient, idOrName: string): Promise<SessionCycle> {
  const found = await findCycle(client, idOrName);
  if ('candidates' in found) {
    throw invalid(`"${idOrName}" matches ${found.candidates.length} cycles: ${found.candidates.map((c) => `${c.name} (${c.id})`).join('; ')}. Pass the id.`);
  }
  return found;
}

/** Cycles holding a copy of `callId` - only consulted when the live log no longer has it. */
export async function cyclesHolding(client: AlfredClient, callId: string): Promise<{ id: string; name: string }[]> {
  const cycles = await client.get<SessionCycle[]>('/session-cycles');
  const holding = await Promise.all(cycles.map(async (cycle) => {
    const totals = await Promise.all((['calls', 'internal-calls'] as const).map((segment) =>
      client.get<CapturedPage>(`/session-cycles/${seg(cycle.id)}/${segment}`, { query: { paged: true, offset: 0, limit: 1, requestId: callId } })
        .then((page) => page.calls.some((c) => c.call.id === callId) ? 1 : 0)
        .catch(() => 0)));
    return totals.some((t) => t > 0) ? { id: cycle.id, name: cycle.name } : null;
  }));
  return holding.filter((c): c is { id: string; name: string } => c !== null);
}
