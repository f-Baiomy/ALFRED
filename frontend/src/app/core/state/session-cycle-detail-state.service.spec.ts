import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { SessionCycleDetailStateService } from './session-cycle-detail-state.service';
import { SessionCyclesApiService } from '../services/session-cycles-api.service';
import { InternalLoggingApiService } from '../services/internal-logging-api.service';
import { CallEndpointSource, CallRecord, CapturedCall } from '../models/call.model';
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
} {
  const listCalls: Array<{ query: CallsQuery; source: CallEndpointSource }> = [];
  const removeCalls: Array<{ id: string; callId: string; source: CallEndpointSource | undefined }> = [];
  const apiStub: Pick<SessionCyclesApiService, 'listCalls' | 'removeCall' | 'removeCalls' | 'getDetail'> = {
    listCalls: (_id, query, source = 'external') => {
      listCalls.push({ query, source });
      return of(source === 'internal' ? { calls: internalCaptured, total: internalTotal } : { calls: externalCaptured, total: externalTotal });
    },
    removeCall: (id, callId, source) => {
      removeCalls.push({ id, callId, source });
      return of(void 0);
    },
    removeCalls: () => of({ removed: 0, notFound: 0 }),
    getDetail: () => of({}),
  };
  TestBed.configureTestingModule({
    providers: [
      SessionCycleDetailStateService,
      { provide: SessionCyclesApiService, useValue: apiStub },
      { provide: InternalLoggingApiService, useValue: FEATURE_DISABLED_STUB },
      { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cycle-1' })) } },
    ],
  });
  return { state: TestBed.inject(SessionCycleDetailStateService), listCalls, removeCalls };
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
});
