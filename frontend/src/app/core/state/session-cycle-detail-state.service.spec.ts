import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { SessionCycleDetailStateService } from './session-cycle-detail-state.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { InternalCallServiceDto, InternalLoggingApiService } from '../services/internal-logging-api.service';
import { CallEndpointSource, CallRecord, CallSummaryDto, CapturedCall } from '../models/call.model';
import { CycleSpacer } from './call-selection.tokens';
import { CallsQuery } from './call-list-view';

const PIN_STORAGE_KEY = 'alfred_pinned_calls';

/** Every test defaults to inbound logging disabled - see calls-state.service.spec.ts's identical stub. */
const FEATURE_DISABLED_STUB: Pick<InternalLoggingApiService, 'getFeatureEnabled' | 'getServices' | 'setEnabled'> = {
  getFeatureEnabled: () => of({ enabled: false }),
  getServices: () => of([]),
  setEnabled: () => of([]),
};

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'GET',
    request: { headers: {}, body: '' },
    timestamp: '2026-01-01T00:00:00.000000+00:00',
    duration_ms: 100,
    response: { status: 200, headers: {}, body: '{}' },
    ...overrides,
  };
}

function makeCaptured(call: CallRecord, id = `captured-${call.id}`): CapturedCall {
  return { id, capturedAt: call.timestamp, call };
}

/**
 * Records every (query, source) pair SessionCyclesApiService.listCalls was actually asked for, and
 * every removeCall invocation - mirrors CallsStateService.spec's setupWithSources, adapted to this
 * service's CapturedCall wrapper and cycleId-from-route wiring (a stubbed ActivatedRoute resolves
 * paramMap synchronously to a fixed cycle id).
 *
 * The service's own cycleId-reset effect (which clears state and refetches page one whenever
 * the open cycle "changes", including the very first time it resolves from '') can cause an
 * an extra, harmless, idempotent GET beyond the one a caller explicitly triggers - this is a
 * pre-existing characteristic of createCallListView's resetSource()/effect combo, unrelated to the
 * source-switching logic under test here, so assertions below check *content* (which source(s)
 * were actually queried, and what the resulting state converges to) rather than exact call counts.
 *
 * The WebSocket connections attempted in the constructor fail to connect in this test environment
 * and retry on a 3s timer - every test must run inside fakeAsync, tick() once, and
 * discardPeriodicTasks() before finishing.
 */
function setupWithSources(
  externalCaptured: CapturedCall[],
  internalCaptured: CapturedCall[],
  externalTotal = externalCaptured.length,
  internalTotal = internalCaptured.length
): {
  state: SessionCycleDetailStateService;
  listCalls: Array<{ query: CallsQuery; source: CallEndpointSource }>;
  removeCalls: Array<{ id: string; callId: string; source: CallEndpointSource | undefined }>;
  clearCalls: string[];
} {
  const listCalls: Array<{ query: CallsQuery; source: CallEndpointSource }> = [];
  const removeCalls: Array<{ id: string; callId: string; source: CallEndpointSource | undefined }> = [];
  const clearCalls: string[] = [];
  const apiStub: Pick<SessionCyclesApiService, 'listCalls' | 'removeCall' | 'removeCalls' | 'clearCalls' | 'getDetail' | 'getCallOverlaps' | 'listSpacers'> = {
    listCalls: (_id, query, source = 'external') => {
      listCalls.push({ query, source });
      return of(source === 'internal' ? { calls: internalCaptured, total: internalTotal } : { calls: externalCaptured, total: externalTotal });
    },
    removeCall: (id, callId, source) => {
      removeCalls.push({ id, callId, source });
      return of(void 0);
    },
    removeCalls: () => of({ removed: 0, notFound: 0 }),
    clearCalls: (id) => {
      clearCalls.push(id);
      return of(void 0);
    },
    getDetail: () => of({}),
    // Not under test here - just enough of a stub that createCallListView's required
    // fetchOverlaps callback has something to call (see call-utils.spec.ts for the actual
    // containment logic).
    getCallOverlaps: () => of([]),
    // Not under test here either - the spacer feature has its own spec coverage; this just keeps
    // the constructor's own reload-on-cycle-change effect from erroring out.
    listSpacers: () => of([]),
  };
  TestBed.configureTestingModule({
    providers: [
      SessionCycleDetailStateService,
      { provide: SessionCyclesApiService, useValue: apiStub },
      { provide: InternalLoggingApiService, useValue: FEATURE_DISABLED_STUB },
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cycle-1' })) } },
    ],
  });
  return { state: TestBed.inject(SessionCycleDetailStateService), listCalls, removeCalls, clearCalls };
}

describe('SessionCycleDetailStateService', () => {
  afterEach(() => localStorage.removeItem(PIN_STORAGE_KEY));

  it('defaults selectedSources to just "external" and never queries the internal-calls endpoint on the initial fetch', fakeAsync(() => {
    const call = makeCall();
    const { state, listCalls } = setupWithSources([makeCaptured(call)], []);
    tick();

    expect([...state.selectedSources()]).toEqual(['external']);
    expect(listCalls.every((c) => c.source === 'external')).toBe(true);
    expect(state.calls()).toEqual([call]);
    discardPeriodicTasks();
  }));

  it('toggling external off and an internal project on re-fetches from the internal-calls endpoint only', fakeAsync(() => {
    const external = [makeCaptured(makeCall({ id: 'ext-1' }))];
    const internal = [makeCaptured(makeCall({ id: 'int-1' }))];
    const { state, listCalls } = setupWithSources(external, internal);
    tick();

    listCalls.length = 0;
    state.toggleSource('external');
    state.toggleSource('odeysys');
    tick();

    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((c) => c.source === 'internal')).toBe(true);
    expect(state.calls()).toEqual([internal[0].call]);
    discardPeriodicTasks();
  }));

  it('selecting an internal project alongside external fetches both, merges by call time (this page\'s default sort), and sums totals', fakeAsync(() => {
    const older = makeCaptured(makeCall({ id: 'ext-1', timestamp: '2026-01-01T00:00:00.000Z' }));
    const newer = makeCaptured(makeCall({ id: 'int-1', timestamp: '2026-01-02T00:00:00.000Z' }));
    const { state, listCalls } = setupWithSources([older], [newer], 3, 4);
    tick();

    listCalls.length = 0;
    state.toggleSource('odeysys');
    tick();

    expect(new Set(listCalls.map((c) => c.source))).toEqual(new Set(['external', 'internal']));
    // This page's default sort is 'oldest-call' (unlike the dashboard's 'newest') - the merged
    // page must respect that same mode, oldest first.
    expect(state.calls()).toEqual([older.call, newer.call]);
    discardPeriodicTasks();
  }));

  it('merging both sources trims the merged page back down to the requested limit', fakeAsync(() => {
    const external = [makeCaptured(makeCall({ id: 'ext-1', timestamp: '2026-01-01T00:00:00.000Z' }))];
    const internal = [makeCaptured(makeCall({ id: 'int-1', timestamp: '2026-01-02T00:00:00.000Z' }))];
    const { state } = setupWithSources(external, internal);
    tick();

    state.setLimit(1);
    tick();
    state.toggleSource('odeysys');
    tick();

    expect(state.calls().length).toBe(1);
    discardPeriodicTasks();
  }));

  it("remove() looks up the captured call's backend id and threads the call's own stamped source through to the matching endpoint", fakeAsync(() => {
    const externalCall = makeCall({ id: 'ext-1', timestamp: '2026-01-01T00:00:00.000Z', source: 'external' });
    const internalCall = makeCall({ id: 'int-1', timestamp: '2026-01-02T00:00:00.000Z', source: 'internal' });
    const external = [makeCaptured(externalCall, 'captured-ext-1')];
    const internal = [makeCaptured(internalCall, 'captured-int-1')];
    const { state, removeCalls } = setupWithSources(external, internal);
    tick();

    state.toggleSource('odeysys');
    tick();

    state.remove(internalCall);
    tick();

    expect(removeCalls).toContain({ id: 'cycle-1', callId: 'captured-int-1', source: 'internal' });
    discardPeriodicTasks();
  }));

  it('deselecting every source fetches nothing rather than falling back to a default', fakeAsync(() => {
    const { state, listCalls } = setupWithSources([makeCaptured(makeCall())], []);
    tick();

    listCalls.length = 0;
    state.toggleSource('external');
    tick();

    expect(listCalls.length).toBe(0);
    expect(state.calls()).toEqual([]);
    discardPeriodicTasks();
  }));

  it('clearAllCalls hits the clear endpoint for this cycle, clears the selection, and re-fetches from scratch', fakeAsync(() => {
    const call = makeCall({ id: 'call-1' });
    const { state, clearCalls, listCalls } = setupWithSources([makeCaptured(call)], []);
    tick();

    state.toggleSelected(call);
    expect(state.selectedIds().size).toBe(1);
    listCalls.length = 0;

    state.clearAllCalls().subscribe();
    tick();

    expect(clearCalls).toEqual(['cycle-1']);
    expect(state.selectedIds().size).toBe(0);
    expect(listCalls.length).toBeGreaterThan(0);
    discardPeriodicTasks();
  }));
});

/** Spacer CRUD is a thin passthrough to the API that folds the result back into the `spacers` signal - these stub every spacer endpoint and track what each one was called with. */
function setupForSpacers(initialSpacers: CycleSpacer[] = []): {
  state: SessionCycleDetailStateService;
  createCalls: Array<{ label: string; beforeCallId: string | null; anchorTimestamp: string | null }>;
  renameCalls: Array<{ spacerId: string; label: string }>;
  moveCalls: Array<{ spacerId: string; beforeCallId: string | null; anchorTimestamp: string | null }>;
  deleteCalls: string[];
  listSpacerCalls: () => number;
  setServerSpacers: (spacers: CycleSpacer[]) => void;
} {
  const createCalls: Array<{ label: string; beforeCallId: string | null; anchorTimestamp: string | null }> = [];
  const renameCalls: Array<{ spacerId: string; label: string }> = [];
  const moveCalls: Array<{ spacerId: string; beforeCallId: string | null; anchorTimestamp: string | null }> = [];
  const deleteCalls: string[] = [];
  let serverSpacers = initialSpacers;
  let listSpacerCount = 0;
  const apiStub: Pick<
    SessionCyclesApiService,
    'listCalls' | 'removeCall' | 'removeCalls' | 'clearCalls' | 'getDetail' | 'getCallOverlaps' | 'listSpacers' | 'createSpacer' | 'renameSpacer' | 'moveSpacer' | 'deleteSpacer'
  > = {
    listCalls: () => of({ calls: [], total: 0 }),
    removeCall: () => of(void 0),
    removeCalls: () => of({ removed: 0, notFound: 0 }),
    clearCalls: () => of(void 0),
    getDetail: () => of({}),
    getCallOverlaps: () => of([]),
    listSpacers: () => {
      listSpacerCount++;
      return of(serverSpacers);
    },
    createSpacer: (_id, label, beforeCallId, anchorTimestamp) => {
      createCalls.push({ label, beforeCallId, anchorTimestamp });
      return of({ id: 'new-spacer', label, beforeCallId, anchorTimestamp });
    },
    renameSpacer: (_id, spacerId, label) => {
      renameCalls.push({ spacerId, label });
      return of({ id: spacerId, label, beforeCallId: null });
    },
    moveSpacer: (_id, spacerId, beforeCallId, anchorTimestamp) => {
      moveCalls.push({ spacerId, beforeCallId, anchorTimestamp });
      return of({ id: spacerId, label: 'Retry attempt', beforeCallId, anchorTimestamp });
    },
    deleteSpacer: (_id, spacerId) => {
      deleteCalls.push(spacerId);
      return of(void 0);
    },
  };
  TestBed.configureTestingModule({
    providers: [
      SessionCycleDetailStateService,
      { provide: SessionCyclesApiService, useValue: apiStub },
      { provide: InternalLoggingApiService, useValue: FEATURE_DISABLED_STUB },
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cycle-1' })) } },
    ],
  });
  return {
    state: TestBed.inject(SessionCycleDetailStateService),
    createCalls,
    renameCalls,
    moveCalls,
    deleteCalls,
    listSpacerCalls: () => listSpacerCount,
    setServerSpacers: (spacers) => (serverSpacers = spacers),
  };
}

describe('SessionCycleDetailStateService spacers', () => {
  it('loads every spacer for the open cycle up front', fakeAsync(() => {
    const { state } = setupForSpacers([{ id: 's1', label: 'Retry attempt', beforeCallId: 'call-1' }]);
    tick();

    expect(state.spacers()).toEqual([{ id: 's1', label: 'Retry attempt', beforeCallId: 'call-1' }]);
    discardPeriodicTasks();
  }));

  it('addSpacer appends the created spacer to the signal', fakeAsync(() => {
    const { state, createCalls } = setupForSpacers();
    tick();

    state.addSpacer('Retry attempt', 'call-2', 't2');
    tick();

    expect(createCalls).toEqual([{ label: 'Retry attempt', beforeCallId: 'call-2', anchorTimestamp: 't2' }]);
    expect(state.spacers()).toEqual([{ id: 'new-spacer', label: 'Retry attempt', beforeCallId: 'call-2', anchorTimestamp: 't2' }]);
    discardPeriodicTasks();
  }));

  it('renameSpacer replaces the matching spacer in the signal, leaving others untouched', fakeAsync(() => {
    const { state, renameCalls } = setupForSpacers([
      { id: 's1', label: 'Old name', beforeCallId: 'call-1' },
      { id: 's2', label: 'Other spacer', beforeCallId: 'call-2' },
    ]);
    tick();

    state.renameSpacer('s1', 'New name');
    tick();

    expect(renameCalls).toEqual([{ spacerId: 's1', label: 'New name' }]);
    expect(state.spacers()).toEqual([
      { id: 's1', label: 'New name', beforeCallId: null },
      { id: 's2', label: 'Other spacer', beforeCallId: 'call-2' },
    ]);
    discardPeriodicTasks();
  }));

  it('moveSpacer re-anchors the matching spacer', fakeAsync(() => {
    const { state, moveCalls } = setupForSpacers([{ id: 's1', label: 'Retry attempt', beforeCallId: 'call-1' }]);
    tick();

    state.moveSpacer('s1', 'call-3', 't3');
    tick();

    expect(moveCalls).toEqual([{ spacerId: 's1', beforeCallId: 'call-3', anchorTimestamp: 't3' }]);
    expect(state.spacers()).toEqual([{ id: 's1', label: 'Retry attempt', beforeCallId: 'call-3', anchorTimestamp: 't3' }]);
    discardPeriodicTasks();
  }));

  it('deleteSpacer removes the matching spacer from the signal', fakeAsync(() => {
    const { state, deleteCalls } = setupForSpacers([
      { id: 's1', label: 'Keep me', beforeCallId: 'call-1' },
      { id: 's2', label: 'Delete me', beforeCallId: 'call-2' },
    ]);
    tick();

    state.deleteSpacer('s2');
    tick();

    expect(deleteCalls).toEqual(['s2']);
    expect(state.spacers()).toEqual([{ id: 's1', label: 'Keep me', beforeCallId: 'call-1' }]);
    discardPeriodicTasks();
  }));

  describe('after a live capture push', () => {
    const summary: CallSummaryDto = {
      id: 'live-1',
      original_url: 'https://example.com-proxy/api/x',
      url: 'https://example.com/api/x',
      method: 'GET',
      timestamp: '2026-01-01T00:00:05.000Z',
      duration_ms: 10,
      status: 200,
    };
    const push = (state: SessionCycleDetailStateService) =>
      (state as unknown as { handleWsMessage(m: unknown, s: CallEndpointSource): void }).handleWsMessage({ call: summary, capturedByCycleIds: ['cycle-1'] }, 'external');

    it('does not refetch spacers when none is trailing - a capture only ever re-pins a trailing one', fakeAsync(() => {
      const { state, listSpacerCalls } = setupForSpacers([{ id: 's1', label: 'x', beforeCallId: 'call-1', anchorTimestamp: 't1' }]);
      tick();
      const before = listSpacerCalls();

      push(state);
      tick(1000);

      expect(listSpacerCalls()).toBe(before);
      discardPeriodicTasks();
    }));

    it('an orphaned spacer (only a timestamp left) does not count as trailing', fakeAsync(() => {
      const { state, listSpacerCalls } = setupForSpacers([{ id: 's1', label: 'x', beforeCallId: null, anchorTimestamp: 't1' }]);
      tick();
      const before = listSpacerCalls();

      push(state);
      tick(1000);

      expect(listSpacerCalls()).toBe(before);
      discardPeriodicTasks();
    }));

    it('refetches once, after a burst of pushes, when a trailing spacer exists', fakeAsync(() => {
      const { state, listSpacerCalls, setServerSpacers } = setupForSpacers([{ id: 's1', label: 'x', beforeCallId: null, anchorTimestamp: null }]);
      tick();
      const before = listSpacerCalls();
      setServerSpacers([{ id: 's1', label: 'x', beforeCallId: 'live-1', anchorTimestamp: summary.timestamp }]);

      push(state);
      tick(100);
      push(state);
      tick(1000);

      expect(listSpacerCalls()).toBe(before + 1);
      expect(state.spacers()).toEqual([{ id: 's1', label: 'x', beforeCallId: 'live-1', anchorTimestamp: summary.timestamp }]);
      discardPeriodicTasks();
    }));

    it('does not replace the spacers signal when the refetch returns the same list', fakeAsync(() => {
      const initial: CycleSpacer[] = [{ id: 's1', label: 'x', beforeCallId: null, anchorTimestamp: null }];
      const { state, setServerSpacers } = setupForSpacers(initial);
      tick();
      const loaded = state.spacers();
      setServerSpacers([{ ...initial[0] }]);

      push(state);
      tick(1000);

      expect(state.spacers()).toBe(loaded);
      discardPeriodicTasks();
    }));
  });
});

/** Page one must be fetched exactly once per opened cycle - see SessionCycleDetailStateService.sourcesKnown. */
describe('SessionCycleDetailStateService initial fetch', () => {
  function setup(internalLogging: Pick<InternalLoggingApiService, 'getFeatureEnabled' | 'getServices' | 'setEnabled'>): Array<CallEndpointSource> {
    const fetched: CallEndpointSource[] = [];
    const apiStub: Pick<SessionCyclesApiService, 'listCalls' | 'getCallOverlaps' | 'listSpacers'> = {
      listCalls: (_id, _query, source = 'external') => {
        fetched.push(source);
        return of({ calls: [], total: 0 });
      },
      getCallOverlaps: () => of([]),
      listSpacers: () => of([]),
    };
    TestBed.configureTestingModule({
      providers: [
        SessionCycleDetailStateService,
        { provide: SessionCyclesApiService, useValue: apiStub },
        { provide: InternalLoggingApiService, useValue: internalLogging },
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cycle-1' })) } },
      ],
    });
    TestBed.inject(SessionCycleDetailStateService);
    return fetched;
  }

  it('fetches external calls once when inbound logging is off', fakeAsync(() => {
    const fetched = setup(FEATURE_DISABLED_STUB);
    tick();

    expect(fetched).toEqual(['external']);
    discardPeriodicTasks();
  }));

  it('fetches external + internal once, only after the inbound services are known', fakeAsync(() => {
    const fetched = setup({
      getFeatureEnabled: () => of({ enabled: true }),
      getServices: () => of([{ name: 'core-service' }] as unknown as InternalCallServiceDto[]),
      setEnabled: () => of([]),
    });
    tick();

    expect(fetched.sort()).toEqual(['external', 'internal']);
    discardPeriodicTasks();
  }));

  it('still fetches the external calls when the feature flag cannot be read', fakeAsync(() => {
    const fetched = setup({
      getFeatureEnabled: () => throwError(() => new Error('backend down')) as Observable<{ enabled: boolean }>,
      getServices: () => of([]),
      setEnabled: () => of([]),
    });
    tick();

    expect(fetched).toEqual(['external']);
    discardPeriodicTasks();
  }));
});
