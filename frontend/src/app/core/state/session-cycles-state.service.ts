import { Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, Subject, forkJoin, merge, of, timer } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';
import { SessionCycle } from '../models/call.model';
import { NewSessionCycleRequest, SessionCycleUpdateRequest, SessionCyclesApiService } from '../services/session-cycles-api.service';

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 10;

/** Filter-set key standing in for "assignedTo is null" - safe from collision since it's not a valid profile id (a UUID). */
export const UNASSIGNED_FILTER_KEY = '__unassigned__';

export type CycleSortMode = 'newest' | 'oldest' | 'status';

export interface BulkDeleteResult {
  readonly deleted: number;
  readonly skippedRecording: number;
}

/**
 * Facade for the Session Cycles list tab - polls GET /session-cycles (same 5s pattern
 * CallsStateService uses), derives the search/sort/paginated view of the list, and owns a bulk
 * selection over cycle ids with batch pause/record/delete/reassign actions. Each bulk action fans
 * out to the existing single-cycle endpoints via forkJoin (same pattern the copy-to-cycles dialog
 * already uses) rather than needing a dedicated bulk endpoint on the backend.
 */
@Injectable({ providedIn: 'root' })
export class SessionCyclesStateService {
  private readonly api = inject(SessionCyclesApiService);

  private readonly manualRefresh = new Subject<void>();

  private readonly polled$ = merge(timer(0, POLL_INTERVAL_MS), this.manualRefresh).pipe(
    switchMap(() => this.api.list().pipe(catchError(() => of<SessionCycle[]>([]))))
  );

  readonly cycles = toSignal(this.polled$, { initialValue: [] as SessionCycle[] });

  readonly searchQuery = signal('');
  readonly sortMode = signal<CycleSortMode>('newest');
  private readonly visibleCount = signal(PAGE_SIZE);

  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  /** Empty set means "all assigned-to values" (the default) - not "match nothing". */
  readonly assignedToFilter = signal<ReadonlySet<string>>(new Set());

  /** Matches against name or assignedTo, case-insensitively, and against the assigned-to filter (if any is set). */
  readonly matchingCycles = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const filter = this.assignedToFilter();
    return this.cycles().filter((c) => {
      const matchesQuery = !query || c.name.toLowerCase().includes(query) || (c.assignedTo ?? '').toLowerCase().includes(query);
      const matchesFilter = filter.size === 0 || filter.has(c.assignedTo ?? UNASSIGNED_FILTER_KEY);
      return matchesQuery && matchesFilter;
    });
  });

  readonly sortedCycles = computed(() => sortCycles(this.matchingCycles(), this.sortMode()));

  private readonly effectiveVisibleCount = computed(() =>
    Math.max(PAGE_SIZE, Math.min(this.visibleCount(), this.sortedCycles().length))
  );

  readonly visibleCycles = computed(() => this.sortedCycles().slice(0, this.effectiveVisibleCount()));
  readonly remainingCount = computed(() => this.sortedCycles().length - this.visibleCycles().length);
  readonly loadMorePageSize = PAGE_SIZE;

  readonly selectedCycles = computed(() => {
    const ids = this.selectedIds();
    if (ids.size === 0) return [];
    return this.cycles().filter((c) => ids.has(c.id));
  });

  setSearchQuery(query: string): void {
    this.searchQuery.set(query);
    this.visibleCount.set(PAGE_SIZE);
  }

  setSortMode(mode: CycleSortMode): void {
    this.sortMode.set(mode);
    this.visibleCount.set(PAGE_SIZE);
  }

  setAssignedToFilter(keys: ReadonlySet<string>): void {
    this.assignedToFilter.set(keys);
    this.visibleCount.set(PAGE_SIZE);
  }

  loadMore(): void {
    this.visibleCount.set(this.visibleCount() + PAGE_SIZE);
  }

  isSelected(cycle: SessionCycle): boolean {
    return this.selectedIds().has(cycle.id);
  }

  toggleSelected(cycle: SessionCycle): void {
    const next = new Set(this.selectedIds());
    if (next.has(cycle.id)) {
      next.delete(cycle.id);
    } else {
      next.add(cycle.id);
    }
    this.selectedIds.set(next);
  }

  /** Selects every cycle currently matching the search, not just the paginated slice. */
  selectAll(): void {
    this.selectedIds.set(new Set(this.matchingCycles().map((c) => c.id)));
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  create(request: NewSessionCycleRequest): Observable<SessionCycle> {
    return this.api.create(request).pipe(tap(() => this.refreshNow()));
  }

  update(id: string, request: SessionCycleUpdateRequest): Observable<SessionCycle> {
    return this.api.update(id, request).pipe(tap(() => this.refreshNow()));
  }

  startRecording(id: string): Observable<SessionCycle> {
    return this.api.startRecording(id).pipe(tap(() => this.refreshNow()));
  }

  pauseRecording(id: string): Observable<SessionCycle> {
    return this.api.pauseRecording(id).pipe(tap(() => this.refreshNow()));
  }

  delete(id: string): Observable<void> {
    return this.api.delete(id).pipe(tap(() => this.refreshNow()));
  }

  /** Idempotent per cycle (same as the single-cycle action), so it's safe to call on a mixed-status selection. */
  bulkStartRecording(ids: readonly string[]): Observable<SessionCycle[]> {
    if (ids.length === 0) return of([]);
    return forkJoin(ids.map((id) => this.api.startRecording(id))).pipe(tap(() => this.refreshNow()));
  }

  bulkPauseRecording(ids: readonly string[]): Observable<SessionCycle[]> {
    if (ids.length === 0) return of([]);
    return forkJoin(ids.map((id) => this.api.pauseRecording(id))).pipe(tap(() => this.refreshNow()));
  }

  /** One assignedTo value overwrites every selected cycle (blank clears it). */
  bulkReassign(ids: readonly string[], assignedTo: string | null): Observable<SessionCycle[]> {
    if (ids.length === 0) return of([]);
    return forkJoin(ids.map((id) => this.api.update(id, { assignedTo }))).pipe(tap(() => this.refreshNow()));
  }

  /** Cycles still RECORDING are skipped (never sent to the backend, matching the single-cycle 409 guard) rather than failing the whole batch. */
  bulkDelete(ids: readonly string[]): Observable<BulkDeleteResult> {
    const byId = new Map(this.cycles().map((c) => [c.id, c] as const));
    const deletable = ids.filter((id) => byId.get(id)?.status !== 'RECORDING');
    const skippedRecording = ids.length - deletable.length;

    if (deletable.length === 0) {
      return of({ deleted: 0, skippedRecording });
    }
    return forkJoin(deletable.map((id) => this.api.delete(id))).pipe(
      tap(() => this.refreshNow()),
      map(() => ({ deleted: deletable.length, skippedRecording }))
    );
  }

  refreshNow(): void {
    this.manualRefresh.next();
  }
}

function sortCycles(cycles: readonly SessionCycle[], mode: CycleSortMode): SessionCycle[] {
  const arr = [...cycles];
  switch (mode) {
    case 'oldest':
      return arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'status':
      return arr.sort((a, b) => {
        const rank = (c: SessionCycle) => (c.status === 'RECORDING' ? 0 : 1);
        return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
      });
    default:
      return arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
