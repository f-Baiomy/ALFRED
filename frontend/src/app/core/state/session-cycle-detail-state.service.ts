import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Subject, merge, of, timer } from 'rxjs';
import { catchError, map, retry, switchMap, tap } from 'rxjs/operators';
import { webSocket } from 'rxjs/webSocket';
import { CallEvent, CallRecord, CapturedCall, SortMode } from '../models/call.model';
import { AppConfigService } from '../services/app-config.service';
import { PinService } from '../services/pin.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { BulkSelectionState, CallListControlsState, CallRemovalState, CallSelectionState } from './call-selection.tokens';
import { CallListView, createCallListView } from './call-list-view';
import { callKey, mergeLiveCapturedCalls, unconfirmedLiveCapturedCalls } from '../../shared/utils/call-utils';

const POLL_INTERVAL_MS = 5000;

/**
 * Per-open-cycle state for the session-cycle detail page - component-provided (see
 * SessionCycleDetailComponent), NOT root, so navigating between two different cycles gets a fresh
 * instance instead of leaking selection/live state from the previous one. Mirrors
 * CallsStateService's poll+live-merge+selection+search/sort/group/stats shape (via the same
 * createCallListView factory), scoped to one cycle's captured calls.
 */
@Injectable()
export class SessionCycleDetailStateService implements CallSelectionState, BulkSelectionState, CallListControlsState, CallRemovalState {
  private readonly api = inject(SessionCyclesApiService);
  private readonly config = inject(AppConfigService);
  private readonly route = inject(ActivatedRoute);
  private readonly pinService = inject(PinService);

  readonly cycleId = toSignal(this.route.paramMap.pipe(map((params) => params.get('id') ?? '')), { initialValue: '' });

  readonly error = signal<string | null>(null);

  private readonly manualRefresh = new Subject<void>();

  private readonly view: CallListView;

  private readonly polled$ = merge(timer(0, POLL_INTERVAL_MS), this.manualRefresh).pipe(
    switchMap(() => {
      const id = this.cycleId();
      if (!id) return of<CapturedCall[]>([]);
      return this.api.listCalls(id).pipe(
        tap(() => this.error.set(null)),
        catchError((err: unknown) => {
          this.error.set(err instanceof Error ? err.message : String(err));
          return of<CapturedCall[]>([]);
        })
      );
    })
  );

  private readonly polledCalls = toSignal(this.polled$, { initialValue: [] as CapturedCall[] });

  /** Captured calls pushed live over WebSocket that the next poll hasn't confirmed (with their real backend id) yet. */
  private readonly liveCalls = signal<readonly CapturedCall[]>([]);

  readonly capturedCalls = computed(() => mergeLiveCapturedCalls(this.liveCalls(), this.polledCalls()));

  /** Just the underlying CallRecords, in the same newest-first order - what CallListControlsState/CallListView operate on. */
  readonly calls = computed(() => this.capturedCalls().map((c) => c.call));

  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  private dragSelectValue: boolean | null = null;

  constructor() {
    this.view = createCallListView(this.calls, computed(() => new Set(this.pinService.pinned().keys())), {
      defaultSortMode: 'oldest-call',
    });

    effect(
      () => {
        const pruned = unconfirmedLiveCapturedCalls(this.liveCalls(), this.polledCalls());
        if (pruned.length !== this.liveCalls().length) {
          this.liveCalls.set(pruned);
        }
      },
      { allowSignalWrites: true }
    );

    this.connectLiveUpdates();
  }

  private connectLiveUpdates(): void {
    const wsUrl = this.config.backendUrl.replace(/^http/, 'ws') + '/ws/calls';
    webSocket<CallEvent>(wsUrl)
      .pipe(retry({ delay: () => timer(3000) }))
      .subscribe(({ call, capturedByCycleIds }) => {
        const id = this.cycleId();
        if (!id || !capturedByCycleIds.includes(id)) return;
        const key = callKey(call);
        const placeholder: CapturedCall = { id: key, capturedAt: call.timestamp, call };
        this.liveCalls.set([placeholder, ...this.liveCalls().filter((c) => callKey(c.call) !== key)]);
      });
  }

  /** CallRemovalState - looks up the captured call's own backend id from the underlying CallRecord, since CallCardComponent only has the CallRecord, not the CapturedCall wrapper. */
  remove(call: CallRecord): void {
    const key = callKey(call);
    const captured = this.capturedCalls().find((c) => callKey(c.call) === key);
    if (captured) {
      this.removeCall(captured.id);
    }
  }

  removeCall(callId: string): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.removeCall(id, callId).subscribe(() => this.refreshNow());
  }

  refreshNow(): void {
    this.manualRefresh.next();
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

  selectedCalls(): readonly CallRecord[] {
    const ids = this.selectedIds();
    if (ids.size === 0) return [];
    return this.calls().filter((call) => ids.has(callKey(call)));
  }

  selectAll(): void {
    this.selectedIds.set(new Set(this.view.matchingCalls().map(callKey)));
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }
}
