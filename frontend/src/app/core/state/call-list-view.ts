import { Signal, computed, signal } from '@angular/core';
import { CallRecord, SortMode } from '../models/call.model';
import { callKey, matchesSearch, sortCalls, supplierOf } from '../../shared/utils/call-utils';

const PAGE_SIZE = 20;

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

/**
 * Every filtered/sorted/paginated/grouped/stats view derived from a raw list of calls -
 * search/sort/supplier-filter/group-by-supplier/collapse-expand/limit/pagination. Shared by
 * CallsStateService (the dashboard) and SessionCycleDetailStateService (one open cycle) so any
 * feature added here shows up in both places automatically instead of drifting between two
 * hand-copied implementations.
 */
export interface CallListView {
  readonly searchQuery: Signal<string>;
  readonly limit: Signal<number>;
  readonly sortMode: Signal<SortMode>;
  readonly supplierFilter: Signal<string>;
  readonly groupBySupplier: Signal<boolean>;
  readonly expanded: Signal<boolean>;
  readonly collapseAllVersion: Signal<number>;
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
}

export interface CallListViewOptions {
  /** Defaults to 'newest' (the dashboard's convention) - a session-cycle detail view opts into 'oldest-call' instead, since a repro's calls read better sorted by when they actually happened (call.timestamp), not capture/received order. */
  readonly defaultSortMode?: SortMode;
}

/**
 * @param calls Raw calls in newest-first order, already merged with any live-pushed entries.
 * @param pinnedIds Content-keyed ids (callKey) of pinned calls - excluded from the main list/grouping since they render in their own always-visible section instead.
 */
export function createCallListView(
  calls: Signal<readonly CallRecord[]>,
  pinnedIds: Signal<ReadonlySet<string>>,
  options: CallListViewOptions = {}
): CallListView {
  const searchQuery = signal('');
  const limit = signal(50);
  const sortMode = signal<SortMode>(options.defaultSortMode ?? 'newest');
  const supplierFilter = signal('');
  const groupBySupplier = signal(false);
  const expanded = signal(true);
  const collapseAllVersion = signal(0);
  const visibleCount = signal(PAGE_SIZE);

  // Bounding by `limit` here (not just at the data source) makes the "Last N" control
  // meaningful even for a source that doesn't fetch with a server-side limit param (e.g. a
  // session-cycle's captured calls) - and is a no-op for a source that's already limit-bounded
  // upstream (the dashboard's poll), since slicing to the same N twice changes nothing.
  const boundedCalls = computed(() => calls().slice(0, limit()));

  const supplierOptions = computed<SupplierOption[]>(() => {
    const counts = new Map<string, number>();
    for (const c of boundedCalls()) {
      counts.set(supplierOf(c), (counts.get(supplierOf(c)) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count }));
  });

  const matchingCalls = computed(() => {
    const query = searchQuery().trim();
    const supplier = supplierFilter();
    return boundedCalls().filter((c) => matchesSearch(c, query) && (!supplier || supplierOf(c) === supplier));
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

  const mainListCalls = computed(() => {
    const pinned = pinnedIds();
    const withoutPinned = matchingCalls().filter((c) => !pinned.has(callKey(c)));
    return sortCalls(withoutPinned, sortMode());
  });

  const effectiveVisibleCount = computed(() => Math.max(PAGE_SIZE, Math.min(visibleCount(), mainListCalls().length)));

  const visibleCalls = computed(() => mainListCalls().slice(0, effectiveVisibleCount()));
  const remainingCount = computed(() => mainListCalls().length - visibleCalls().length);

  const groupedCalls = computed<SupplierGroup[]>(() => {
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
  });

  return {
    searchQuery,
    limit,
    sortMode,
    supplierFilter,
    groupBySupplier,
    expanded,
    collapseAllVersion,
    supplierOptions,
    matchingCalls,
    stats,
    mainListCalls,
    visibleCalls,
    remainingCount,
    groupedCalls,
    loadMorePageSize: PAGE_SIZE,
    setSearchQuery(query: string) {
      searchQuery.set(query);
      visibleCount.set(PAGE_SIZE);
    },
    setLimit(newLimit: number) {
      limit.set(newLimit);
      visibleCount.set(PAGE_SIZE);
    },
    setSortMode(mode: SortMode) {
      sortMode.set(mode);
      visibleCount.set(PAGE_SIZE);
    },
    setSupplierFilter(supplier: string) {
      supplierFilter.set(supplier);
      visibleCount.set(PAGE_SIZE);
    },
    toggleGroupBySupplier() {
      groupBySupplier.set(!groupBySupplier());
      visibleCount.set(PAGE_SIZE);
    },
    toggleExpanded() {
      expanded.set(!expanded());
      collapseAllVersion.set(collapseAllVersion() + 1);
    },
    loadMore() {
      visibleCount.set(visibleCount() + PAGE_SIZE);
    },
  };
}
