import { Injectable, Signal, inject, signal } from '@angular/core';
import { EMPTY, Observable, forkJoin, from, map, reduce } from 'rxjs';
import { expand, mergeMap, toArray } from 'rxjs/operators';
import { CallEndpointSource, CallRecord } from '../models/call.model';
import { CallsQuery } from '../state/call-list-view';
import { SessionCyclesApiService } from './session-cycles-api.service';

const PAGE_SIZE = 200;
/** Same cap as CycleExportService.REQUEST_CONCURRENCY - see its comment for why this is throttled rather than fanned out. */
const REQUEST_CONCURRENCY = 6;

function pageQuery(offset: number): CallsQuery {
  return { search: '', supplier: '', sort: 'oldest', offset, limit: PAGE_SIZE, sessionId: '', operationId: '', requestId: '' };
}

/**
 * D2's own "give me every call in this cycle, oldest first, with full bodies" - cycle-chain-detect
 * needs hydrated request/response bodies for the whole cycle, same as CycleExportService does for
 * an export, but that service's paging/hydration is private to it and this is a different feature
 * (owned by F-SCENARIO, not the export path), so it gets its own small copy of the same shape
 * rather than reaching into CycleExportService's internals.
 */
@Injectable({ providedIn: 'root' })
export class ScenarioCycleSourceService {
  private readonly api = inject(SessionCyclesApiService);

  private readonly loadingState = signal(false);
  readonly loading: Signal<boolean> = this.loadingState.asReadonly();

  /** Both directions, oldest first, with request/response bodies - what chain detection needs. */
  loadHydrated(cycleId: string): Observable<CallRecord[]> {
    this.loadingState.set(true);
    return forkJoin([this.collectSource(cycleId, 'external'), this.collectSource(cycleId, 'internal')]).pipe(
      map(([external, internal]) => [...external, ...internal].sort((a, b) => a.timestamp.localeCompare(b.timestamp))),
      mergeMap((calls) => this.hydrateAll(cycleId, calls)),
      map((calls) => {
        this.loadingState.set(false);
        return calls;
      })
    );
  }

  private collectSource(cycleId: string, source: CallEndpointSource): Observable<CallRecord[]> {
    const fetchFrom = (offset: number) => this.api.listCalls(cycleId, pageQuery(offset), source).pipe(map((page) => ({ page, offset })));
    return fetchFrom(0).pipe(
      expand(({ page, offset }) => {
        const next = offset + PAGE_SIZE;
        return next < page.total && page.calls.length > 0 ? fetchFrom(next) : EMPTY;
      }),
      reduce((all, { page }) => [...all, ...page.calls.map((c) => c.call)], [] as CallRecord[])
    );
  }

  private hydrateAll(cycleId: string, calls: readonly CallRecord[]): Observable<CallRecord[]> {
    return from(calls.map((call, index) => ({ call, index }))).pipe(
      mergeMap(
        ({ call, index }) => this.api.getDetail(cycleId, call.id, call.source ?? 'external').pipe(map((detail) => ({ index, call: { ...call, ...detail } as CallRecord }))),
        REQUEST_CONCURRENCY
      ),
      toArray(),
      map((results) => results.sort((a, b) => a.index - b.index).map((r) => r.call))
    );
  }
}
