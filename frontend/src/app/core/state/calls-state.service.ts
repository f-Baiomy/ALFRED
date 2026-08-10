import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Subject, merge, of, timer } from 'rxjs';
import { webSocket } from 'rxjs/webSocket';
import { catchError, retry, switchMap, tap } from 'rxjs/operators';
import { CallEvent, CallRecord, SortMode } from '../models/call.model';
import { CallsApiService } from '../services/calls-api.service';
import { PinService } from '../services/pin.service';
import { AppConfigService } from '../services/app-config.service';
import { callKey, mergeLiveCalls, sortCalls, unconfirmedLiveCalls } from '../../shared/utils/call-utils';
import { CallListControlsState, BulkSelectionState, CallSelectionState } from './call-selection.tokens';
import { CallListView, createCallListView } from './call-list-view';

export type { CallStats, SupplierGroup, SupplierOption } from './call-list-view';

const POLL_INTERVAL_MS = 5000;

/**
 * Single source of truth for the dashboard: polls the backend, merges in live WebSocket pushes,
 * and delegates every filtered/sorted/paginated/grouped/stats view of the data to the shared
 * `createCallListView` factory (see call-list-view.ts) - the same one SessionCycleDetailStateService
 * uses for a cycle's captured calls, so a feature added to search/sort/group/stats shows up in
 * both places automatically. Components inject this directly, or inject one of the tokens in
 * call-selection.tokens.ts when they need to work against either state interchangeably.
 */
@Injectable({ providedIn: 'root' })
export class CallsStateService implements CallSelectionState, BulkSelectionState, CallListControlsState {
  private readonly api = inject(CallsApiService);
  private readonly pinService = inject(PinService);
  private readonly config = inject(AppConfigService);

  readonly error = signal<string | null>(null);

  /** Calls picked for bulk export, keyed by callKey() - not tied to sort/filter/pagination, so a selection survives those changing underneath it. */
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  private readonly manualRefresh = new Subject<void>();

  private readonly view: CallListView;

  private readonly polled$ = merge(timer(0, POLL_INTERVAL_MS), this.manualRefresh).pipe(
    switchMap(() =>
      this.api.getCalls(this.view.limit()).pipe(
        tap(() => this.error.set(null)),
        catchError((err: unknown) => {
          this.error.set(err instanceof Error ? err.message : String(err));
          return of<CallRecord[]>([]);
        })
      )
    )
  );

  private readonly polledCalls = toSignal(this.polled$, { initialValue: [] as CallRecord[] });

  /** Calls pushed live over WebSocket that the next poll hasn't confirmed yet - see the constructor's prune effect(). */
  private readonly liveCalls = signal<readonly CallRecord[]>([]);

  /** Live-pushed calls first (so they render the instant they arrive), then the polled list - deduped by callKey so a call never renders twice while both copies exist. */
  readonly calls = computed(() => mergeLiveCalls(this.liveCalls(), this.polledCalls()));

  readonly pinned = this.pinService.pinned;

  constructor() {
    this.view = createCallListView(this.calls, computed(() => new Set(this.pinned().keys())));

    // Once a poll confirms a live-pushed call is in calls.log, drop it from liveCalls - the
    // dedupe in `calls` above already prevents a double-render even before this runs, but
    // without pruning, liveCalls would grow forever.
    effect(
      () => {
        const pruned = unconfirmedLiveCalls(this.liveCalls(), this.polledCalls());
        if (pruned.length !== this.liveCalls().length) {
          this.liveCalls.set(pruned);
        }
      },
      { allowSignalWrites: true }
    );

    this.connectLiveUpdates();
  }

  /**
   * Pushes a new CallRecord onto the dashboard the instant the proxy's webhook reaches
   * backend, instead of waiting for the next 5s poll. Falls back to a fixed retry delay on
   * disconnect - polling keeps the dashboard eventually-correct even if the socket never
   * reconnects, so this is a latency improvement, not a hard dependency.
   */
  private connectLiveUpdates(): void {
    const wsUrl = this.config.backendUrl.replace(/^http/, 'ws') + '/ws/calls';
    webSocket<CallEvent>(wsUrl)
      .pipe(retry({ delay: () => timer(3000) }))
      .subscribe(({ call }) => {
        const key = callKey(call);
        this.liveCalls.set([call, ...this.liveCalls().filter((c) => callKey(c) !== key)]);
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

  setSearchQuery(query: string): void {
    this.view.setSearchQuery(query);
  }

  setLimit(limit: number): void {
    this.view.setLimit(limit);
    this.manualRefresh.next();
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
    this.manualRefresh.next();
  }

  /** In current-sort-order, not click order - deterministic regardless of which one you happened to check first. */
  readonly selectedCalls = computed(() => {
    const ids = this.selectedIds();
    if (ids.size === 0) return [];
    return sortCalls(this.calls(), this.view.sortMode()).filter((c) => ids.has(callKey(c)));
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

  /** Selects every call currently matching the search/supplier filter - not just the paginated slice - so "select all" behaves the way a user expects even before scrolling to load more. */
  selectAll(): void {
    this.selectedIds.set(new Set(this.view.matchingCalls().map(callKey)));
  }
}
