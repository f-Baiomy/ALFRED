import type { AlfredClient } from './alfred-client.ts';
import type { AttentionMark, CallStatementFailures, TriageEntry } from './frontend.ts';

/**
 * Reads of triage's saved marks (backend-triage) and db-capture's failed-statement index. Both are written as calls
 * arrive, so "what needs attention" costs one indexed request per 100 calls - no body is read, no statement list
 * loaded.
 */

/**
 * The ids one GET may name. They travel in the URL, and the gateway refuses a request line over 8 KB (about 200 ids)
 * with 414 - 500 ids failed every triage of a big cycle.
 */
export const MAX_IDS = 100;

export const GROUP_TITLES: Record<number, string> = {
  1: 'Failed, with failing supplier calls',
  2: 'Failed, with failed database statements',
  3: 'Other failed calls',
  4: 'Succeeded, but something under it failed (hidden failures)',
  5: 'Succeeded, with an error inside its body or an empty result',
  6: 'Everything else - still read the ones related to the problem: a call that succeeded can hold the cause',
};

export function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Marks of these calls, ranked for `minStatus`. A call with no mark (never reported, or past the row cap) is absent. */
export async function triageOf(client: AlfredClient, callIds: readonly string[], minStatus?: number): Promise<Record<string, TriageEntry>> {
  const ids = [...new Set(callIds)];
  const parts = await Promise.all(chunks(ids, MAX_IDS).map((chunk) =>
    client.get<Record<string, TriageEntry>>('/triage/calls', { query: { callIds: chunk.join(','), minStatus } })));
  return Object.assign({}, ...parts);
}

/** The same, or null when this Alfred has no triage yet (an older backend) - for views that work without it. */
export async function triageOrNull(client: AlfredClient, callIds: readonly string[], minStatus?: number): Promise<Record<string, TriageEntry> | null> {
  if (!callIds.length) return {};
  return triageOf(client, callIds, minStatus).catch(() => null);
}

export async function statementFailuresOf(client: AlfredClient, callIds: readonly string[]): Promise<Record<string, CallStatementFailures>> {
  const ids = [...new Set(callIds)];
  if (!ids.length) return {};
  const parts = await Promise.all(chunks(ids, MAX_IDS).map((chunk) =>
    client.get<Record<string, CallStatementFailures>>('/db-capture/failures', { query: { callIds: chunk.join(',') } })));
  return Object.assign({}, ...parts);
}

export interface LiveTriageQuery {
  readonly project?: string;
  readonly since?: string;
  readonly to?: string;
  readonly maxPriority: number;
  readonly minStatus?: number;
  readonly limit: number;
}

export function triageLive(client: AlfredClient, q: LiveTriageQuery): Promise<TriageEntry[]> {
  return client.get<TriageEntry[]>('/triage/live', { query: { ...q } });
}

export function triageCounts(client: AlfredClient, project: string | undefined, since?: string, to?: string): Promise<Record<string, number>> {
  return client.get<Record<string, number>>('/triage/counts', { query: { project, since, to } });
}

/** "500", "ERROR connection reset", or the state of a call still running. */
export function outcomeOf(mark: AttentionMark): string {
  if (mark.error) return `ERROR ${mark.error}`;
  if (mark.status != null) return String(mark.status);
  return mark.state === 'IN_PROGRESS' ? 'still running' : mark.state;
}

/**
 * get_cycle's first line: the numbers of the calls in groups 1-5, at most `perGroup` each - the evidence is
 * triage's. Empty when nothing needs attention.
 */
export function attentionLine(entries: readonly { n: number; entry: TriageEntry }[], perGroup = 8): string {
  const parts: string[] = [];
  for (let p = 1; p <= 5; p++) {
    const inGroup = entries.filter((e) => e.entry.priority === p);
    if (!inGroup.length) continue;
    const shown = inGroup.slice(0, perGroup).map((e) => `#${e.n} (${shortWhy(e.entry)})`);
    parts.push(`${p}: ${shown.join(', ')}${inGroup.length > perGroup ? `, +${inGroup.length - perGroup} more` : ''}`);
  }
  return parts.length ? `Needs attention - ${parts.join(' · ')} - triage gives the evidence` : '';
}

function shortWhy(e: TriageEntry): string {
  const why: string[] = [];
  if (e.needsAttention) why.push(outcomeOf(e));
  if (e.failingSupplierCalls.length) why.push(`${e.failingSupplierCalls.length} supplier call${e.failingSupplierCalls.length > 1 ? 's' : ''} failed`);
  if (e.failedStatements) why.push(`${e.failedStatements} failed statement${e.failedStatements > 1 ? 's' : ''}`);
  if (e.softFailure) why.push(`✖ ${e.softFailure.code ?? 'error'} in body`);
  if (e.emptyKeys.length) why.push('empty result');
  return why.join(', ') || outcomeOf(e);
}
