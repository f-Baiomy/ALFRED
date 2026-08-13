import { Injectable, computed, inject, signal } from '@angular/core';
import { webSocket } from 'rxjs/webSocket';
import { Observable, retry, timer } from 'rxjs';
import { CallDetail, CallRecord, CallsWsMessage, SortMode } from '../models/call.model';
import { CallsApiService } from '../services/calls-api.service';
import { PinService } from '../services/pin.service';
import { AppConfigService } from '../services/app-config.service';
import { callKey, toCallRecord } from '../../shared/utils/call-utils';
import { CallListControlsState, BulkSelectionState, CallSelectionState } from './call-selection.tokens';
import { CallListView, createCallListView } from './call-list-view';

export type { CallStats, SupplierGroup, SupplierOption } from './call-list-view';

/**
 * Single source of truth for the dashboard: fetches pages from the backend (search/sort/supplier
 * filtering happen server-side now - see call-list-view.ts) and reconciles them whenever a
 * WebSocket push arrives, instead of polling on a fixed interval. Delegates every
 * filtered/sorted/paginated/grouped/stats view of the data to the shared `createCallListView`
 * factory - the same one SessionCycleDetailStateService uses for a cycle's captured calls, so a
 * feature added to search/sort/group/stats shows up in both places automatically. Components
 * inject this directly, or inject one of the tokens in call-selection.tokens.ts when they need to
 * work against either state interchangeably.
 */
@Injectable({ providedIn: 'root' })
export class CallsStateService implements CallSelectionState, BulkSelectionState, CallListControlsState {
  private readonly api = inject(CallsApiService);
  private readonly pinService = inject(PinService);
  private readonly config = inject(AppConfigService);

  readonly error = signal<string | null>(null);

  /** Calls picked for bulk export, keyed by callKey() - not tied to sort/filter/pagination, so a selection survives those changing underneath it. */
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  private readonly view: CallListView;

  /** Calls pushed live over WebSocket that the next refresh() hasn't confirmed yet. */
  private readonly liveCalls = signal<readonly CallRecord[]>([]);

  readonly pinned = this.pinService.pinned;

  constructor() {
    this.view = createCallListView(
      computed(() => new Set(this.pinned().keys())),
      {
        pageSize: 50,
        fetchPage: (query) => this.api.getCalls(query),
        liveCalls: this.liveCalls,
        onError: (message) => this.error.set(message),
      }
    );

    this.connectLiveUpdates();
  }

  /**
   * Pushes a new CallRecord onto the dashboard the instant the proxy's webhook reaches backend,
   * and immediately triggers a refresh() to fetch the authoritative (filtered/sorted/paginated)
   * page - there's no 5s poll to eventually pick it up otherwise. Falls back to a fixed retry
   * delay on disconnect; a call that arrives during a reconnect gap is only picked up by the next
   * push or a manual refresh, which is the accepted trade-off of not polling.
   */
  private connectLiveUpdates(): void {
    const wsUrl = this.config.backendUrl.replace(/^http/, 'ws') + '/ws/calls';
    webSocket<CallsWsMessage>(wsUrl)
      .pipe(retry({ delay: () => timer(3000) }))
      .subscribe((message) => {
        if (!('call' in message)) {
          this.liveCalls.set([]);
          this.view.refresh();
          return;
        }
        const call = toCallRecord(message.call);
        // Matched by id, not callKey - two-phase logging pushes the same call twice (once
        // IN_PROGRESS at prepare, once resolved at complete), and id is the one thing guaranteed
        // stable across both pushes for the exact same call.
        this.liveCalls.set([call, ...this.liveCalls().filter((c) => c.id !== call.id)]);
        this.view.refresh();
      });
  }

  // ---- CallListControlsState (delegates to the shared view) ----

  get searchQuery() {
    return this.view.searchQuery;
  }
  get limit() {
    return this.view.limit;
  }
  get sortMode() {
    return this.view.sortMode;
  }
  get supplierFilter() {
    return this.view.supplierFilter;
  }
  get groupBySupplier() {
    return this.view.groupBySupplier;
  }
  get expanded() {
    return this.view.expanded;
  }
  get collapseAllVersion() {
    return this.view.collapseAllVersion;
  }
  get supplierOptions() {
    return this.view.supplierOptions;
  }
  get calls() {
    return this.view.matchingCalls;
  }
  get matchingCalls() {
    return this.view.matchingCalls;
  }
  get stats() {
    return this.view.stats;
  }
  get mainListCalls() {
    return this.view.mainListCalls;
  }
  get visibleCalls() {
    return this.view.visibleCalls;
  }
  get remainingCount() {
    return this.view.remainingCount;
  }
  get groupedCalls() {
    return this.view.groupedCalls;
  }
  get loadMorePageSize() {
    return this.view.loadMorePageSize;
  }
  get loading() {
    return this.view.loading;
  }

  refresh(): void {
    this.view.refresh();
  }

  resetSource(): void {
    this.view.resetSource();
  }

  setSearchQuery(query: string): void {
    this.view.setSearchQuery(query);
  }

  setLimit(limit: number): void {
    this.view.setLimit(limit);
  }

  setSortMode(mode: SortMode): void {
    this.view.setSortMode(mode);
  }

  setSupplierFilter(supplier: string): void {
    this.view.setSupplierFilter(supplier);
  }

  toggleGroupBySupplier(): void {
    this.view.toggleGroupBySupplier();
  }

  toggleExpanded(): void {
    this.view.toggleExpanded();
  }

  loadMore(): void {
    this.view.loadMore();
  }

  refreshNow(): void {
    this.view.refresh();
  }

  /** Always a real network call - never served from a cache, so a call's detail is refetched every time it's expanded, even if it was already loaded before (this session or otherwise). */
  getCallDetail(callId: string): Observable<CallDetail> {
    return this.api.getDetail(callId);
  }

  /**
   * In the exact order the list is actually rendered on screen - pinned calls first (their own
   * always-visible section, per PinService's order), then either the grouped-by-supplier view
   * (biggest group first) or the flat sorted list, whichever CallListComponent is currently
   * showing. Exports (bulk report/JSON/cURL) read this directly, so a plain flat re-sort here
   * used to silently disagree with the screen whenever a selected call was pinned or "Group by
   * supplier" was on - see mainListCalls/groupedCalls in call-list-view.ts for how each is built.
   * Scoped to what's currently loaded - see call-list-view.ts's doc comment.
   */
  readonly selectedCalls = computed(() => {
    const ids = this.selectedIds();
    if (ids.size === 0) return [];
    const displayOrder = this.view.groupBySupplier() ? this.view.groupedCalls().flatMap((g) => g.calls) : this.view.mainListCalls();
    return [...this.pinService.pinned().values(), ...displayOrder].filter((c) => ids.has(callKey(c)));
  });

  /** Whether a drag-select is in progress, and which state (select/deselect) it's painting - set by the card the drag started on, applied to every card the pointer subsequently enters. */
  private dragSelectValue: boolean | null = null;

  isSelected(call: CallRecord): boolean {
    return this.selectedIds().has(callKey(call));
  }

  toggleSelected(call: CallRecord): void {
    this.setSelected(call, !this.isSelected(call));
  }

  private setSelected(call: CallRecord, selected: boolean): void {
    const id = callKey(call);
    const next = new Set(this.selectedIds());
    if (selected) {
      next.add(id);
    } else {
      next.delete(id);
    }
    this.selectedIds.set(next);
  }

  /** Call on mousedown on a card: flips that card and remembers the resulting state so a subsequent drag paints the same state onto every card the pointer passes over. */
  startDragSelect(call: CallRecord): void {
    this.dragSelectValue = !this.isSelected(call);
    this.setSelected(call, this.dragSelectValue);
  }

  /** Call on mouseenter while a drag-select is active. */
  dragSelectOver(call: CallRecord): void {
    if (this.dragSelectValue === null) return;
    this.setSelected(call, this.dragSelectValue);
  }

  /** Call on mouseup/dragend anywhere, to end the drag regardless of where the pointer was released. */
  endDragSelect(): void {
    this.dragSelectValue = null;
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /** Selects every call currently loaded and matching the search/supplier filter - not every call that would ever match, since only the loaded window is known client-side (see call-list-view.ts). */
  selectAll(): void {
    this.selectedIds.set(new Set(this.view.matchingCalls().map(callKey)));
  }
}
