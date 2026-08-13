import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Observable, map, retry, timer } from 'rxjs';
import { webSocket } from 'rxjs/webSocket';
import { CallDetail, CallEvent, CallRecord, CapturedCall, SortMode } from '../models/call.model';
import { AppConfigService } from '../services/app-config.service';
import { PinService } from '../services/pin.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { BulkSelectionState, CallListControlsState, CallReorderState, CallRemovalState, CallSelectionState } from './call-selection.tokens';
import { CallListView, createCallListView } from './call-list-view';
import { callKey, toCallRecord } from '../../shared/utils/call-utils';

/**
 * Per-open-cycle state for the session-cycle detail page - component-provided (see
 * SessionCycleDetailComponent), NOT root, so navigating between two different cycles gets a fresh
 * instance instead of leaking selection/live state from the previous one. Mirrors
 * CallsStateService's fetch-on-demand+live-merge+selection+search/sort/group/stats shape (via the
 * same createCallListView factory), scoped to one cycle's captured calls.
 */
@Injectable()
export class SessionCycleDetailStateService implements CallSelectionState, BulkSelectionState, CallListControlsState, CallRemovalState, CallReorderState {
  private readonly api = inject(SessionCyclesApiService);
  private readonly config = inject(AppConfigService);
  private readonly route = inject(ActivatedRoute);
  private readonly pinService = inject(PinService);

  readonly cycleId = toSignal(this.route.paramMap.pipe(map((params) => params.get('id') ?? '')), { initialValue: '' });

  readonly error = signal<string | null>(null);

  private readonly view: CallListView;

  /** The real CapturedCall (with its backend id) behind every CallRecord seen so far this cycle - since a live WebSocket push only carries the bare CallRecord, and removal needs the wrapper's id. Never shrinks except on cycleId change; a page reload of the same window just overwrites entries. */
  private readonly capturedByKey = new Map<string, CapturedCall>();

  /** Captured calls pushed live over WebSocket that the next refresh() hasn't confirmed (with their real backend id) yet. */
  private readonly liveCalls = signal<readonly CallRecord[]>([]);

  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  private dragSelectValue: boolean | null = null;

  /** Manually drag-and-drop arranged order (callKeys), persisted to localStorage per cycle so it
   * survives a reload - see CALL_REORDER_STATE. Only ever populated on this page; the dashboard
   * has no equivalent. */
  readonly customOrder = signal<readonly string[]>([]);

  readonly dragEnabled = computed(() => !this.groupBySupplier());

  constructor() {
    this.view = createCallListView(computed(() => new Set(this.pinService.pinned().keys())), {
      defaultSortMode: 'oldest-call',
      customOrder: this.customOrder,
      liveCalls: this.liveCalls,
      onError: (message) => this.error.set(message),
      fetchPage: (query) => {
        const id = this.cycleId();
        return this.api.listCalls(id, query).pipe(
          map((page) => {
            for (const c of page.calls) {
              this.capturedByKey.set(callKey(c.call), c);
            }
            return { calls: page.calls.map((c) => c.call), total: page.total };
          })
        );
      },
    });

    // A different cycle is an entirely different data source, not just a query change - clears
    // everything loaded so far (including the id lookup) and refetches page one, rather than
    // e.g. appending cycle B's calls onto cycle A's leftover window.
    effect(
      () => {
        this.cycleId();
        this.capturedByKey.clear();
        this.liveCalls.set([]);
        this.view.resetSource();
      },
      { allowSignalWrites: true }
    );

    // Reloads the saved arrangement (if any) whenever the open cycle changes, including the
    // first time it resolves from '' - a different cycle's custom order must never leak into
    // this one, and switching back to a cycle visited earlier this session should restore it.
    // Also switches sortMode to 'custom' when a saved arrangement exists, or the reload just
    // silently drops back to the default sort with the arrangement never visibly reapplying
    // until the user manually reselects "Custom order" (confirmed live).
    effect(
      () => {
        const id = this.cycleId();
        const saved = id ? this.loadCustomOrder(id) : [];
        this.customOrder.set(saved);
        if (saved.length > 0) {
          this.setSortMode('custom');
        }
      },
      { allowSignalWrites: true }
    );

    this.connectLiveUpdates();
  }

  private customOrderStorageKey(cycleId: string): string {
    return `alfred-custom-order-cycle-${cycleId}`;
  }

  private loadCustomOrder(cycleId: string): readonly string[] {
    try {
      const raw = localStorage.getItem(this.customOrderStorageKey(cycleId));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  // ---- CallReorderState ----

  /** CDK's drop handler already produces the visible list's new order (via moveItemInArray) -
   * this just also carries forward any call not currently visible (paginated out, or filtered by
   * search/supplier) after whatever's now-ordered, so a "Load more"/filter change afterward
   * doesn't lose track of calls that were never part of this particular drag. */
  reorder(orderedCalls: readonly CallRecord[]): void {
    const id = this.cycleId();
    if (!id) return;

    const orderedKeys = orderedCalls.map(callKey);
    const orderedSet = new Set(orderedKeys);
    const rest = this.view.mainListCalls().map(callKey).filter((key) => !orderedSet.has(key));
    const nextOrder = [...orderedKeys, ...rest];

    this.customOrder.set(nextOrder);
    this.setSortMode('custom');
    try {
      localStorage.setItem(this.customOrderStorageKey(id), JSON.stringify(nextOrder));
    } catch {
      // Storage can fail (quota, private browsing) - the arrangement still applies for this
      // session via the signal, it just won't survive a reload. Not worth surfacing an error for.
    }
  }

  /**
   * Pushes a captured call onto the page the instant it's recorded, and immediately triggers a
   * refresh() for the authoritative page - there's no 5s poll to eventually pick it up otherwise.
   */
  private connectLiveUpdates(): void {
    const wsUrl = this.config.backendUrl.replace(/^http/, 'ws') + '/ws/calls';
    webSocket<CallEvent>(wsUrl)
      .pipe(retry({ delay: () => timer(3000) }))
      .subscribe(({ call: summary, capturedByCycleIds }) => {
        const id = this.cycleId();
        if (!id || !capturedByCycleIds.includes(id)) return;
        const call = toCallRecord(summary);
        // Matched by id, not callKey - see CallsStateService's identical change for why (two-phase
        // logging pushes the same call twice, once IN_PROGRESS then once resolved).
        this.liveCalls.set([call, ...this.liveCalls().filter((c) => c.id !== call.id)]);
        this.view.refresh();
      });
  }

  /** Always a real network call - never served from a cache, so a call's detail is refetched every time it's expanded, even if it was already loaded before (this session or otherwise). */
  getCallDetail(callId: string): Observable<CallDetail> {
    const cycleId = this.cycleId();
    return this.api.getDetail(cycleId, callId);
  }

  /** CallRemovalState - looks up the captured call's own backend id from the underlying CallRecord, since CallCardComponent only has the CallRecord, not the CapturedCall wrapper. */
  remove(call: CallRecord): void {
    const captured = this.capturedByKey.get(callKey(call));
    if (captured) {
      this.removeCall(captured.id, [callKey(call)]);
    }
  }

  /**
   * `keysToPrune` - see removeMany's doc: liveCalls is a "not yet confirmed by a refresh" buffer
   * that only ever grows or dedupes by key, never shrinks on its own, so a call removed here would
   * otherwise still satisfy the "not in the freshly-fetched page" check in call-list-view.ts's
   * matchingCalls and get spliced right back into the visible list - the exact bug this fixes
   * (backend delete succeeds, call reappears in the UI until the next unrelated liveCalls reset).
   */
  removeCall(callId: string, keysToPrune?: readonly string[]): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.removeCall(id, callId).subscribe(() => {
      if (keysToPrune?.length) {
        this.pruneLiveCalls(keysToPrune);
      }
      this.view.refresh();
    });
  }

  /** CallRemovalState - bulk counterpart to remove(), one request instead of one per call.
   * Clears the selection along with refreshing, since every id just removed would otherwise
   * stay "selected" against calls that no longer exist. */
  removeMany(calls: readonly CallRecord[]): void {
    const id = this.cycleId();
    if (!id) return;
    const callIds = calls
      .map((call) => this.capturedByKey.get(callKey(call))?.id)
      .filter((callId): callId is string => callId !== undefined);
    if (callIds.length === 0) return;

    this.api.removeCalls(id, callIds).subscribe(() => {
      this.clearSelection();
      this.pruneLiveCalls(calls.map(callKey));
      this.view.refresh();
    });
  }

  /** Drops the given keys out of the live-push buffer - see removeCall's doc for why this is necessary on every removal path, not just relying on view.refresh() alone. */
  private pruneLiveCalls(keys: readonly string[]): void {
    const keySet = new Set(keys);
    this.liveCalls.set(this.liveCalls().filter((c) => !keySet.has(callKey(c))));
  }

  refreshNow(): void {
    this.view.refresh();
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

  // ---- CallSelectionState ----

  isSelected(call: CallRecord): boolean {
    return this.selectedIds().has(callKey(call));
  }

  toggleSelected(call: CallRecord): void {
    this.setSelected(call, !this.isSelected(call));
  }

  private setSelected(call: CallRecord, selected: boolean): void {
    const key = callKey(call);
    const next = new Set(this.selectedIds());
    if (selected) {
      next.add(key);
    } else {
      next.delete(key);
    }
    this.selectedIds.set(next);
  }

  startDragSelect(call: CallRecord): void {
    this.dragSelectValue = !this.isSelected(call);
    this.setSelected(call, this.dragSelectValue);
  }

  dragSelectOver(call: CallRecord): void {
    if (this.dragSelectValue === null) return;
    this.setSelected(call, this.dragSelectValue);
  }

  endDragSelect(): void {
    this.dragSelectValue = null;
  }

  // ---- BulkSelectionState ----

  /**
   * In the exact order the list is actually rendered on screen - matches
   * CallsStateService.selectedCalls (dashboard). Pinned calls first, then either the
   * grouped-by-supplier view or the flat sorted list (which already applies customOrder itself
   * when sortMode is 'custom' - see mainListCalls in call-list-view.ts), whichever
   * CallListComponent is currently showing. Scoped to what's currently loaded - see
   * call-list-view.ts's doc comment.
   */
  selectedCalls(): readonly CallRecord[] {
    const ids = this.selectedIds();
    if (ids.size === 0) return [];
    const displayOrder = this.view.groupBySupplier() ? this.view.groupedCalls().flatMap((g) => g.calls) : this.view.mainListCalls();
    return [...this.pinService.pinned().values(), ...displayOrder].filter((call) => ids.has(callKey(call)));
  }

  selectAll(): void {
    this.selectedIds.set(new Set(this.view.matchingCalls().map(callKey)));
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }
}
