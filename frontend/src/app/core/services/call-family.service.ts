import { Injectable, inject } from '@angular/core';
import { Observable, catchError, from, map, mergeMap, of, switchMap, toArray } from 'rxjs';
import { CallEndpointSource, CallOverlapCandidate, CallRecord } from '../models/call.model';
import { CallOverlapQuery } from '../state/call-list-view';
import { CallTreeNode, buildCallTree } from '../../shared/utils/call-tree';
import { CallsApiService } from './calls-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

/** The most calls one family loads - a long-running root on a busy Alfred must not fetch the whole capture. */
export const FAMILY_MAX_CALLS = 200;
const PARALLEL = 6;

/** One call with everything above and below it, as Live Calls nests them: the tree from its top call. */
export interface CallFamily {
  /** The tree that holds the call, from its top call down, every level. */
  readonly root: CallTreeNode;
  /** Every call of that tree. */
  readonly calls: readonly CallRecord[];
  /** More calls fell in the top call's window than were loaded (FAMILY_MAX_CALLS). */
  readonly truncated: boolean;
}

const NO_FILTER = { search: '', supplier: '', sessionId: '', operationId: '', requestId: '' };

function windowOf(c: { timestamp: string; duration_ms?: number | null }): { start: number; end: number } {
  const start = new Date(c.timestamp).getTime();
  return { start, end: start + (c.duration_ms ?? 0) };
}

/** The node holding `id` in a forest, and the root it hangs under. */
export function rootHolding(forest: readonly CallTreeNode[], id: string): CallTreeNode | null {
  const holds = (n: CallTreeNode): boolean => n.call.id === id || n.children.some(holds);
  return forest.find(holds) ?? null;
}

/** How many calls sit under a node, and how many levels deep they go. */
export function familySize(node: CallTreeNode): { calls: number; levels: number } {
  let calls = 0;
  let levels = 0;
  const walk = (n: CallTreeNode, depth: number): void => {
    for (const c of n.children) {
      calls++;
      levels = Math.max(levels, depth + 1);
      walk(c, depth + 1);
    }
  };
  walk(node, 0);
  return { calls, levels };
}

/**
 * Loads a call's family for the call popup (specs/025): the calls whose windows contain it (to find its top call -
 * a named parent first, then any call that contains it), then every call inside that top call's window, live or in its
 * cycle, and nests them with Live Calls' own buildCallTree - so the popup shows exactly the tree Live Calls would,
 * every level deep. Fetch-on-demand, once per open; nothing polls.
 */
@Injectable({ providedIn: 'root' })
export class CallFamilyService {
  private readonly calls = inject(CallsApiService);
  private readonly cycles = inject(SessionCyclesApiService);

  load(call: CallRecord, cycleId: string | null): Observable<CallFamily> {
    return this.ancestors(call, cycleId).pipe(
      switchMap((above) => {
        const forest = buildCallTree([...above, call]);
        const top = rootHolding(forest, call.id)?.call ?? call;
        return this.inside(top, cycleId).pipe(map(({ within, truncated }) => {
          const all = uniq([top, call, ...above.filter((c) => contains(top, c)), ...within]);
          const root = rootHolding(buildCallTree(all), call.id) ?? { call, children: [], depth: 0 };
          return { root, calls: flatten(root), truncated };
        }));
      }),
      catchError(() => of({ root: { call, children: [], depth: 0 }, calls: [call], truncated: false })),
    );
  }

  /** The calls that could hold this one: its named parent and every inbound call whose window contains it. */
  private ancestors(call: CallRecord, cycleId: string | null): Observable<CallRecord[]> {
    const w = windowOf(call);
    return this.overlaps(cycleId, w.start, w.end).pipe(
      map((cands) => cands.filter((c) => c.id !== call.id && c.source === 'internal' && candidateWindow(c).start <= w.start
        && candidateWindow(c).end >= w.end)),
      map((cands) => (call.parentCallId && !cands.some((c) => c.id === call.parentCallId)
        ? [...cands, { id: call.parentCallId, source: 'internal' as CallEndpointSource }] : cands)),
      switchMap((cands) => this.fetch(cands.slice(0, FAMILY_MAX_CALLS), cycleId)),
    );
  }

  /** Every call inside the top call's window (both directions), at most FAMILY_MAX_CALLS. */
  private inside(top: CallRecord, cycleId: string | null): Observable<{ within: CallRecord[]; truncated: boolean }> {
    const w = windowOf(top);
    return this.overlaps(cycleId, w.start, w.end).pipe(
      map((cands) => cands.filter((c) => c.id !== top.id && candidateWindow(c).start >= w.start && candidateWindow(c).end <= w.end)),
      switchMap((cands) => this.fetch(cands.slice(0, FAMILY_MAX_CALLS), cycleId)
        .pipe(map((within) => ({ within, truncated: cands.length > FAMILY_MAX_CALLS })))),
    );
  }

  private overlaps(cycleId: string | null, start: number, end: number): Observable<CallOverlapCandidate[]> {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return of([]);
    const query: CallOverlapQuery = { from: new Date(start).toISOString(), to: new Date(Math.max(end, start + 1)).toISOString(), ...NO_FILTER };
    const req = cycleId ? this.cycles.getCallOverlaps(cycleId, query) : this.calls.getCallOverlaps(query);
    return req.pipe(catchError(() => of([] as CallOverlapCandidate[])));
  }

  /** Each candidate's call, a few at a time; one that cannot be read is left out. */
  private fetch(cands: readonly { id: string; source: CallEndpointSource }[], cycleId: string | null): Observable<CallRecord[]> {
    if (!cands.length) return of([]);
    return from(cands).pipe(
      mergeMap((c) => this.one(c.id, c.source, cycleId).pipe(catchError(() => of(null))), PARALLEL),
      toArray(),
      map((list) => list.filter((c): c is CallRecord => !!c)),
    );
  }

  private one(id: string, source: CallEndpointSource, cycleId: string | null): Observable<CallRecord | null> {
    if (!cycleId) return this.calls.getSummary(id, source);
    return this.cycles.listCalls(cycleId, { search: '', supplier: '', sort: 'newest', offset: 0, limit: 1, sessionId: '', operationId: '',
      requestId: id }, source).pipe(map((page) => page.calls.map((c) => c.call).find((c) => c.id === id) ?? null));
  }
}

function candidateWindow(c: CallOverlapCandidate): { start: number; end: number } {
  const start = new Date(c.timestamp).getTime();
  return { start, end: start + (c.durationMs ?? 0) };
}

function contains(outer: CallRecord, inner: CallRecord): boolean {
  const o = windowOf(outer);
  const i = windowOf(inner);
  return i.start >= o.start && i.end <= o.end;
}

function uniq(calls: readonly CallRecord[]): CallRecord[] {
  const seen = new Map<string, CallRecord>();
  for (const c of calls) if (!seen.has(c.id)) seen.set(c.id, c);
  return [...seen.values()];
}

function flatten(node: CallTreeNode): CallRecord[] {
  return [node.call, ...node.children.flatMap(flatten)];
}
