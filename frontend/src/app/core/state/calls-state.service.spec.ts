import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallsStateService } from './calls-state.service';
import { CallsApiService } from '../services/calls-api.service';
import { CallRecord } from '../models/call.model';
import { CallsQuery } from './call-list-view';

const PIN_STORAGE_KEY = 'alfred_pinned_calls';

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

/**
 * Search/sort/supplier-filter/pagination are backend query params now (see call-list-view.ts) -
 * CallsStateService's own job is just wiring those query changes through to CallsApiService and
 * exposing whatever page comes back, so these tests stub the API to return a fixed page and
 * assert on both the exposed result and the query CallsStateService actually sent. The
 * WebSocket connection attempted in the constructor fails to connect in this test environment and
 * retries on a 3s timer - every test must run inside fakeAsync, tick() once, and
 * discardPeriodicTasks() before finishing, exactly as when this service used to poll.
 */
function setup(calls: CallRecord[], total = calls.length): { state: CallsStateService; queries: CallsQuery[] } {
  const queries: CallsQuery[] = [];
  const apiStub: Pick<CallsApiService, 'getCalls'> = {
    getCalls: (query) => {
      queries.push(query);
      return of({ calls, total });
    },
  };
  TestBed.configureTestingModule({
    providers: [{ provide: CallsApiService, useValue: apiStub }],
  });
  return { state: TestBed.inject(CallsStateService), queries };
}

describe('CallsStateService', () => {
  afterEach(() => localStorage.removeItem(PIN_STORAGE_KEY));

  it('exposes the fetched page', fakeAsync(() => {
    const calls = [makeCall()];
    const { state } = setup(calls);
    tick();

    expect(state.calls()).toEqual(calls);
    discardPeriodicTasks();
  }));

  it('defaults to newest sort and a 50-item page on the first fetch', fakeAsync(() => {
    const { queries } = setup([makeCall()]);
    tick();

    expect(queries[0]).toEqual({ search: '', supplier: '', sort: 'newest', offset: 0, limit: 50, sessionId: '', operationId: '', requestId: '' });
    discardPeriodicTasks();
  }));

  it('setSearchQuery re-fetches from offset 0 with the trimmed query', fakeAsync(() => {
    const { state, queries } = setup([makeCall()]);
    tick();

    state.setSearchQuery('  special-term  ');
    tick();

    expect(queries[1].search).toBe('special-term');
    expect(queries[1].offset).toBe(0);
    discardPeriodicTasks();
  }));

  it('setSupplierFilter re-fetches with the supplier param set', fakeAsync(() => {
    const { state, queries } = setup([makeCall()]);
    tick();

    state.setSupplierFilter('a.example');
    tick();

    expect(queries[1].supplier).toBe('a.example');
    discardPeriodicTasks();
  }));

  it('setSortMode re-fetches with the new sort', fakeAsync(() => {
    const { state, queries } = setup([makeCall()]);
    tick();

    state.setSortMode('slowest');
    tick();

    expect(queries[1].sort).toBe('slowest');
    discardPeriodicTasks();
  }));

  it('loadMore fetches the next page at the current offset', fakeAsync(() => {
    const calls = Array.from({ length: 10 }, (_, i) => makeCall({ timestamp: `t${i}` }));
    const { state, queries } = setup(calls, 25);
    tick();

    state.loadMore();
    tick();

    expect(queries[1].offset).toBe(10);
    // The stub returns the same 10-item page for every request, so after loadMore appends a
    // second page, 20 are loaded against a reported total of 25.
    expect(state.remainingCount()).toBe(5);
    discardPeriodicTasks();
  }));

  it('reports remainingCount from the backend total, not just what is loaded', fakeAsync(() => {
    const calls = Array.from({ length: 10 }, (_, i) => makeCall({ timestamp: `t${i}` }));
    const { state } = setup(calls, 25);
    tick();

    expect(state.visibleCalls().length).toBe(10);
    expect(state.remainingCount()).toBe(15);
    discardPeriodicTasks();
  }));

  it('groups the main list by supplier, busiest first', fakeAsync(() => {
    const a1 = makeCall({ url: 'https://a.example/1' });
    const a2 = makeCall({ url: 'https://a.example/2', timestamp: 't2' });
    const b1 = makeCall({ url: 'https://b.example/1', timestamp: 't3' });
    const { state } = setup([a1, a2, b1]);
    tick();

    expect(state.groupedCalls()).toEqual([
      { supplier: 'a.example', calls: [a1, a2] },
      { supplier: 'b.example', calls: [b1] },
    ]);
    discardPeriodicTasks();
  }));

  it('computes stats over the loaded set', fakeAsync(() => {
    const ok = makeCall({ response: { status: 200, headers: {}, body: '' } });
    const clientErr = makeCall({ response: { status: 404, headers: {}, body: '' }, timestamp: 't2' });
    const serverErr = makeCall({ response: { status: 500, headers: {}, body: '' }, timestamp: 't3' });
    const { state } = setup([ok, clientErr, serverErr]);
    tick();

    expect(state.stats()).toEqual({ total: 3, ok: 1, client: 1, failed: 1, inProgress: 0 });
    discardPeriodicTasks();
  }));

  it('counts a call still awaiting its response in its own inProgress bucket, not ok/client/failed', fakeAsync(() => {
    const pending = makeCall({ response: undefined, error: undefined, state: 'IN_PROGRESS' });
    const ok = makeCall({ response: { status: 200, headers: {}, body: '' }, timestamp: 't2', state: 'COMPLETED' });
    const { state } = setup([pending, ok]);
    tick();

    expect(state.stats()).toEqual({ total: 2, ok: 1, client: 0, failed: 0, inProgress: 1 });
    discardPeriodicTasks();
  }));

  it('excludes pinned calls from the main list to avoid rendering them twice', fakeAsync(() => {
    const pinned = makeCall();
    const other = makeCall({ timestamp: 't2' });

    // Simulate a pin via the same localStorage contract PinService uses.
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([pinned]));
    const { state } = setup([pinned, other]);
    tick();

    expect(state.mainListCalls()).toEqual([other]);
    discardPeriodicTasks();
  }));

  it('orders selectedCalls with pinned calls first, matching how the list actually renders, regardless of selection click order', fakeAsync(() => {
    const pinned = makeCall({ timestamp: 't1' });
    const a = makeCall({ timestamp: 't2' });
    const b = makeCall({ timestamp: 't3' });
    localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify([pinned]));
    const { state } = setup([pinned, a, b]);
    tick();

    // Selected out of display order on purpose - selectedCalls must not reflect click order.
    state.toggleSelected(b);
    state.toggleSelected(pinned);
    state.toggleSelected(a);

    expect(state.selectedCalls()).toEqual([pinned, a, b]);
    discardPeriodicTasks();
  }));

  it('orders selectedCalls by supplier group (busiest first) when Group by supplier is on, not the flat sort order', fakeAsync(() => {
    const a1 = makeCall({ url: 'https://a.example/1', timestamp: 't1' });
    const a2 = makeCall({ url: 'https://a.example/2', timestamp: 't2' });
    const b1 = makeCall({ url: 'https://b.example/1', timestamp: 't3' });
    const { state } = setup([b1, a1, a2]);
    tick();

    state.toggleGroupBySupplier();
    state.toggleSelected(b1);
    state.toggleSelected(a1);
    state.toggleSelected(a2);

    expect(state.selectedCalls()).toEqual([a1, a2, b1]);
    discardPeriodicTasks();
  }));
});
