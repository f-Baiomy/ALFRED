import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { CallRecord, SortMode } from '../models/call.model';
import { callKey, sortCalls, supplierOf } from '../../shared/utils/call-utils';

const DEFAULT_PAGE_SIZE = 10;

export interface SupplierOption {
  readonly name: string;
  readonly count: number;
}

export interface CallStats {
  readonly total: number;
  readonly ok: number;
  readonly client: number;
  readonly failed: number;
}

export interface SupplierGroup {
  readonly supplier: string;
  readonly calls: readonly CallRecord[];
}

export interface CallsQuery {
  readonly search: string;
  readonly supplier: string;
  readonly sort: SortMode;
  readonly offset: number;
  readonly limit: number;
}

export interface CallsPageResult {
  readonly calls: readonly CallRecord[];
  readonly total: number;
}

/**
 * Every filtered/sorted/paginated/grouped/stats view derived from a backend-paged source -
 * search/sort/supplier-filter/group-by-supplier/collapse-expand/limit/pagination. Shared by
 * CallsStateService (the dashboard) and SessionCycleDetailStateService (one open cycle) so any
 * feature added here shows up in both places automatically instead of drifting between two
 * hand-copied implementations.
 *
 * Unlike the client-side-slicing version this replaced, search/sort/supplier-filter are backend
 * query params and "load more" is a real HTTP request for the next page - `matchingCalls` is
 * therefore "everything loaded so far" (plus any not-yet-confirmed live push), not "everything
 * that would ever match" - `stats`/`supplierOptions`/`groupedCalls`/"select all" all necessarily
 * scope to that loaded window too, widening as more pages load.
 */
export interface CallListView {
  readonly searchQuery: Signal<string>;
  readonly limit: Signal<number>;
  readonly sortMode: Signal<SortMode>;
  readonly supplierFilter: Signal<string>;
  readonly groupBySupplier: Signal<boolean>;
  readonly expanded: Signal<boolean>;
  readonly collapseAllVersion: Signal<number>;
  readonly loading: Signal<boolean>;
  readonly supplierOptions: Signal<SupplierOption[]>;
  readonly matchingCalls: Signal<CallRecord[]>;
  readonly stats: Signal<CallStats>;
  readonly mainListCalls: Signal<CallRecord[]>;
  readonly visibleCalls: Signal<CallRecord[]>;
  readonly remainingCount: Signal<number>;
  readonly groupedCalls: Signal<SupplierGroup[]>;
  readonly loadMorePageSize: number;
  setSearchQuery(query: string): void;
  setLimit(limit: number): void;
  setSortMode(mode: SortMode): void;
  setSupplierFilter(supplier: string): void;
  toggleGroupBySupplier(): void;
  toggleExpanded(): void;
  loadMore(): void;
  /** Re-fetches the currently-loaded window (offset 0 through however many calls are loaded) and replaces it wholesale - used both for the manual "Refresh" button and to reconcile a WebSocket push, since there's no polling to fall back on. */
  refresh(): void;
  /** Clears everything loaded and refetches page one - for when the underlying source itself changes (e.g. navigating to a different session cycle), not just the query. */
  resetSource(): void;
}

export interface CallListViewOptions {
  /** Defaults to 'newest' (the dashboard's convention) - a session-cycle detail view opts into 'oldest-call' instead, since a repro's calls read better sorted by when they actually happened (call.timestamp), not capture/received order. */
  readonly defaultSortMode?: SortMode;
  /** Only a session-cycle detail view ever passes this (see CALL_REORDER_STATE) - the dashboard
   * never reaches sortMode 'custom' at all, so this being absent there is harmless. 'custom' is a
   * purely client-side rearrangement of whatever's currently loaded - it never triggers a
   * backend fetch with sort=custom, which the backend wouldn't understand anyway. */
  readonly customOrder?: Signal<readonly string[]>;
  readonly pageSize?: number;
  /** Fetches one page from the backend for the given query - CallsApiService.getCalls or SessionCyclesApiService.listCalls (mapped down to CallRecord[]). */
  readonly fetchPage: (query: CallsQuery) => Observable<CallsPageResult>;
  /** Calls not yet confirmed by a fetch - shown ahead of the loaded window the instant a WebSocket push arrives, pruned once `refresh()`'s result includes them. */
  readonly liveCalls?: Signal<readonly CallRecord[]>;
  readonly onError?: (message: string | null) => void;
}

/**
 * @param pinnedIds Content-keyed ids (callKey) of pinned calls - excluded from the main list/grouping since they render in their own always-visible section instead.
 */
export function createCallListView(pinnedIds: Signal<ReadonlySet<string>>, options: CallListViewOptions): CallListView {
  const searchQuery = signal('');
  const pageSize = signal(options.pageSize ?? DEFAULT_PAGE_SIZE);
  const sortMode = signal<SortMode>(options.defaultSortMode ?? 'newest');
  const supplierFilter = signal('');
  const groupBySupplier = signal(false);
  const expanded = signal(true);
  const collapseAllVersion = signal(0);
  const loading = signal(false);

  const loadedCalls = signal<readonly CallRecord[]>([]);
  const totalCount = signal(0);

  /** The sort mode last actually sent to the backend - 'custom' never is, so switching into/out of it doesn't refetch, it just changes how the already-loaded window is displayed. */
  let lastFetchedSort: SortMode = sortMode() === 'custom' ? 'newest' : sortMode();

  interface FetchRequest {
    readonly offset: number;
    readonly limit: number;
    readonly replace: boolean;
  }

  const destroyRef = inject(DestroyRef);
  const requests$ = new Subject<FetchRequest>();

  requests$
    .pipe(
      switchMap((req) => {
        loading.set(true);
        const sort = sortMode() === 'custom' ? lastFetchedSort : sortMode();
        lastFetchedSort = sort;
        return options.fetchPage({ search: searchQuery().trim(), supplier: supplierFilter(), sort, offset: req.offset, limit: req.limit }).pipe(
          switchMap((result) => of({ req, result, failed: false })),
          catchError((err: unknown) => {
            options.onError?.(err instanceof Error ? err.message : String(err));
            return of({ req, result: { calls: [], total: totalCount() } as CallsPageResult, failed: true });
          })
        );
      }),
      takeUntilDestroyed(destroyRef)
    )
    .subscribe(({ req, result, failed }) => {
      loading.set(false);
      if (!failed) {
        options.onError?.(null);
        loadedCalls.set(req.replace ? [...result.calls] : [...loadedCalls(), ...result.calls]);
        totalCount.set(result.total);
      }
    });

  function fetch(offset: number, limit: number, replace: boolean): void {
    requests$.next({ offset, limit, replace });
  }

  fetch(0, pageSize(), true);

  const matchingCalls = computed(() => {
    const live = options.liveCalls?.() ?? [];
    const loadedKeys = new Set(loadedCalls().map(callKey));
    const unconfirmed = live.filter((c) => !loadedKeys.has(callKey(c)));
    return [...unconfirmed, ...loadedCalls()];
  });

  const withoutPinned = computed(() => {
    const pinned = pinnedIds();
    return matchingCalls().filter((c) => !pinned.has(callKey(c)));
  });

  const mainListCalls = computed(() => {
    const mode = sortMode();
    return mode === 'custom' ? sortCalls(withoutPinned(), 'custom', options.customOrder?.() ?? []) : [...withoutPinned()];
  });

  const supplierOptions = computed<SupplierOption[]>(() => {
    const counts = new Map<string, number>();
    for (const c of matchingCalls()) {
      counts.set(supplierOf(c), (counts.get(supplierOf(c)) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count }));
  });

  const stats = computed<CallStats>(() => {
    const list = matchingCalls();
    return {
      total: list.length,
      ok: list.filter((c) => c.response && c.response.status < 400).length,
      client: list.filter((c) => c.response && c.response.status >= 400 && c.response.status < 500).length,
      failed: list.filter((c) => c.error || (c.response && c.response.status >= 500)).length,
    };
  });

  return {
    searchQuery,
    limit: pageSize,
    sortMode,
    supplierFilter,
    groupBySupplier,
    expanded,
    collapseAllVersion,
    loading,
    supplierOptions,
    matchingCalls,
    stats,
    mainListCalls,
    visibleCalls: mainListCalls,
    remainingCount: computed(() => Math.max(0, totalCount() - loadedCalls().length)),
    groupedCalls: computed<SupplierGroup[]>(() => {
      const groups = new Map<string, CallRecord[]>();
      for (const c of mainListCalls()) {
        const supplier = supplierOf(c);
        const list = groups.get(supplier) ?? [];
        list.push(c);
        groups.set(supplier, list);
      }
      return [...groups.entries()]
        .map(([supplier, groupCalls]) => ({ supplier, calls: groupCalls }))
        .sort((a, b) => b.calls.length - a.calls.length);
    }),
    loadMorePageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    setSearchQuery(query: string) {
      searchQuery.set(query);
      fetch(0, pageSize(), true);
    },
    setLimit(newLimit: number) {
      pageSize.set(newLimit);
      fetch(0, newLimit, true);
    },
    setSortMode(mode: SortMode) {
      sortMode.set(mode);
      if (mode !== 'custom') {
        fetch(0, Math.max(pageSize(), loadedCalls().length), true);
      }
    },
    setSupplierFilter(supplier: string) {
      supplierFilter.set(supplier);
      fetch(0, pageSize(), true);
    },
    toggleGroupBySupplier() {
      groupBySupplier.set(!groupBySupplier());
    },
    toggleExpanded() {
      expanded.set(!expanded());
      collapseAllVersion.set(collapseAllVersion() + 1);
    },
    loadMore() {
      fetch(loadedCalls().length, pageSize(), false);
    },
    refresh() {
      fetch(0, Math.max(pageSize(), loadedCalls().length), true);
    },
    resetSource() {
      loadedCalls.set([]);
      totalCount.set(0);
      fetch(0, pageSize(), true);
    },
  };
}
