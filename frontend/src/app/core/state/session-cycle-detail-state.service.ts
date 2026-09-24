import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { Observable, Subscription, forkJoin, map, of, tap } from 'rxjs';
import {
  CallDetail,
  CallDetailPart,
  CallEndpointSource,
  CallOverlapCandidate,
  CallRecord,
  CallSummaryDto,
  CallsWsMessage,
  CapturedCall,
  InternalCallsWsMessage,
  SortMode,
  SourceKey,
} from '../models/call.model';
import { AppConfigService } from '../services/app-config.service';
import { PinService } from '../services/pin.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { InternalCallServiceDto, InternalLoggingApiService } from '../services/internal-logging-api.service';
import { BulkSelectionState, CallListControlsState, CallReorderState, CallRemovalState, CallSelectionState, CycleSpacer } from './call-selection.tokens';
import { CallListView, CallOverlapQuery, CallStatusFilter, CallsPageResult, CallsQuery, createCallListView } from './call-list-view';
import { reconnectingSocket } from './reconnecting-socket';
import { CallViewMode } from '../../shared/utils/call-tree';
import { callKey, EXTERNAL_SOURCE_KEY, sortCalls, sourceKeyOf, subtreeSelectionOf, toCallRecord } from '../../shared/utils/call-utils';

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
  private readonly internalLoggingApi = inject(InternalLoggingApiService);

  readonly cycleId = toSignal(this.route.paramMap.pipe(map((params) => params.get('id') ?? '')), { initialValue: '' });

  readonly error = signal<string | null>(null);

  private readonly view: CallListView;

  /** The real CapturedCall (with its backend id) behind every CallRecord seen so far this cycle - since a live WebSocket push only carries the bare CallRecord, and removal needs the wrapper's id. Never shrinks except on cycleId change; a page reload of the same window just overwrites entries. */
  private readonly capturedByKey = new Map<string, CapturedCall>();

  /** Captured calls pushed live over WebSocket that the next refresh() hasn't confirmed (with their real backend id) yet. */
  private readonly liveCalls = signal<readonly CallRecord[]>([]);

  /** Mirrors CallsStateService.internalServices/inboundLoggingFeatureEnabled exactly - see its doc. */
  readonly internalServices = signal<readonly InternalCallServiceDto[]>([]);
  readonly inboundLoggingFeatureEnabled = signal(false);

  /** Mirrors CallsStateService.selectedSources - see its doc. */
  readonly selectedSources = signal<ReadonlySet<SourceKey>>(new Set([EXTERNAL_SOURCE_KEY]));

  /** Live WebSocket subscriptions for the currently-selected source(s) - torn down and rebuilt whenever selectedSources changes. */
  private wsSubscriptions: Subscription[] = [];

  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  private dragSelectValue: boolean | null = null;
  private dragSelectSubtree = false;

  /** Manually drag-and-drop arranged order (callKeys), persisted to localStorage per cycle so it
   * survives a reload - see CALL_REORDER_STATE. Only ever populated on this page; the dashboard
   * has no equivalent. */
  readonly customOrder = signal<readonly string[]>([]);

  readonly dragEnabled = computed(() => !this.groupBySupplier());

  /** Every spacer for the currently-open cycle - see CallReorderState. Reloaded whenever the open cycle changes. */
  readonly spacers = signal<readonly CycleSpacer[]>([]);

  /**
   * Whether selectedSources is final - i.e. the inbound-logging feature flag (and, if on, the
   * service list) has come back, or failed. Page one is only fetched once this is true: before, it
   * was fetched on creation, again by the cycle effect, and again once the services resolved - three
   * loads of the same list every time a cycle was opened.
   */
  private readonly sourcesKnown = signal(false);

  constructor() {
    this.view = createCallListView(computed(() => new Set(this.pinService.pinned().keys())), {
      pageSize: 200,
      defaultSortMode: 'oldest-call',
      fetchOnCreate: false,
      customOrder: this.customOrder,
      liveCalls: this.liveCalls,
      onError: (message) => this.error.set(message),
      fetchPage: (query) => this.fetchPageForSource(query),
      fetchOverlaps: (query) => this.fetchOverlapsForSource(query),
    });

    // A different cycle is an entirely different data source, not just a query change - clears
    // everything loaded so far (including the id lookup) and refetches page one, rather than
    // e.g. appending cycle B's calls onto cycle A's leftover window.
    effect(
      () => {
        const id = this.cycleId();
        this.capturedByKey.clear();
        this.liveCalls.set([]);
        this.spacers.set([]);
        if (id) {
          this.api.listSpacers(id).subscribe((spacers) => this.spacers.set(spacers));
        }
      },
      { allowSignalWrites: true }
    );

    // The one page-one fetch per open cycle - see sourcesKnown.
    effect(
      () => {
        if (this.cycleId() && this.sourcesKnown()) {
          untracked(() => this.view.resetSource());
        }
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

    this.internalLoggingApi.getFeatureEnabled().subscribe({
      next: (res) => {
        this.inboundLoggingFeatureEnabled.set(res.enabled);
        if (!res.enabled) {
          this.sourcesKnown.set(true);
          return;
        }
        this.internalLoggingApi.getServices().subscribe({
          next: (services) => {
            this.internalServices.set(services);
            this.selectedSources.set(new Set([EXTERNAL_SOURCE_KEY, ...services.map((s) => s.name)]));
            this.connectLiveUpdates();
            this.sourcesKnown.set(true);
          },
          // Still show the external calls rather than an empty page forever.
          error: () => this.sourcesKnown.set(true),
        });
      },
      error: () => this.sourcesKnown.set(true),
    });

    this.connectLiveUpdates();
  }

  /**
   * Fetches one page of this cycle's captured calls for whatever source(s) are currently
   * selected - mirrors CallsStateService.fetchPageForSource, adapted to this service's
   * CapturedCall wrapper (the shared createCallListView only ever sees bare CallRecords, so the
   * wrapper is peeled off here, with every returned CapturedCall - from either source - recorded
   * into capturedByKey along the way, exactly like the single-source code this replaced did).
   *
   * Selecting both external and internal sources fetches the same offset/limit from each of the
   * two independently-paginated backends in parallel and merges them. sortCalls only operates on
   * bare CallRecord[], so the merge sorts the unwrapped `.call` side and maps back to the matching
   * CapturedCall via callKey (sortCalls reorders in place rather than cloning, but a lookup by
   * content-key is simpler than relying on that implementation detail). See CallsStateService's
   * identical doc comment for why 'newest'/'oldest' are substituted with 'newest-call'/
   * 'oldest-call' for the merge only, and why the merged page is trimmed to `query.limit` with
   * `total` as the sum of both sources' totals.
   */
  private fetchPageForSource(query: CallsQuery): Observable<CallsPageResult> {
    const id = this.cycleId();
    const selected = this.selectedSources();
    const wantExternal = selected.has(EXTERNAL_SOURCE_KEY);
    const internalNames = [...selected].filter((s) => s !== EXTERNAL_SOURCE_KEY);
    const wantInternal = internalNames.length > 0;

    const recordAndUnwrap = (page: { calls: readonly CapturedCall[]; total: number }): CallsPageResult => {
      for (const c of page.calls) {
        this.capturedByKey.set(callKey(c.call), c);
      }
      return { calls: page.calls.map((c) => c.call), total: page.total };
    };

    if (wantExternal && !wantInternal) return this.api.listCalls(id, query, 'external').pipe(map(recordAndUnwrap));
    if (wantInternal && !wantExternal) return this.api.listCalls(id, query, 'internal', internalNames).pipe(map(recordAndUnwrap));
    if (!wantExternal && !wantInternal) return of({ calls: [], total: 0 });

    const mergeSort: SortMode = query.sort === 'newest' ? 'newest-call' : query.sort === 'oldest' ? 'oldest-call' : query.sort;
    return forkJoin([this.api.listCalls(id, query, 'external'), this.api.listCalls(id, query, 'internal', internalNames)]).pipe(
      map(([external, internal]) => {
        const allCaptured = [...external.calls, ...internal.calls];
        for (const c of allCaptured) {
          this.capturedByKey.set(callKey(c.call), c);
        }
        const byKey = new Map(allCaptured.map((c) => [callKey(c.call), c]));
        const sortedCalls = sortCalls(allCaptured.map((c) => c.call), mergeSort);
        // Unlike the dashboard's identical-looking merge, this can't just take slice(0, limit):
        // session-cycles disables server-side pagination (alfred.session-cycles.pagination-
        // enabled=false), so BOTH sources always return their *complete* sorted list regardless
        // of the requested offset - every "page" would otherwise re-slice from the very start and
        // "Load more" would just re-show page one forever (confirmed live). Since each source's
        // result here is already the full set, slicing by the requested offset/limit ourselves
        // produces an exact (not approximate) globally-sorted page - a nicer guarantee than the
        // dashboard can make, precisely because pagination is off for this feature.
        const merged = sortedCalls.slice(query.offset, query.offset + query.limit).map((call) => byKey.get(callKey(call))!.call);
        return { calls: merged, total: external.total + internal.total };
      })
    );
  }

  /** Mirrors CallsStateService.fetchOverlapsForSource, scoped to this cycle - see its doc. */
  private fetchOverlapsForSource(query: CallOverlapQuery): Observable<CallOverlapCandidate[]> {
    const id = this.cycleId();
    const selected = this.selectedSources();
    const internalNames = [...selected].filter((s) => s !== EXTERNAL_SOURCE_KEY);
    return this.api.getCallOverlaps(id, query, internalNames).pipe(
      map((candidates) =>
        candidates.filter((c) => (c.source === 'external' ? selected.has(EXTERNAL_SOURCE_KEY) : selected.has(c.serviceName ?? 'unknown')))
      )
    );
  }

  /** Flips one source's membership in the selection - clears whatever's loaded/live/looked-up (some of it may no longer belong) and rebuilds both the REST fetch and the live WebSocket connection(s) to match. Mirrors CallsStateService.toggleSource. */
  toggleSource(key: SourceKey): void {
    const next = new Set(this.selectedSources());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.selectedSources.set(next);
    this.capturedByKey.clear();
    this.liveCalls.set([]);
    this.connectLiveUpdates();
    this.view.resetSource();
  }

  /** Mirrors CallsStateService.toggleServiceLogging - see its doc. */
  toggleServiceLogging(name: string, enabled: boolean): void {
    this.internalLoggingApi.setEnabled(name, enabled).subscribe((services) => this.internalServices.set(services));
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

  addSpacer(label: string, afterCallId: string | null, anchorTimestamp: string | null): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.createSpacer(id, label, afterCallId, anchorTimestamp).subscribe((spacer) => this.spacers.set([...this.spacers(), spacer]));
  }

  renameSpacer(spacerId: string, label: string): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.renameSpacer(id, spacerId, label).subscribe((updated) => this.replaceSpacer(updated));
  }

  moveSpacer(spacerId: string, afterCallId: string | null, anchorTimestamp: string | null): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.moveSpacer(id, spacerId, afterCallId, anchorTimestamp).subscribe((updated) => this.replaceSpacer(updated));
  }

  deleteSpacer(spacerId: string): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.deleteSpacer(id, spacerId).subscribe(() => this.spacers.set(this.spacers().filter((s) => s.id !== spacerId)));
  }

  private replaceSpacer(updated: CycleSpacer): void {
    this.spacers.set(this.spacers().map((s) => (s.id === updated.id ? updated : s)));
  }

  /**
   * Pushes a captured call onto the page the instant it's recorded, and immediately triggers a
   * refresh() for the authoritative page - there's no 5s poll to eventually pick it up otherwise.
   * Mirrors CallsStateService.connectLiveUpdates: one socket per distinct backend store actually
   * needed, torn down and reconnected whenever selectedSources changes (also called from
   * toggleSource).
   */
  private connectLiveUpdates(): void {
    this.wsSubscriptions.forEach((sub) => sub.unsubscribe());
    this.wsSubscriptions = [];

    const selected = this.selectedSources();
    const wsBase = this.config.backendUrl.replace(/^http/, 'ws');
    if (selected.has(EXTERNAL_SOURCE_KEY)) {
      this.wsSubscriptions.push(this.subscribeToWs<CallsWsMessage>(`${wsBase}/ws/calls`, 'external'));
    }
    if ([...selected].some((s) => s !== EXTERNAL_SOURCE_KEY)) {
      this.wsSubscriptions.push(this.subscribeToWs<InternalCallsWsMessage>(`${wsBase}/ws/internal-calls`, 'internal'));
    }
  }

  private subscribeToWs<T extends CallsWsMessage | InternalCallsWsMessage>(
    wsUrl: string,
    source: CallEndpointSource
  ): Subscription {
    // Re-fetch on reconnect for the same reason CallsStateService does - a call captured into this
    // cycle while the socket was away is never pushed to this client at all.
    return reconnectingSocket<T>(wsUrl, () => this.view.refresh()).subscribe((message) =>
      this.handleWsMessage(message, source)
    );
  }

  private handleWsMessage(message: CallsWsMessage | InternalCallsWsMessage, source: CallEndpointSource): void {
    if ('type' in message && message.type === 'ws-messages-appended') {
      // Cycles don't get a live WsMessagesComponent refresh from this event today - a captured
      // call's messages are viewed on manual open, not pushed - so there's nothing to do here.
      return;
    }
    if (!('call' in message)) {
      this.liveCalls.set([]);
      this.view.refresh();
      return;
    }
    const id = this.cycleId();
    if (!id || !message.capturedByCycleIds.includes(id)) return;
    const call = toCallRecord(message.call, source);
    // See CallsStateService's identical check for why - the /ws/internal-calls socket pushes
    // every internal project's captured calls regardless of which ones are actually selected.
    if (source === 'internal' && !this.selectedSources().has(sourceKeyOf(call))) return;
    // Matched by id, not callKey - see CallsStateService's identical change for why (two-phase
    // logging pushes the same call twice, once IN_PROGRESS then once resolved).
    this.liveCalls.set([call, ...this.liveCalls().filter((c) => c.id !== call.id)]);
    this.view.refresh();
    // No spacer refetch: spacers are anchored to the call above them, so a newly captured call just
    // lands below whatever spacer came before it - nothing about any spacer changes server-side.
  }

  /** Always a real network call - never served from a cache, so a call's detail is refetched every time it's expanded, even if it was already loaded before (this session or otherwise). `source` picks GET /session-cycles/{id}/calls/{callId}/detail vs the internal-calls equivalent - defaults to 'external' (via SessionCyclesApiService.getDetail) when omitted. */
  getCallDetail(callId: string, source?: CallEndpointSource, part?: CallDetailPart): Observable<CallDetail> {
    const cycleId = this.cycleId();
    return this.api.getDetail(cycleId, callId, source, part);
  }

  /** Mirrors CallsStateService.getCallOverlaps - see its doc. */
  getCallOverlaps(range: { from: string; to: string }): Observable<CallOverlapCandidate[]> {
    return this.fetchOverlapsForSource({
      from: range.from,
      to: range.to,
      search: this.view.searchQuery().trim(),
      supplier: this.view.supplierFilter(),
      sessionId: this.view.sessionIdFilter().trim(),
      operationId: this.view.operationIdFilter().trim(),
      requestId: this.view.requestIdFilter().trim(),
    });
  }

  /** CallRemovalState - looks up the captured call's own backend id from the underlying CallRecord, since CallCardComponent only has the CallRecord, not the CapturedCall wrapper. Threads the CallRecord's own stamped source through so removal hits the matching endpoint. */
  remove(call: CallRecord): void {
    const captured = this.capturedByKey.get(callKey(call));
    if (captured) {
      this.removeCall(captured.id, [callKey(call)], call.source);
    }
  }

  /**
   * `keysToPrune` - see removeMany's doc: liveCalls is a "not yet confirmed by a refresh" buffer
   * that only ever grows or dedupes by key, never shrinks on its own, so a call removed here would
   * otherwise still satisfy the "not in the freshly-fetched page" check in call-list-view.ts's
   * matchingCalls and get spliced right back into the visible list - the exact bug this fixes
   * (backend delete succeeds, call reappears in the UI until the next unrelated liveCalls reset).
   */
  removeCall(callId: string, keysToPrune?: readonly string[], source?: CallEndpointSource): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.removeCall(id, callId, source).subscribe(() => {
      if (keysToPrune?.length) {
        this.pruneLiveCalls(keysToPrune);
      }
      this.view.refresh();
      this.reloadSpacers();
    });
  }

  /** CallRemovalState - bulk counterpart to remove(), one request instead of one per call.
   * Clears the selection along with refreshing, since every id just removed would otherwise
   * stay "selected" against calls that no longer exist. Groups the selection by each call's own
   * stamped source first, since 'both' mode can select a mix of external- and internal-captured
   * calls in one go, and each needs its own bulk-remove request against its own endpoint. */
  removeMany(calls: readonly CallRecord[]): void {
    const id = this.cycleId();
    if (!id) return;

    const idsBySource = new Map<CallEndpointSource, string[]>();
    for (const call of calls) {
      const captured = this.capturedByKey.get(callKey(call));
      if (!captured) continue;
      const source: CallEndpointSource = call.source ?? 'external';
      const ids = idsBySource.get(source) ?? [];
      ids.push(captured.id);
      idsBySource.set(source, ids);
    }
    if (idsBySource.size === 0) return;

    const requests = [...idsBySource.entries()].map(([source, callIds]) => this.api.removeCalls(id, callIds, source));
    forkJoin(requests).subscribe(() => {
      this.clearSelection();
      this.pruneLiveCalls(calls.map(callKey));
      this.view.refresh();
      this.reloadSpacers();
    });
  }

  /**
   * Wipes every captured call (external and internal) for this cycle in one request - the "Clear
   * all calls" button's action, gated behind a confirm dialog in the component (see
   * settings.component.ts's clearAllCalls for the same confirm-then-request shape). Returns the
   * request itself (rather than subscribing internally like removeCall/removeMany) so the
   * component can drive its own button-disabled/loading state around it.
   */
  clearAllCalls(): Observable<void> {
    const id = this.cycleId();
    if (!id) return of(undefined);
    return this.api.clearCalls(id).pipe(
      tap(() => {
        this.clearSelection();
        this.liveCalls.set([]);
        this.view.resetSource();
        this.spacers.set([]);
      })
    );
  }

  /** Re-fetches this cycle's spacers from the backend - used after removing calls, since a spacer anchored to a removed call is repointed server-side (see CycleSpacersStorePort.dropAnchorsTo) and the local signal has no way to derive that on its own. */
  private reloadSpacers(): void {
    const id = this.cycleId();
    if (!id) return;
    this.api.listSpacers(id).subscribe((spacers) => {
      // Unchanged is the common case - skip the set so every view's merge doesn't recompute for nothing.
      if (JSON.stringify(spacers) !== JSON.stringify(this.spacers())) this.spacers.set(spacers);
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
  get sessionIdFilter() {
    return this.view.sessionIdFilter;
  }
  get operationIdFilter() {
    return this.view.operationIdFilter;
  }
  get requestIdFilter() {
    return this.view.requestIdFilter;
  }
  get statusFilter() {
    return this.view.statusFilter;
  }
  get groupBySupplier() {
    return this.view.groupBySupplier;
  }
  get showOptionsCalls() {
    return this.view.showOptionsCalls;
  }
  get nestedOnly() {
    return this.view.nestedOnly;
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
  get visibleRows() {
    return this.view.visibleRows;
  }
  get viewMode() {
    return this.view.viewMode;
  }
  get callTree() {
    return this.view.callTree;
  }
  get callDepths() {
    return this.view.callDepths;
  }
  get descendants() {
    return this.view.descendants;
  }
  get foldedIds() {
    return this.view.foldedIds;
  }
  get overlapCandidates() {
    return this.view.overlapCandidates;
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

  setSessionIdFilter(sessionId: string): void {
    this.view.setSessionIdFilter(sessionId);
  }

  setOperationIdFilter(operationId: string): void {
    this.view.setOperationIdFilter(operationId);
  }

  setRequestIdFilter(requestId: string): void {
    this.view.setRequestIdFilter(requestId);
  }

  setStatusFilter(filter: CallStatusFilter): void {
    this.view.setStatusFilter(filter);
  }

  toggleGroupBySupplier(): void {
    this.view.toggleGroupBySupplier();
  }

  toggleShowOptionsCalls(): void {
    this.view.toggleShowOptionsCalls();
  }

  setNestedOnly(value: boolean): void {
    this.view.setNestedOnly(value);
  }

  setViewMode(mode: CallViewMode): void {
    this.view.setViewMode(mode);
  }

  toggleExpanded(): void {
    this.view.toggleExpanded();
  }

  setFolded(callIds: readonly string[], folded: boolean): void {
    this.view.setFolded(callIds, folded);
  }

  foldAll(): void {
    this.view.foldAll();
  }

  unfoldAll(): void {
    this.view.unfoldAll();
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

  subtreeSelection(call: CallRecord): 'none' | 'some' | 'all' {
    return subtreeSelectionOf(call, this.view.descendants(), this.selectedIds());
  }

  setSubtreeSelected(call: CallRecord, selected: boolean): void {
    this.setManySelected([call, ...(this.view.descendants().get(call.id) ?? [])], selected);
  }

  private setSelected(call: CallRecord, selected: boolean): void {
    this.setManySelected([call], selected);
  }

  private setManySelected(calls: readonly CallRecord[], selected: boolean): void {
    const next = new Set(this.selectedIds());
    for (const call of calls) {
      if (selected) next.add(callKey(call));
      else next.delete(callKey(call));
    }
    this.selectedIds.set(next);
  }

  /** See CallsStateService's identical pair - `subtree` latches the tree views' whole-subtree
   * painting for the rest of the drag. */
  startDragSelect(call: CallRecord, subtree = false): void {
    this.dragSelectSubtree = subtree;
    this.dragSelectValue = subtree ? this.subtreeSelection(call) !== 'all' : !this.isSelected(call);
    this.paintDragSelect(call);
  }

  dragSelectOver(call: CallRecord): void {
    if (this.dragSelectValue === null) return;
    this.paintDragSelect(call);
  }

  private paintDragSelect(call: CallRecord): void {
    if (this.dragSelectSubtree) this.setSubtreeSelected(call, this.dragSelectValue!);
    else this.setSelected(call, this.dragSelectValue!);
  }

  endDragSelect(): void {
    this.dragSelectValue = null;
    this.dragSelectSubtree = false;
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
