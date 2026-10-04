import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Observable, Subject, Subscription, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { CallEndpointSource, CallRecord, CallsWsMessage, InternalCallsWsMessage, SessionCycle } from '../models/call.model';
import { AppConfigService } from '../services/app-config.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { InternalCallServiceDto, InternalLoggingApiService } from '../services/internal-logging-api.service';
import { SessionCyclesStateService } from './session-cycles-state.service';
import { CallsQuery, loadShowOptionsCalls, saveShowOptionsCalls } from './call-list-view';
import { CycleSpacer } from './call-selection.tokens';
import { reconnectingSocket } from './reconnecting-socket';
import { CallDepthInfo, CallTreeNode, buildCallTree, indexCallTree } from '../../shared/utils/call-tree';
import { SpacerAnchor } from '../../shared/utils/spacer-gap-controller';
import { EXTERNAL_SOURCE_KEY, isPreflight, toCallRecord } from '../../shared/utils/call-utils';

const SELECTED_CYCLE_KEY = 'alfred-cycle-widget-cycle';
const HIDDEN_SOURCES_KEY = 'alfred-cycle-widget-hidden-sources';
const CYCLE_SORT_KEY = 'alfred-cycle-widget-cycle-sort';
const CALL_ORDER_KEY = 'alfred-cycle-widget-call-order';

export type WidgetCycleSort = 'newest' | 'oldest' | 'recording' | 'name';
/** Only the two chronological orders: a nested tree only reads correctly in time order (see requiresChronologicalSort). */
export type WidgetCallOrder = 'oldest' | 'newest';

export const WIDGET_CYCLE_SORTS: readonly { readonly value: WidgetCycleSort; readonly label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'recording', label: 'Recording' },
  { value: 'name', label: 'Name' },
];

function sortCycles(cycles: readonly SessionCycle[], mode: WidgetCycleSort): SessionCycle[] {
  const newest = (a: SessionCycle, b: SessionCycle) => b.createdAt.localeCompare(a.createdAt);
  const arr = [...cycles];
  switch (mode) {
    case 'oldest':
      return arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case 'recording':
      return arr.sort((a, b) => Number(b.status === 'RECORDING') - Number(a.status === 'RECORDING') || newest(a, b));
    case 'name':
      return arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || newest(a, b));
    default:
      return arr.sort(newest);
  }
}

/** Session-cycles serve their whole captured list in one response (pagination is off for them - see
 * SessionCycleDetailStateService.fetchPageForSource), so this only has to be at least that cap. */
const FULL_LIST_QUERY: CallsQuery = {
  search: '',
  supplier: '',
  sort: 'oldest-call',
  offset: 0,
  limit: 5000,
  sessionId: '',
  operationId: '',
  requestId: '',
};

/** One entry in the widget's Sources panel: outbound (the forward proxy, always logging) or one inbound project. */
export interface WidgetSource {
  readonly key: string;
  readonly label: string;
  readonly direction: 'outbound' | 'inbound';
  /** null for outbound - the forward proxy has no per-source switch. */
  readonly loggingEnabled: boolean | null;
}

/**
 * A call that just arrived in the selected cycle, or an update to one - what the widget's toast
 * shows. `isNew` is false for the second push of two-phase logging (IN_PROGRESS, then resolved),
 * which only refreshes a toast already showing that call. `seq` changes on every push so an
 * identical call arriving twice still re-triggers the toast.
 */
export interface WidgetArrival {
  readonly call: CallRecord;
  readonly isNew: boolean;
  readonly seq: number;
}

/**
 * The widget's source key for a call. Deliberately NOT call-utils' sourceKeyOf: that returns
 * service_name for any call that has one, and an outbound call attributed to a calling project
 * carries that project's name too - which would file it under the project's INBOUND source here.
 */
export function widgetSourceKeyOf(call: CallRecord): string {
  return call.source === 'internal' ? (call.service_name ?? 'unknown') : EXTERNAL_SOURCE_KEY;
}

/**
 * State behind the floating session-cycle widget (see CycleWidgetComponent and
 * CycleWidgetWindowService). Root-provided but INERT until activate(): the widget is opt-in, so no
 * socket or fetch happens for a user who never opens it.
 *
 * Its own call list rather than a second SessionCycleDetailStateService: that one is route-bound
 * (reads the cycle id from ActivatedRoute) and carries pagination, selection, spacers and custom
 * order the widget has no use for. Fetch-on-demand like everything else - one full load on cycle
 * change or socket reconnect, then live calls are merged in from /ws/calls and /ws/internal-calls
 * by id. No polling.
 */
@Injectable({ providedIn: 'root' })
export class CycleWidgetStateService {
  private readonly cyclesState = inject(SessionCyclesStateService);
  private readonly api = inject(SessionCyclesApiService);
  private readonly loggingApi = inject(InternalLoggingApiService);
  private readonly config = inject(AppConfigService);

  /** The picker's order, which prev/next also walks - newest first unless the user picked another. */
  readonly cycleSort = signal<WidgetCycleSort>(readChoice(CYCLE_SORT_KEY, ['newest', 'oldest', 'recording', 'name'], 'newest'));
  readonly cycles = computed(() => sortCycles(this.cyclesState.cycles(), this.cycleSort()));

  /** Order of the waterfall's root calls; each call's own sub-calls always stay in time order. */
  readonly callOrder = signal<WidgetCallOrder>(readChoice(CALL_ORDER_KEY, ['oldest', 'newest'], 'oldest'));

  /** The selected cycle's spacers - the same ones its cycle page shows, placed by the same layoutSpacers. */
  readonly spacers = signal<readonly CycleSpacer[]>([]);

  private readonly selectedId = signal<string | null>(readStorage(SELECTED_CYCLE_KEY));

  /** The saved choice while it still exists, else whichever cycle is recording, else the newest. */
  readonly selectedCycle = computed<SessionCycle | null>(() => {
    const cycles = this.cycles();
    const id = this.selectedId();
    return cycles.find((c) => c.id === id) ?? cycles.find((c) => c.status === 'RECORDING') ?? cycles[0] ?? null;
  });

  readonly selectedIndex = computed(() => {
    const cycle = this.selectedCycle();
    return cycle ? this.cycles().findIndex((c) => c.id === cycle.id) : -1;
  });

  readonly calls = signal<readonly CallRecord[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly inboundFeatureEnabled = signal(false);
  readonly internalServices = signal<readonly InternalCallServiceDto[]>([]);

  /** Stored as the HIDDEN set so a project added to settings later shows up visible by default. */
  readonly hiddenSources = signal<ReadonlySet<string>>(new Set(readStorageArray(HIDDEN_SOURCES_KEY)));

  readonly sources = computed<readonly WidgetSource[]>(() => [
    { key: EXTERNAL_SOURCE_KEY, label: 'Outbound', direction: 'outbound', loggingEnabled: null },
    ...(this.inboundFeatureEnabled()
      ? this.internalServices().map((s): WidgetSource => ({ key: s.name, label: s.name, direction: 'inbound', loggingEnabled: s.enabled }))
      : []),
  ]);

  /** The same remembered "Show OPTIONS" as the call lists - off (the default) hides every CORS preflight. */
  readonly showOptionsCalls = signal(loadShowOptionsCalls());

  readonly visibleCalls = computed(() => {
    const hidden = this.hiddenSources();
    const showOptions = this.showOptionsCalls();
    return this.calls().filter((c) => !hidden.has(widgetSourceKeyOf(c)) && (showOptions || !isPreflight(c)));
  });

  /** Why calls are missing from the waterfall - what its empty message explains. */
  readonly hiddenCounts = computed(() => {
    const hidden = this.hiddenSources();
    const showOptions = this.showOptionsCalls();
    let bySource = 0;
    let preflights = 0;
    for (const c of this.calls()) {
      if (hidden.has(widgetSourceKeyOf(c))) bySource++;
      else if (!showOptions && isPreflight(c)) preflights++;
    }
    return { bySource, preflights };
  });

  /** In the chosen time order - buildCallTree keeps root order as given and sorts children by time itself. */
  private readonly chronological = computed(() => {
    const sign = this.callOrder() === 'newest' ? -1 : 1;
    return [...this.visibleCalls()].sort((a, b) => sign * (new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()));
  });

  /** Built over the VISIBLE calls only: a hidden call's children re-attach to the nearest visible
   * call that contains them, the same way the cycle page's own tree behaves under its Sources bar. */
  readonly tree = computed<readonly CallTreeNode[]>(() => buildCallTree(this.chronological()));
  readonly depths = computed<ReadonlyMap<string, CallDepthInfo>>(() => indexCallTree(this.chronological()));
  readonly maxDepth = computed(() => {
    let max = -1;
    for (const info of this.depths().values()) max = Math.max(max, info.depth);
    return max;
  });

  /**
   * Every call captured into the selected cycle, in order - a Subject, not a signal. A signal only
   * keeps its latest value and effects read it once per change detection, which Alfred coalesces
   * (eventCoalescing): calls arriving close together (a parallel fan-out, or one call's resolved push
   * next to another's first) overwrote each other before anything read them, so some never notified.
   */
  private readonly arrivalsSubject = new Subject<WidgetArrival>();
  readonly arrivals$ = this.arrivalsSubject.asObservable();
  private arrivalSeq = 0;
  /** Calls already announced (or already there when the cycle loaded) - see onWsMessage. */
  private readonly announced = new Set<string>();

  private active = false;
  private socketSubs: Subscription[] = [];
  private loadSub: Subscription | null = null;
  /** Which cycle `calls` currently belongs to - see load(). */
  private loadedFor: string | null = null;

  constructor() {
    effect(() => {
      const id = this.selectedCycle()?.id ?? null;
      untracked(() => {
        if (this.active) this.load(id);
      });
    });
  }

  /** Starts sockets and the first load. Idempotent - reopening the widget reuses what's running. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.cyclesState.refreshNow();
    this.loadServices();
    const wsBase = this.config.backendUrl.replace(/^http/, 'ws');
    this.socketSubs = [
      reconnectingSocket<CallsWsMessage>(`${wsBase}/ws/calls`, () => this.reload()).subscribe((m) => this.onWsMessage(m, 'external')),
      reconnectingSocket<InternalCallsWsMessage>(`${wsBase}/ws/internal-calls`, () => this.reload()).subscribe((m) =>
        this.onWsMessage(m, 'internal')
      ),
      // Calls cleared, removed, copied or imported into this cycle, or its spacers changed - on the
      // cycle's page, another window, or by another user.
      this.cyclesState.contentChanged$.subscribe((cycleId) => this.onCycleContentChanged(cycleId)),
    ];
    this.load(this.selectedCycle()?.id ?? null);
  }

  /** Stops sockets once the widget's last window closes. Keeps the loaded list so a reopen paints immediately. */
  deactivate(): void {
    this.active = false;
    this.socketSubs.forEach((s) => s.unsubscribe());
    this.socketSubs = [];
    this.loadSub?.unsubscribe();
    this.loadSub = null;
  }

  select(id: string): void {
    this.selectedId.set(id);
    writeStorage(SELECTED_CYCLE_KEY, id);
  }

  selectRelative(step: number): void {
    const cycles = this.cycles();
    if (cycles.length === 0) return;
    const index = Math.max(this.selectedIndex(), 0);
    this.select(cycles[(index + step + cycles.length) % cycles.length].id);
  }

  toggleRecording(): Observable<SessionCycle | null> {
    const cycle = this.selectedCycle();
    if (!cycle) return of(null);
    return cycle.status === 'RECORDING' ? this.cyclesState.pauseRecording(cycle.id) : this.cyclesState.startRecording(cycle.id);
  }

  /**
   * Creates a cycle, starts it recording and selects it - then pauses whatever else was recording,
   * so the widget's "one thing I'm recording right now" reading stays true. Pausing last means a
   * failed create leaves the running recording alone.
   */
  createAndRecord(name: string): Observable<SessionCycle> {
    const othersRecording = this.cycles()
      .filter((c) => c.status === 'RECORDING')
      .map((c) => c.id);
    return this.cyclesState.create({ name }).pipe(
      switchMap((created) => this.cyclesState.startRecording(created.id)),
      switchMap((started) => this.cyclesState.bulkPauseRecording(othersRecording).pipe(map(() => started))),
      map((started) => {
        this.select(started.id);
        return started;
      })
    );
  }

  setCycleSort(sort: WidgetCycleSort): void {
    this.cycleSort.set(sort);
    writeStorage(CYCLE_SORT_KEY, sort);
  }

  setCallOrder(order: WidgetCallOrder): void {
    this.callOrder.set(order);
    writeStorage(CALL_ORDER_KEY, order);
  }

  /**
   * Deletes every captured call (outbound and inbound) and spacer of the selected cycle - the same
   * "Clear all calls" the cycle's page has. The cycle itself, its name and its recording state stay.
   * Other views of the cycle reload from the cycle-content-changed signal.
   */
  clearCalls(): Observable<void> {
    const id = this.selectedCycle()?.id;
    if (!id) return of(undefined);
    return this.api.clearCalls(id).pipe(
      map(() => {
        if (this.selectedCycle()?.id === id) {
          this.calls.set([]);
          this.spacers.set([]);
        }
      })
    );
  }

  // ---- spacers ----

  /**
   * Where "after the latest call" is: the newest call in the cycle, visible or not, so a spacer added
   * while recording marks this moment - anything captured afterwards lands below it (see layoutSpacers).
   */
  readonly latestAnchor = computed<SpacerAnchor>(() => {
    let latest: CallRecord | null = null;
    for (const call of this.calls()) {
      if (!latest || new Date(call.timestamp).getTime() >= new Date(latest.timestamp).getTime()) latest = call;
    }
    return latest ? { afterCallId: latest.id, anchorTimestamp: latest.timestamp } : { afterCallId: null, anchorTimestamp: null };
  });

  addSpacer(label: string, anchor: SpacerAnchor = this.latestAnchor()): Observable<CycleSpacer | null> {
    const id = this.selectedCycle()?.id;
    if (!id) return of(null);
    return this.api.createSpacer(id, label, anchor.afterCallId, anchor.anchorTimestamp).pipe(
      map((spacer) => {
        this.spacers.set([...this.spacers(), spacer]);
        return spacer;
      })
    );
  }

  renameSpacer(spacerId: string, label: string): void {
    const id = this.selectedCycle()?.id;
    if (!id) return;
    this.api.renameSpacer(id, spacerId, label).subscribe({
      next: (updated) => this.spacers.set(this.spacers().map((s) => (s.id === updated.id ? updated : s))),
      error: () => this.error.set("Couldn't rename the spacer. Try again."),
    });
  }

  deleteSpacer(spacerId: string): void {
    const id = this.selectedCycle()?.id;
    if (!id) return;
    this.api.deleteSpacer(id, spacerId).subscribe({
      next: () => this.spacers.set(this.spacers().filter((s) => s.id !== spacerId)),
      error: () => this.error.set("Couldn't delete the spacer. Try again."),
    });
  }

  setShowOptionsCalls(show: boolean): void {
    this.showOptionsCalls.set(show);
    saveShowOptionsCalls(show);
  }

  isSourceVisible(key: string): boolean {
    return !this.hiddenSources().has(key);
  }

  toggleSourceVisible(key: string): void {
    const next = new Set(this.hiddenSources());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.setHidden(next);
  }

  showOnly(key: string): void {
    this.setHidden(new Set(this.sources().map((s) => s.key).filter((k) => k !== key)));
  }

  showAll(): void {
    this.setHidden(new Set());
  }

  /** The same global switch Settings and the Sources bar flip - stops inbound logging for this
   * project for every cycle and every user, not just this widget. */
  setLogging(name: string, enabled: boolean): void {
    this.loggingApi.setEnabled(name, enabled).subscribe({
      next: (services) => this.internalServices.set(services),
      error: () => this.error.set(`Couldn't change logging for ${name}. Try again.`),
    });
  }

  private setHidden(next: ReadonlySet<string>): void {
    this.hiddenSources.set(next);
    writeStorage(HIDDEN_SOURCES_KEY, JSON.stringify([...next]));
  }

  private loadServices(): void {
    this.loggingApi.getFeatureEnabled().subscribe({
      next: (res) => {
        this.inboundFeatureEnabled.set(res.enabled);
        if (res.enabled) this.loggingApi.getServices().subscribe((services) => this.internalServices.set(services));
      },
      error: () => this.inboundFeatureEnabled.set(false),
    });
  }

  private reload(): void {
    if (this.active) this.load(this.selectedCycle()?.id ?? null);
  }

  private load(cycleId: string | null): void {
    this.loadSub?.unsubscribe();
    if (!cycleId) {
      this.calls.set([]);
      this.spacers.set([]);
      return;
    }
    // A different cycle's calls must not linger under this one's name while the fetch is in flight.
    if (this.loadedFor !== cycleId) {
      this.calls.set([]);
      this.spacers.set([]);
    }
    this.loadedFor = cycleId;
    this.loading.set(true);
    this.loadSub = forkJoin([
      this.api.listCalls(cycleId, FULL_LIST_QUERY, 'external').pipe(catchError(() => of({ calls: [], total: 0 }))),
      this.api.listCalls(cycleId, FULL_LIST_QUERY, 'internal').pipe(catchError(() => of({ calls: [], total: 0 }))),
      this.api.listSpacers(cycleId).pipe(catchError(() => of<CycleSpacer[]>([]))),
    ]).subscribe(([external, internal, spacers]) => {
      this.loading.set(false);
      this.calls.set([...external.calls, ...internal.calls].map((c) => c.call));
      this.spacers.set(spacers);
      this.announced.clear();
      for (const c of this.calls()) this.announced.add(c.id);
    });
  }

  /** Another view changed a cycle's calls or spacers: reload when it is the one shown here. */
  private onCycleContentChanged(cycleId: string): void {
    if (cycleId === this.selectedCycle()?.id) this.reload();
  }

  private onWsMessage(message: CallsWsMessage | InternalCallsWsMessage, source: CallEndpointSource): void {
    if ('type' in message && message.type === 'ws-messages-appended') return;
    if (!('call' in message)) {
      // "Clear calls" - the cycle's own captured list may be unaffected, but a reload is the only way to know.
      this.reload();
      return;
    }
    const cycleId = this.selectedCycle()?.id;
    if (!cycleId || !message.capturedByCycleIds.includes(cycleId)) return;

    const call = toCallRecord(message.call, source);
    const existing = this.calls();
    // Two-phase logging pushes the same call twice (IN_PROGRESS, then resolved) - update it in place.
    const isNew = !existing.some((c) => c.id === call.id);
    this.calls.set(isNew ? [...existing, call] : existing.map((c) => (c.id === call.id ? call : c)));
    // Announced once per call: the resolved push of two-phase logging only refreshes the notification.
    if (this.isSourceVisible(widgetSourceKeyOf(call)) && (this.showOptionsCalls() || !isPreflight(call))) {
      const firstShown = !this.announced.has(call.id);
      this.announced.add(call.id);
      this.arrivalsSubject.next({ call, isNew: firstShown, seq: ++this.arrivalSeq });
    }
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = readStorage(key);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function readStorageArray(key: string): string[] {
  try {
    const parsed = JSON.parse(readStorage(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing / quota - the choice still holds for this session through the signal.
  }
}
