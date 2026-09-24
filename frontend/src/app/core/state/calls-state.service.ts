import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, Subscription, forkJoin, map, of } from 'rxjs';
import {
  CallDetail,
  CallDetailPart,
  CallEndpointSource,
  CallOverlapCandidate,
  CallRecord,
  CallSummaryDto,
  CallsWsMessage,
  InternalCallsWsMessage,
  SortMode,
  SourceKey,
} from '../models/call.model';
import { CallsApiService } from '../services/calls-api.service';
import { PinService } from '../services/pin.service';
import { WsMessagesEventsService } from '../services/ws-messages-events.service';
import { AppConfigService } from '../services/app-config.service';
import { InternalCallServiceDto, InternalLoggingApiService } from '../services/internal-logging-api.service';
import { CallViewMode } from '../../shared/utils/call-tree';
import { callKey, EXTERNAL_SOURCE_KEY, sortCalls, sourceKeyOf, subtreeSelectionOf, toCallRecord } from '../../shared/utils/call-utils';
import { CallListControlsState, BulkSelectionState, CallSelectionState } from './call-selection.tokens';
import { CallListView, CallOverlapQuery, CallStatusFilter, CallsPageResult, CallsQuery, createCallListView } from './call-list-view';
import { reconnectingSocket } from './reconnecting-socket';

export type { CallStats, CallStatusFilter, SupplierGroup, SupplierOption } from './call-list-view';

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
  private readonly wsMessagesEvents = inject(WsMessagesEventsService);
  private readonly config = inject(AppConfigService);
  private readonly internalLoggingApi = inject(InternalLoggingApiService);

  readonly error = signal<string | null>(null);

  /** Calls picked for bulk export, keyed by callKey() - not tied to sort/filter/pagination, so a selection survives those changing underneath it. */
  readonly selectedIds = signal<ReadonlySet<string>>(new Set());

  private readonly view: CallListView;

  /** Calls pushed live over WebSocket that the next refresh() hasn't confirmed yet. */
  private readonly liveCalls = signal<readonly CallRecord[]>([]);

  readonly pinned = this.pinService.pinned;

  /**
   * Every project reverse-proxy fronts (plus the reserved "unknown" bucket) - fetched once up
   * front alongside the deploy-time feature flag, same pattern as the Settings page. Empty until
   * that resolves, and stays empty forever on a deployment where inbound logging isn't enabled at
   * all - the Sources bar only ever renders a pill per entry here, so it naturally has nothing
   * beyond "External" to show in that case.
   */
  readonly internalServices = signal<readonly InternalCallServiceDto[]>([]);
  readonly inboundLoggingFeatureEnabled = signal(false);

  /**
   * Which source(s) the dashboard is currently reading from - a set of SourceKeys, either the
   * reserved 'external' or a named internal project (including its "unknown" bucket). Starts as
   * just {'external'} and is widened to "every source" the moment internalServices resolves (see
   * the constructor) - not part of CallListControlsState/CallListView (the shared interface
   * session-cycle detail pages also implement) since source-switching is a per-page concept; the
   * Sources bar component takes it as a plain input/output instead.
   */
  readonly selectedSources = signal<ReadonlySet<SourceKey>>(new Set([EXTERNAL_SOURCE_KEY]));

  /**
   * How far into EACH backend the merged (external + internal) list has read. Reset whenever a
   * fetch starts from offset 0 - a replace, a filter change, resetSource - and otherwise advanced
   * by however many calls each source actually returned. See fetchPageForSource for why a single
   * shared offset cannot work here.
   */
  private mergedCursor = { external: 0, internal: 0 };

  /** Live WebSocket subscriptions for the currently-selected source(s) - torn down and rebuilt whenever selectedSources changes, one socket per distinct backend store actually needed (never more than two: /ws/calls for 'external', /ws/internal-calls for any internal name). */
  private wsSubscriptions: Subscription[] = [];

  constructor() {
    this.view = createCallListView(
      computed(() => new Set(this.pinned().keys())),
      {
        pageSize: 200,
        fetchPage: (query) => this.fetchPageForSource(query),
        fetchOverlaps: (query) => this.fetchOverlapsForSource(query),
        liveCalls: this.liveCalls,
        onError: (message) => this.error.set(message),
      }
    );

    this.internalLoggingApi.getFeatureEnabled().subscribe((res) => {
      this.inboundLoggingFeatureEnabled.set(res.enabled);
      if (!res.enabled) return;
      this.internalLoggingApi.getServices().subscribe((services) => {
        this.internalServices.set(services);
        // "All sources" is the default the moment there's something to show beyond External -
        // matches the Sources bar's own "everything checked" starting state.
        this.selectedSources.set(new Set([EXTERNAL_SOURCE_KEY, ...services.map((s) => s.name)]));
        this.connectLiveUpdates();
        this.view.resetSource();
      });
    });

    this.connectLiveUpdates();
  }

  /**
   * Fetches one page for whatever source(s) are currently selected. External-only or
   * internal-only (any number of named projects) is a straight passthrough to the matching REST
   * resource, with the selected internal names sent as a server-side filter. Selecting both kinds
   * fetches from each of the two independent, independently-paginated backends in parallel and
   * merges the two pages, re-sorted with sortCalls (shared with the session-cycle "custom order"
   * view). `total` is the sum of both sources' totals.
   *
   * Each source keeps its OWN offset ({@link mergedCursor}), advanced by how many calls that source
   * actually returned. The caller's `query.offset` is only read as "is this a fresh start" - it
   * counts calls already loaded across BOTH sources, which is meaningless to either backend on its
   * own. Sharing it was a real bug: with 178 external and 200 internal calls, page one merged 378
   * and trimmed to the 200-call limit, then page two asked BOTH backends for offset 200 - where
   * external has nothing left and internal has nothing left - so the 178 calls trimmed out of page
   * one were permanently unreachable, the list stopped at 140 visible rows, and every further
   * "load more" fetched an empty page forever.
   *
   * Nothing is trimmed now, so a merged page can be up to twice `limit`. That is the point: a call
   * dropped from a page can never be asked for again, because the only handle on it is an offset
   * into a source that has already moved past it. Cross-page ordering stays approximate (page two's
   * calls all sort after page one's, even if one source ran out early) - but approximate order is a
   * far smaller problem than missing calls. Selecting nothing at all fetches nothing.
   *
   * 'newest'/'oldest' are substituted with 'newest-call'/'oldest-call' for the merge only: those
   * two modes normally rely on "whatever order this one backend already returned it in" (its own
   * received/capture order - see sortCalls' comment), which has no defined meaning once two
   * independent backends' pages are interleaved, so call.timestamp is the only sensible order left
   * to merge by. Every other mode (slowest/fastest/status/*-call) already sorts by an actual field
   * on the record, so it merges correctly unchanged.
   */
  private fetchPageForSource(query: CallsQuery): Observable<CallsPageResult> {
    const selected = this.selectedSources();
    const wantExternal = selected.has(EXTERNAL_SOURCE_KEY);
    const internalNames = [...selected].filter((s) => s !== EXTERNAL_SOURCE_KEY);
    const wantInternal = internalNames.length > 0;

    if (wantExternal && !wantInternal) return this.api.getCalls(query, 'external');
    if (wantInternal && !wantExternal) return this.api.getCalls(query, 'internal', internalNames);
    if (!wantExternal && !wantInternal) return of({ calls: [], total: 0 });

    const mergeSort: SortMode = query.sort === 'newest' ? 'newest-call' : query.sort === 'oldest' ? 'oldest-call' : query.sort;
    if (query.offset === 0) this.mergedCursor = { external: 0, internal: 0 };
    const cursor = this.mergedCursor;

    return forkJoin([
      this.api.getCalls({ ...query, offset: cursor.external }, 'external'),
      this.api.getCalls({ ...query, offset: cursor.internal }, 'internal', internalNames),
    ]).pipe(
      map(([external, internal]) => {
        this.mergedCursor = {
          external: cursor.external + external.calls.length,
          internal: cursor.internal + internal.calls.length,
        };
        return {
          calls: sortCalls([...external.calls, ...internal.calls], mergeSort),
          total: external.total + internal.total,
        };
      })
    );
  }

  /**
   * Fetches every overlap candidate in `query`'s range - unlike fetchPageForSource, GET
   * /call-overlaps always returns BOTH external and internal candidates together in one request
   * (never two to merge), narrowed server-side to the currently-selected internal projects via
   * `serviceNames` exactly like getCalls' own narrowing. The Sources bar's external on/off toggle
   * has no server-side equivalent on this endpoint (there's no "external" flag to pass, only which
   * internal projects), so it's applied here instead: a candidate whose own source/service isn't
   * in the current selection is dropped client-side before the containment check ever sees it -
   * the same rule matchesActiveFilters applies to a live-pushed CallRecord, just applied to a
   * CallOverlapCandidate's leaner shape instead.
   */
  private fetchOverlapsForSource(query: CallOverlapQuery): Observable<CallOverlapCandidate[]> {
    const selected = this.selectedSources();
    const internalNames = [...selected].filter((s) => s !== EXTERNAL_SOURCE_KEY);
    return this.api.getCallOverlaps(query, internalNames).pipe(
      map((candidates) =>
        candidates.filter((c) => (c.source === 'external' ? selected.has(EXTERNAL_SOURCE_KEY) : selected.has(c.serviceName ?? 'unknown')))
      )
    );
  }

  /** Flips one source's membership in the selection - clears whatever's loaded/live (some of it may no longer belong) and rebuilds both the REST fetch and the live WebSocket connection(s) to match. */
  toggleSource(key: SourceKey): void {
    const next = new Set(this.selectedSources());
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    this.selectedSources.set(next);
    this.liveCalls.set([]);
    this.connectLiveUpdates();
    this.view.resetSource();
  }

  /** Flips one project's live logging switch - the exact same endpoint the Settings page's "Inbound logging" panel uses, just reachable from the Sources bar too. Forwarding is never affected either way, only whether that project's calls get recorded from now on. */
  toggleServiceLogging(name: string, enabled: boolean): void {
    this.internalLoggingApi.setEnabled(name, enabled).subscribe((services) => this.internalServices.set(services));
  }

  /**
   * Pushes a new CallRecord onto the dashboard the instant the proxy's webhook (external) or the
   * reverse-mode mitmproxy (internal) reaches backend, and immediately triggers a refresh() to
   * fetch the authoritative (filtered/sorted/paginated) page - there's no 5s poll to eventually
   * pick it up otherwise. Reconnects on its own however the connection ended, and re-fetches once
   * it's back so nothing logged during the gap is left invisible - see reconnectingSocket. Tears
   * down any previous connection(s) first, since this is also called whenever selectedSources
   * changes.
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

  private subscribeToWs<T extends CallsWsMessage | InternalCallsWsMessage>(wsUrl: string, source: CallEndpointSource): Subscription {
    // Re-fetch on every reconnect, not just on every push: a call logged while the socket was away
    // is never pushed to this client at all, so without this it stays invisible until the NEXT
    // call happens to arrive - which on a quiet supplier can be a very long time.
    return reconnectingSocket<T>(wsUrl, () => this.view.refresh()).subscribe((message) =>
      this.handleWsMessage(message, source)
    );
  }

  private handleWsMessage(message: CallsWsMessage | InternalCallsWsMessage, source: CallEndpointSource): void {
    if ('type' in message && message.type === 'ws-messages-appended') {
      this.wsMessagesEvents.notifyAppended(message.callId);
      return;
    }
    if (!('call' in message)) {
      this.liveCalls.set([]);
      this.view.refresh();
      return;
    }
    const call = toCallRecord(message.call, source);
    // The /ws/internal-calls socket pushes every internal project's calls regardless of which
    // ones are actually selected (the backend doesn't filter its broadcasts) - drop one that
    // doesn't match the current selection here, or it would show up ahead of the (correctly
    // filtered) loaded window just because it hasn't been confirmed by a fetch yet.
    if (source === 'internal' && !this.selectedSources().has(sourceKeyOf(call))) return;
    // Matched by id, not callKey - two-phase logging pushes the same call twice (once
    // IN_PROGRESS at prepare, once resolved at complete), and id is the one thing guaranteed
    // stable across both pushes for the exact same call.
    this.liveCalls.set([call, ...this.liveCalls().filter((c) => c.id !== call.id)]);
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

  refreshNow(): void {
    this.view.refresh();
  }

  /**
   * Always a real network call - never served from a cache, so a call's detail is refetched every
   * time it's expanded, even if it was already loaded before (this session or otherwise). `source`
   * (stamped by toCallRecord() onto whichever call this id belongs to) picks GET /calls/{id}/detail
   * vs GET /internal-calls/{id}/detail - required once the list can hold calls from either store
   * (source omitted/undefined falls back to 'external', matching every pre-existing call site).
   */
  getCallDetail(callId: string, source?: CallEndpointSource, part?: CallDetailPart): Observable<CallDetail> {
    return this.api.getDetail(callId, source, part);
  }

  /**
   * CallListControlsState's on-demand overlap fetch, for the export dialog's prefetch step - reuses
   * fetchOverlapsForSource (same serviceNames/external-toggle narrowing the live view's own
   * `overlapCandidates` uses) but for a caller-supplied range, under whatever search/supplier/
   * session/operation/request filters are active on the view right now.
   */
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
  /** Whether the in-progress drag paints whole subtrees - see CallSelectionState.startDragSelect. */
  private dragSelectSubtree = false;

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

  /** Call on mousedown on a card: flips that card and remembers the resulting state so a subsequent drag paints the same state onto every card the pointer passes over. */
  startDragSelect(call: CallRecord, subtree = false): void {
    this.dragSelectSubtree = subtree;
    // In a tree view the drag's direction comes from the whole subtree, not the parent alone - a
    // parent that's selected while some child isn't reads as half-filled, and pressing on it should
    // fill it rather than clear it, exactly as clicking its checkbox does.
    this.dragSelectValue = subtree ? this.subtreeSelection(call) !== 'all' : !this.isSelected(call);
    this.paintDragSelect(call);
  }

  /** Call on mouseenter while a drag-select is active. */
  dragSelectOver(call: CallRecord): void {
    if (this.dragSelectValue === null) return;
    this.paintDragSelect(call);
  }

  private paintDragSelect(call: CallRecord): void {
    if (this.dragSelectSubtree) this.setSubtreeSelected(call, this.dragSelectValue!);
    else this.setSelected(call, this.dragSelectValue!);
  }

  /** Call on mouseup/dragend anywhere, to end the drag regardless of where the pointer was released. */
  endDragSelect(): void {
    this.dragSelectValue = null;
    this.dragSelectSubtree = false;
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /** Selects every call currently loaded and matching the search/supplier filter - not every call that would ever match, since only the loaded window is known client-side (see call-list-view.ts). */
  selectAll(): void {
    this.selectedIds.set(new Set(this.view.matchingCalls().map(callKey)));
  }

}
