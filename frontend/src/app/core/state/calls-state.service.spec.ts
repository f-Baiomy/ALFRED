import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallsStateService } from './calls-state.service';
import { CallsApiService } from '../services/calls-api.service';
import { CallRecord } from '../models/call.model';

const PIN_STORAGE_KEY = 'alfred_pinned_calls';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
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

/**
 * Injects a CallsStateService whose polling resolves immediately to `calls`
 * (via a stubbed CallsApiService). The service polls on a periodic timer,
 * so every test that calls this must run inside fakeAsync, call tick() once
 * before reading signals, and call discardPeriodicTasks() before finishing
 * (otherwise fakeAsync fails the test over the still-pending interval).
 */
function setup(calls: CallRecord[]): CallsStateService {
  const apiStub: Pick<CallsApiService, 'getCalls'> = { getCalls: () => of(calls) };
  TestBed.configureTestingModule({
    providers: [{ provide: CallsApiService, useValue: apiStub }],
  });
  return TestBed.inject(CallsStateService);
}

describe('CallsStateService', () => {
  afterEach(() => localStorage.removeItem(PIN_STORAGE_KEY));

  it('exposes the polled calls', fakeAsync(() => {
    const calls = [makeCall()];
    const state = setup(calls);
    tick();

    expect(state.calls()).toEqual(calls);
    discardPeriodicTasks();
  }));

  it('filters by search query across headers and body, not just top-level fields', fakeAsync(() => {
    const matching = makeCall({ request: { headers: {}, body: 'special-term' } });
    const other = makeCall({ timestamp: 't2' });
    const state = setup([matching, other]);
    tick();

    state.setSearchQuery('special-term');

    expect(state.matchingCalls()).toEqual([matching]);
    discardPeriodicTasks();
  }));

  it('filters by supplier hostname', fakeAsync(() => {
    const a = makeCall({ url: 'https://a.example/x' });
    const b = makeCall({ url: 'https://b.example/x', timestamp: 't2' });
    const state = setup([a, b]);
    tick();

    state.setSupplierFilter('a.example');

    expect(state.matchingCalls()).toEqual([a]);
    discardPeriodicTasks();
  }));

  it('sorts the main list by the selected mode', fakeAsync(() => {
    const slow = makeCall({ duration_ms: 500 });
    const fast = makeCall({ duration_ms: 10, timestamp: 't2' });
    const state = setup([slow, fast]);
    tick();

    state.setSortMode('slowest');

    expect(state.mainListCalls()).toEqual([slow, fast]);
    discardPeriodicTasks();
  }));

  it('paginates the main list and grows on loadMore', fakeAsync(() => {
    const calls = Array.from({ length: 25 }, (_, i) => makeCall({ timestamp: `t${i}` }));
    const state = setup(calls);
    tick();

    expect(state.visibleCalls().length).toBe(20);
    expect(state.remainingCount()).toBe(5);

    state.loadMore();

    expect(state.visibleCalls().length).toBe(25);
    expect(state.remainingCount()).toBe(0);
    discardPeriodicTasks();
  }));

  it('groups the main list by supplier, busiest first', fakeAsync(() => {
    const a1 = makeCall({ url: 'https://a.example/1' });
    const a2 = makeCall({ url: 'https://a.example/2', timestamp: 't2' });
    const b1 = makeCall({ url: 'https://b.example/1', timestamp: 't3' });
    const state = setup([a1, a2, b1]);
    tick();

    expect(state.groupedCalls()).toEqual([
      { supplier: 'a.example', calls: [a1, a2] },
      { supplier: 'b.example', calls: [b1] },
    ]);
    discardPeriodicTasks();
  }));

  it('computes stats over the search-matching set', fakeAsync(() => {
    const ok = makeCall({ response: { status: 200, headers: {}, body: '' } });
    const clientErr = makeCall({ response: { status: 404, headers: {}, body: '' }, timestamp: 't2' });
    const serverErr = makeCall({ response: { status: 500, headers: {}, body: '' }, timestamp: 't3' });
    const state = setup([ok, clientErr, serverErr]);
    tick();

    expect(state.stats()).toEqual({ total: 3, ok: 1, client: 1, failed: 1 });
    discardPeriodicTasks();
  }));

  it('excludes pinned calls from the main list to avoid rendering them twice', fakeAsync(() => {
    const pinned = makeCall();
    const other = makeCall({ timestamp: 't2' });
    setup([pinned, other]);
    tick();
    discardPeriodicTasks();

    // Simulate a pin via the same localStorage contract PinService uses.
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([pinned]));
    TestBed.resetTestingModule();
    const reloaded = setup([pinned, other]);
    tick();

    expect(reloaded.mainListCalls()).toEqual([other]);
    discardPeriodicTasks();
  }));
});
