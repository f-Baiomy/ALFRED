import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Observable, Subject, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { CallOverlapCandidate, CallRecord, SortMode } from '../models/call.model';
import { CallListRow, CallStatusFilter, callKey, isInProgress, matchesStatusFilter, sortCalls, splitCallsForDisplay, supplierOf } from '../../shared/utils/call-utils';
import {
  CallDepthInfo,
  CallTreeNode,
  CallViewMode,
  DEFAULT_CALL_VIEW_MODE,
  TREE_FALLBACK_SORT_MODE,
  buildCallTree,
  indexCallTree,
  isTreeSortMode,
  requiresChronologicalSort,
} from '../../shared/utils/call-tree';

const DEFAULT_PAGE_SIZE = 10;

/** Which of the three call views the list renders - a personal display choice like
 * SHOW_OPTIONS_CALLS_KEY, so it's remembered across reloads rather than reset every visit. */
const CALL_VIEW_MODE_KEY = 'alfred_call_view_mode';

const CALL_VIEW_MODES: readonly CallViewMode[] = ['flat-depth', 'nested', 'waterfall'];

function loadViewMode(): CallViewMode {
  try {
    const stored = localStorage.getItem(CALL_VIEW_MODE_KEY);
    return CALL_VIEW_MODES.includes(stored as CallViewMode) ? (stored as CallViewMode) : DEFAULT_CALL_VIEW_MODE;
  } catch {
    return DEFAULT_CALL_VIEW_MODE;
  }
}

function saveViewMode(value: CallViewMode): void {
  try {
    localStorage.setItem(CALL_VIEW_MODE_KEY, value);
  } catch {
    // storage full/blocked - the preference just won't survive a reload this time
  }
}

/** A CORS preflight - almost never what anyone actually wants to look at (see call-card's docs on
 * OPTIONS/preflight pairs), so hiding it is the default; the preference is remembered across
 * reloads since it's a personal display choice, not page-specific data. */
const SHOW_OPTIONS_CALLS_KEY = 'alfred_show_options_calls';

function loadShowOptionsCalls(): boolean {
  try {
    return localStorage.getItem(SHOW_OPTIONS_CALLS_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveShowOptionsCalls(value: boolean): void {
  try {
    localStorage.setItem(SHOW_OPTIONS_CALLS_KEY, String(value));
  } catch {
    // storage full/blocked - the preference just won't survive a reload this time
  }
}

export interface SupplierOption {
  readonly name: string;
  readonly count: number;
}

export interface CallStats {
  readonly total: number;
  readonly ok: number;
  readonly client: number;
  readonly failed: number;
  readonly inProgress: number;
}

/** Lives in call-utils.ts now (so its containment-check helpers can share it without a call-utils.ts <-> call-list-view.ts import cycle) - re-exported here since every existing consumer of this module imports it from here. */
export type { CallStatusFilter };

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
  readonly sessionId: string;
  readonly operationId: string;
  readonly requestId: string;
}

export interface CallsPageResult {
  readonly calls: readonly CallRecord[];
  readonly total: number;
}

/**
 * Params for GET /call-overlaps / GET /session-cycles/{id}/call-overlaps - the same
 * search/session/operation/request filters CallsQuery already sends, minus sort/offset/limit
 * (this fetches every candidate in the range in one batch, not a page) plus the `from`/`to` range
 * itself. `serviceNames` isn't included here - it's derived from selectedSources by the caller
 * (CallsStateService/SessionCycleDetailStateService), the same way fetchPageForSource derives it,
 * since createCallListView has no notion of "which sources are selected".
 */
export interface CallOverlapQuery {
  readonly from: string;
  readonly to: string;
  readonly search: string;
  readonly supplier: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly requestId: string;
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
  readonly sessionIdFilter: Signal<string>;
  readonly operationIdFilter: Signal<string>;
  readonly requestIdFilter: Signal<string>;
  /** Client-side narrowing by stat-pill bucket - unlike the filters above this never refetches, it just re-filters the already-loaded window (see matchesStatusFilter). */
  readonly statusFilter: Signal<CallStatusFilter>;
  readonly groupBySupplier: Signal<boolean>;
  /** Whether CORS preflight (OPTIONS) calls show up in the list at all - off by default (see
   * SHOW_OPTIONS_CALLS_KEY), persisted across reloads. Client-side only, like statusFilter -
   * narrows the already-loaded window rather than refetching. */
  readonly showOptionsCalls: Signal<boolean>;
  readonly expanded: Signal<boolean>;
  readonly collapseAllVersion: Signal<number>;
  readonly loading: Signal<boolean>;
  readonly supplierOptions: Signal<SupplierOption[]>;
  readonly matchingCalls: Signal<CallRecord[]>;
  readonly stats: Signal<CallStats>;
  readonly mainListCalls: Signal<CallRecord[]>;
  readonly visibleCalls: Signal<CallRecord[]>;
  /**
   * `mainListCalls`/`visibleCalls` expanded into display rows - an internal call becomes a
   * request row plus (once resolved) a response row when the list is in chronological order; see
   * splitCallsForDisplay(). Purely additional/for rendering: `visibleCalls` itself keeps returning
   * one real CallRecord per call, unsplit, since drag-drop reorder (onDrop in
   * call-list.component.ts) and export-ordering logic key off of it directly.
   */
  readonly visibleRows: Signal<readonly CallListRow[]>;
  /** Which of the three views is rendering - 'flat-depth' by default, remembered across reloads
   * (see CALL_VIEW_MODE_KEY). The only one that splits: see CallViewMode's own doc. */
  readonly viewMode: Signal<CallViewMode>;
  /**
   * `mainListCalls()` arranged as a forest - every call appears exactly once, nested under whatever
   * is proven to contain it. What the 'nested' and 'waterfall' views render from directly; the
   * 'flat-depth' view ignores it in favour of `callDepths` below, since it renders no hierarchy.
   */
  readonly callTree: Signal<readonly CallTreeNode[]>;
  /** Per-call depth/parent/span annotations for the flat-depth view's badge and timing bar, keyed
   * by call id - every call in `mainListCalls()` has an entry, roots included. */
  readonly callDepths: Signal<ReadonlyMap<string, CallDepthInfo>>;
  /**
   * The batch of overlap candidates fetched for whatever time range `mainListCalls()` currently
   * spans, under the currently-active filters - `undefined` while that fetch for the current range
   * hasn't resolved yet (or hasn't been triggered at all, e.g. nothing loaded), in which case every
   * internal/resolved call in `visibleRows` renders provisionally split (the safe default - see
   * splitCallsForDisplay). Recomputes (and refetches) whenever `mainListCalls()` changes - a new
   * page loaded, a WS-pushed call arriving, or a filter changing.
   */
  readonly overlapCandidates: Signal<readonly CallOverlapCandidate[] | undefined>;
  readonly remainingCount: Signal<number>;
  readonly groupedCalls: Signal<SupplierGroup[]>;
  readonly loadMorePageSize: number;
  setSearchQuery(query: string): void;
  setLimit(limit: number): void;
  setSortMode(mode: SortMode): void;
  setSupplierFilter(supplier: string): void;
  setSessionIdFilter(sessionId: string): void;
  setOperationIdFilter(operationId: string): void;
  setRequestIdFilter(requestId: string): void;
  /** Clicking the same bucket again clears the filter back to 'all' - see StatsBarComponent. */
  setStatusFilter(filter: CallStatusFilter): void;
  toggleGroupBySupplier(): void;
  toggleShowOptionsCalls(): void;
  /** Picking a tree view ('nested'/'waterfall') while a non-chronological sort is active also moves
   * the list back to a chronological sort - a tree can't be drawn over an order that scatters a
   * parent away from its children (see CallViewMode's doc). */
  setViewMode(mode: CallViewMode): void;
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
  /**
   * Fetches every overlap candidate (see CallOverlapCandidate) for the given range/filters -
   * CallsApiService.getCallOverlaps or SessionCyclesApiService.getCallOverlaps, each already
   * knowing how to fold in its own selectedSources-derived serviceNames the same way its
   * `fetchPage` counterpart does. Invoked once per relevant time range (see `overlapCandidates`'s
   * doc on CallListView), not per-call and not per-card.
   */
  readonly fetchOverlaps: (query: CallOverlapQuery) => Observable<readonly CallOverlapCandidate[]>;
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
  const sessionIdFilter = signal('');
  const operationIdFilter = signal('');
  const requestIdFilter = signal('');
  const statusFilter = signal<CallStatusFilter>('all');
  const groupBySupplier = signal(false);
  const showOptionsCalls = signal(loadShowOptionsCalls());
  const viewMode = signal<CallViewMode>(loadViewMode());
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
        return options.fetchPage({
          search: searchQuery().trim(),
          supplier: supplierFilter(),
          sort,
          offset: req.offset,
          limit: req.limit,
          sessionId: sessionIdFilter().trim(),
          operationId: operationIdFilter().trim(),
          requestId: requestIdFilter().trim(),
        }).pipe(
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

  /**
   * A live-pushed call that doesn't match the currently-active supplier/id filters must not show
   * up ahead of the (correctly filtered) loaded window just because it hasn't been confirmed by a
   * fetch yet - confirmed live: with an id filter active and real traffic streaming in, every new
   * unrelated call kept appearing at the top of an otherwise-narrowed list, and never got pruned
   * (the "already in loadedCalls" check in matchingCalls below never becomes true for a call that
   * genuinely doesn't match the filter, so it would linger until a full page reload). Free-text
   * `search` isn't checked here (a CallSummaryDto never carries headers/body to match against
   * client-side) - that gap already existed before these id filters and is unchanged by this fix.
   */
  function matchesActiveFilters(call: CallRecord): boolean {
    const supplier = supplierFilter().trim();
    if (supplier && supplierOf(call) !== supplier) return false;
    const session = sessionIdFilter().trim().toLowerCase();
    if (session && !(call.session_id ?? '').toLowerCase().includes(session)) return false;
    const operation = operationIdFilter().trim().toLowerCase();
    if (operation && !(call.operation_id ?? '').toLowerCase().includes(operation)) return false;
    const request = requestIdFilter().trim().toLowerCase();
    if (request && !call.id.toLowerCase().includes(request)) return false;
    return true;
  }

  const matchingCalls = computed(() => {
    const live = options.liveCalls?.() ?? [];
    const loadedKeys = new Set(loadedCalls().map(callKey));
    const unconfirmed = live.filter((c) => !loadedKeys.has(callKey(c)) && matchesActiveFilters(c));
    return [...unconfirmed, ...loadedCalls()];
  });

  /** matchingCalls minus a CORS preflight when showOptionsCalls() is off - unlike statusFilter
   * (a temporary drill-down that deliberately keeps totals stable), hiding OPTIONS is a persistent
   * display preference, so stats()/supplierOptions() are scoped off this too, not matchingCalls -
   * the "N calls" pill should match what's actually visible. */
  const optionsFiltered = computed(() => {
    return showOptionsCalls() ? matchingCalls() : matchingCalls().filter((c) => c.method !== 'OPTIONS');
  });

  const withoutPinned = computed(() => {
    const pinned = pinnedIds();
    return optionsFiltered().filter((c) => !pinned.has(callKey(c)));
  });

  /** withoutPinned narrowed to the active stat-pill bucket, if any - stats() below deliberately stays scoped to optionsFiltered (unfiltered by the status pill) so the pill counts never shrink as a result of clicking a pill. */
  const statusFiltered = computed(() => {
    const filter = statusFilter();
    return filter === 'all' ? withoutPinned() : withoutPinned().filter((c) => matchesStatusFilter(c, filter));
  });

  const mainListCalls = computed(() => {
    const mode = sortMode();
    return mode === 'custom' ? sortCalls(statusFiltered(), 'custom', options.customOrder?.() ?? []) : [...statusFiltered()];
  });

  /**
   * The [from, to] range `mainListCalls()` currently spans - `from` is the earliest call's own
   * timestamp, `to` is the latest point any loaded call's window extends to (its timestamp plus
   * its own duration, since a candidate can legitimately fall after every loaded call's start but
   * still land inside one of their windows). `null` when nothing's loaded (or every timestamp is
   * unparseable) - see the overlapCandidates subscription below for how that's handled.
   */
  const overlapRange = computed<{ from: string; to: string } | null>(() => {
    const calls = mainListCalls();
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const call of calls) {
      const start = new Date(call.timestamp).getTime();
      if (Number.isNaN(start)) continue;
      const end = start + (call.duration_ms ?? 0);
      if (start < minStart) minStart = start;
      if (end > maxEnd) maxEnd = end;
    }
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return null;
    return { from: new Date(minStart).toISOString(), to: new Date(maxEnd).toISOString() };
  });

  /**
   * `undefined` = not loaded (yet) for the current range - the safe "render provisionally split"
   * default splitCallsForDisplay falls back to. Reset to `undefined` the instant the range changes
   * (including a brand new fetch superseding a stale in-flight one, via switchMap), so a call never
   * shows a stale range's candidates as if they were current.
   */
  const overlapCandidates = signal<readonly CallOverlapCandidate[] | undefined>(undefined);

  toObservable(overlapRange)
    .pipe(
      switchMap((range) => {
        overlapCandidates.set(undefined);
        if (!range) return of([] as readonly CallOverlapCandidate[]);
        return options.fetchOverlaps({
          from: range.from,
          to: range.to,
          search: searchQuery().trim(),
          supplier: supplierFilter(),
          sessionId: sessionIdFilter().trim(),
          operationId: operationIdFilter().trim(),
          requestId: requestIdFilter().trim(),
        }).pipe(catchError(() => of(undefined)));
      }),
      takeUntilDestroyed(destroyRef)
    )
    .subscribe((result) => overlapCandidates.set(result));

  const supplierOptions = computed<SupplierOption[]>(() => {
    const counts = new Map<string, number>();
    for (const c of optionsFiltered()) {
      counts.set(supplierOf(c), (counts.get(supplierOf(c)) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count }));
  });

  const stats = computed<CallStats>(() => {
    const list = optionsFiltered();
    return {
      total: list.length,
      ok: list.filter((c) => c.response && c.response.status < 400).length,
      client: list.filter((c) => c.response && c.response.status >= 400 && c.response.status < 500).length,
      failed: list.filter((c) => c.error || (c.response && c.response.status >= 500)).length,
      inProgress: list.filter(isInProgress).length,
    };
  });

  return {
    searchQuery,
    limit: pageSize,
    sortMode,
    supplierFilter,
    sessionIdFilter,
    operationIdFilter,
    requestIdFilter,
    statusFilter,
    groupBySupplier,
    showOptionsCalls,
    expanded,
    collapseAllVersion,
    loading,
    supplierOptions,
    matchingCalls,
    stats,
    mainListCalls,
    visibleCalls: mainListCalls,
    // The request/response split belongs to the flat-depth view alone (see CallViewMode) - the
    // other two enclose or bracket their children structurally, so splitting there would only
    // restate what the card or the bar already shows.
    visibleRows: computed<readonly CallListRow[]>(() =>
      viewMode() === 'flat-depth'
        ? splitCallsForDisplay(mainListCalls(), sortMode(), overlapCandidates(), statusFilter())
        : mainListCalls().map((call) => ({ call, variant: 'full' as const, rowKey: call.id }))
    ),
    viewMode,
    callTree: computed(() => buildCallTree(mainListCalls())),
    callDepths: computed(() => indexCallTree(mainListCalls())),
    overlapCandidates,
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
    setSessionIdFilter(sessionId: string) {
      sessionIdFilter.set(sessionId);
      fetch(0, pageSize(), true);
    },
    setOperationIdFilter(operationId: string) {
      operationIdFilter.set(operationId);
      fetch(0, pageSize(), true);
    },
    setRequestIdFilter(requestId: string) {
      requestIdFilter.set(requestId);
      fetch(0, pageSize(), true);
    },
    setStatusFilter(filter: CallStatusFilter) {
      statusFilter.update((current) => (current === filter ? 'all' : filter));
    },
    toggleGroupBySupplier() {
      groupBySupplier.set(!groupBySupplier());
    },
    toggleShowOptionsCalls() {
      const next = !showOptionsCalls();
      showOptionsCalls.set(next);
      saveShowOptionsCalls(next);
    },
    setViewMode(mode: CallViewMode) {
      viewMode.set(mode);
      saveViewMode(mode);
      if (!requiresChronologicalSort(mode) || isTreeSortMode(sortMode())) return;
      // Same refetch as setSortMode - the backend decides the order, so a tree view can't just
      // re-sort what's already loaded and call it chronological.
      sortMode.set(TREE_FALLBACK_SORT_MODE);
      fetch(0, Math.max(pageSize(), loadedCalls().length), true);
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
