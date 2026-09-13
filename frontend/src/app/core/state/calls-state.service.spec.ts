import { TestBed, fakeAsync, tick, discardPeriodicTasks } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallsStateService } from './calls-state.service';
import { CallsApiService } from '../services/calls-api.service';
import { InternalLoggingApiService } from '../services/internal-logging-api.service';
import { CallOverlapCandidate, CallRecord } from '../models/call.model';
import { CallsQuery } from './call-list-view';

const PIN_STORAGE_KEY = 'alfred_pinned_calls';

/** Every test defaults to inbound logging disabled (no feature-enabled fetch resolving true, no services fetched) - the constructor's extra HTTP calls stay inert unless a test explicitly overrides this stub, matching "nobody configured any internal projects" as the baseline. */
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
  const apiStub: Pick<CallsApiService, 'getCalls' | 'getCallOverlaps'> = {
    getCalls: (query) => {
      queries.push(query);
      return of({ calls, total });
    },
    // Not under test here (see call-utils.spec.ts for the containment logic and
    // call-list-view.spec.ts for overlapCandidates' own fetch-on-range-change plumbing) - just
    // enough of a stub that createCallListView's required fetchOverlaps callback has something to
    // call.
    getCallOverlaps: () => of([]),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: CallsApiService, useValue: apiStub },
      { provide: InternalLoggingApiService, useValue: FEATURE_DISABLED_STUB },
    ],
  });
  return { state: TestBed.inject(CallsStateService), queries };
}

/**
 * Separate setup for source-switching tests: records which (query, source) pairs CallsApiService
 * was actually asked for, so a test can assert selecting an internal project fans out to the
 * internal-calls endpoint alongside (or instead of) external - exactly like the real
 * CallsApiService, whose `source` param defaults to 'external' (see calls-api.service.spec.ts).
 */
function setupWithSources(
  externalCalls: CallRecord[],
  internalCalls: CallRecord[],
  externalTotal = externalCalls.length,
  internalTotal = internalCalls.length
): { state: CallsStateService; calls: Array<{ query: CallsQuery; source: 'external' | 'internal' }> } {
  const calls: Array<{ query: CallsQuery; source: 'external' | 'internal' }> = [];
  const apiStub: Pick<CallsApiService, 'getCalls' | 'getCallOverlaps'> = {
    getCalls: (query, source = 'external') => {
      calls.push({ query, source });
      return source === 'internal' ? of({ calls: internalCalls, total: internalTotal }) : of({ calls: externalCalls, total: externalTotal });
    },
    getCallOverlaps: () => of([]),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: CallsApiService, useValue: apiStub },
      { provide: InternalLoggingApiService, useValue: FEATURE_DISABLED_STUB },
    ],
  });
  return { state: TestBed.inject(CallsStateService), calls };
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

  it('defaults to newest sort and a 200-item page on the first fetch', fakeAsync(() => {
    const { queries } = setup([makeCall()]);
    tick();

    expect(queries[0]).toEqual({ search: '', supplier: '', sort: 'newest', offset: 0, limit: 200, sessionId: '', operationId: '', requestId: '' });
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

  it('defaults selectedSources to just "external" and never passes a source on the initial fetch', fakeAsync(() => {
    const { state, queries } = setup([makeCall()]);
    tick();

    expect([...state.selectedSources()]).toEqual(['external']);
    expect(queries.length).toBe(1);
    discardPeriodicTasks();
  }));

  it('toggling external off and an internal project on re-fetches from GET /internal-calls only', fakeAsync(() => {
    const external = [makeCall({ id: 'ext-1' })];
    const internal = [makeCall({ id: 'int-1' })];
    const { state, calls } = setupWithSources(external, internal);
    tick();

    calls.length = 0;
    state.toggleSource('external');
    state.toggleSource('odeysys');
    tick();

    expect(calls.length).toBe(1);
    expect(calls[0].source).toBe('internal');
    expect(state.calls()).toEqual(internal);
    discardPeriodicTasks();
  }));

  it('selecting an internal project alongside external fetches both in parallel and merges by newest-call-time, summing totals', fakeAsync(() => {
    const older = makeCall({ id: 'ext-1', timestamp: '2026-01-01T00:00:00.000Z' });
    const newer = makeCall({ id: 'int-1', timestamp: '2026-01-02T00:00:00.000Z' });
    const { state, calls } = setupWithSources([older], [newer], 3, 4);
    tick();

    calls.length = 0;
    state.toggleSource('odeysys');
    tick();

    expect(calls.map((c) => c.source).sort()).toEqual(['external', 'internal']);
    // Default sort is 'newest' (received/capture order) - the merged page must be re-sorted by
    // that same mode rather than left in fetch-arrival order.
    expect(state.calls()).toEqual([newer, older]);
    discardPeriodicTasks();
  }));

  it('merging both sources trims the merged page back down to the requested limit', fakeAsync(() => {
    const external = [makeCall({ id: 'ext-1', timestamp: '2026-01-01T00:00:00.000Z' })];
    const internal = [makeCall({ id: 'int-1', timestamp: '2026-01-02T00:00:00.000Z' })];
    const { state } = setupWithSources(external, internal);
    tick();

    state.setLimit(1);
    tick();
    state.toggleSource('odeysys');
    tick();

    expect(state.calls().length).toBe(1);
    discardPeriodicTasks();
  }));

  it('deselecting every source fetches nothing rather than falling back to a default', fakeAsync(() => {
    const { state, calls } = setupWithSources([makeCall()], []);
    tick();

    calls.length = 0;
    state.toggleSource('external');
    tick();

    expect(calls.length).toBe(0);
    expect(state.calls()).toEqual([]);
    discardPeriodicTasks();
  }));

  describe('view mode', () => {
    afterEach(() => localStorage.removeItem('alfred_call_view_mode'));

    /** Like setup(), but with real overlap evidence: two calls nested inside `parent`, which is what
     * makes it eligible to split at all (see call-utils.ts's hasBlockingEvidence). */
    function setupWithOverlaps(calls: CallRecord[], candidates: CallOverlapCandidate[]): CallsStateService {
      const apiStub: Pick<CallsApiService, 'getCalls' | 'getCallOverlaps'> = {
        getCalls: () => of({ calls, total: calls.length }),
        getCallOverlaps: () => of(candidates),
      };
      TestBed.configureTestingModule({
        providers: [
          { provide: CallsApiService, useValue: apiStub },
          { provide: InternalLoggingApiService, useValue: FEATURE_DISABLED_STUB },
        ],
      });
      return TestBed.inject(CallsStateService);
    }

    it('splits a parent call in the flat-depth view only - the other two show containment structurally', fakeAsync(() => {
      const parent = makeCall({ id: 'parent', source: 'internal', service_name: 'odeysys', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 10000 });
      const nested = (id: string, startMs: number): CallOverlapCandidate => ({
        id,
        source: 'external',
        serviceName: null,
        timestamp: new Date(Date.parse('2026-01-01T00:00:00.000Z') + startMs).toISOString(),
        durationMs: 1000,
        status: 200,
        error: null,
      });
      const state = setupWithOverlaps([parent], [nested('child-a', 1000), nested('child-b', 2000)]);
      tick();

      expect(state.viewMode()).toBe('flat-depth');
      // Newest-first (the dashboard default), so the response row - which sorts at the call's END -
      // legitimately comes before its own request row here.
      expect(state.visibleRows().map((r) => r.variant)).toEqual(['response', 'request']);

      state.setViewMode('nested');
      tick();
      expect(state.visibleRows().map((r) => r.variant)).toEqual(['full']);

      state.setViewMode('waterfall');
      tick();
      expect(state.visibleRows().map((r) => r.variant)).toEqual(['full']);
      discardPeriodicTasks();
    }));

    it('moves a non-chronological sort back to chronological when a tree view is picked, and refetches', fakeAsync(() => {
      const { state, queries } = setup([makeCall()]);
      tick();
      state.setSortMode('slowest');
      tick();
      queries.length = 0;

      state.setViewMode('nested');
      tick();

      expect(state.sortMode()).toBe('newest');
      expect(queries.map((q) => q.sort)).toEqual(['newest']);
      discardPeriodicTasks();
    }));

    it('leaves an already-chronological sort alone, and never touches the sort for the flat-depth view', fakeAsync(() => {
      const { state, queries } = setup([makeCall()]);
      tick();
      state.setSortMode('oldest-call');
      tick();
      queries.length = 0;

      state.setViewMode('waterfall');
      tick();
      expect(state.sortMode()).toBe('oldest-call');
      expect(queries.length).toBe(0);

      state.setSortMode('slowest');
      tick();
      queries.length = 0;
      state.setViewMode('flat-depth');
      tick();
      // flat-depth reorders nothing, so a duration sort stays exactly as the user left it.
      expect(state.sortMode()).toBe('slowest');
      expect(queries.length).toBe(0);
      discardPeriodicTasks();
    }));

    it('remembers the chosen view across reloads', fakeAsync(() => {
      const first = setup([makeCall()]);
      tick();
      first.state.setViewMode('waterfall');
      tick();
      discardPeriodicTasks();

      TestBed.resetTestingModule();
      const second = setup([makeCall()]);
      tick();
      expect(second.state.viewMode()).toBe('waterfall');
      discardPeriodicTasks();
    }));

    it('exposes the call tree and per-call depth annotations for whatever is loaded', fakeAsync(() => {
      const parent = makeCall({ id: 'parent', source: 'internal', service_name: 'odeysys', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 10000 });
      const child = makeCall({ id: 'child', source: 'external', service_name: null, timestamp: '2026-01-01T00:00:01.000Z', duration_ms: 2000 });
      const { state } = setup([parent, child]);
      tick();

      expect(state.callTree().map((n) => n.call.id)).toEqual(['parent']);
      expect(state.callTree()[0].children.map((n) => n.call.id)).toEqual(['child']);
      expect(state.callDepths().get('child')!.parentLabel).toBe('Odeysys');
      expect(state.callDepths().get('parent')!.descendantCount).toBe(1);
      discardPeriodicTasks();
    }));
  });

  describe('subtree selection', () => {
    /** One internal parent with one external call inside it - the minimal real tree. */
    function parentAndChild(): { parent: CallRecord; child: CallRecord } {
      return {
        parent: makeCall({ id: 'parent', source: 'internal', service_name: 'odeysys', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 10000 }),
        child: makeCall({ id: 'child', source: 'external', service_name: null, timestamp: '2026-01-01T00:00:01.000Z', duration_ms: 2000 }),
      };
    }

    it('selects a parent and everything nested under it in one step', fakeAsync(() => {
      const { parent, child } = parentAndChild();
      const { state } = setup([parent, child]);
      tick();

      state.setSubtreeSelected(parent, true);

      expect(state.isSelected(parent)).toBe(true);
      expect(state.isSelected(child)).toBe(true);
      expect(state.subtreeSelection(parent)).toBe('all');
      discardPeriodicTasks();
    }));

    it('reports a parent as partially selected once one of its children is unticked', fakeAsync(() => {
      const { parent, child } = parentAndChild();
      const { state } = setup([parent, child]);
      tick();

      state.setSubtreeSelected(parent, true);
      state.toggleSelected(child);

      // The parent itself is still selected and still exports - 'some' is what makes that visible
      // rather than the checkbox claiming the whole subtree is in.
      expect(state.isSelected(parent)).toBe(true);
      expect(state.subtreeSelection(parent)).toBe('some');
      discardPeriodicTasks();
    }));

    it('deselecting a parent takes its children with it', fakeAsync(() => {
      const { parent, child } = parentAndChild();
      const { state } = setup([parent, child]);
      tick();

      state.setSubtreeSelected(parent, true);
      state.setSubtreeSelected(parent, false);

      expect(state.selectedCalls()).toEqual([]);
      expect(state.subtreeSelection(parent)).toBe('none');
      discardPeriodicTasks();
    }));

    it('a leaf is only ever fully in or fully out', fakeAsync(() => {
      const { parent, child } = parentAndChild();
      const { state } = setup([parent, child]);
      tick();

      expect(state.subtreeSelection(child)).toBe('none');
      state.setSubtreeSelected(child, true);
      expect(state.subtreeSelection(child)).toBe('all');
      // Selecting the child alone must not drag its parent in - the tree selects downwards only.
      expect(state.isSelected(parent)).toBe(false);
      discardPeriodicTasks();
    }));

    it('a drag started on a half-filled parent fills the subtree rather than clearing it', fakeAsync(() => {
      const { parent, child } = parentAndChild();
      const { state } = setup([parent, child]);
      tick();

      state.setSubtreeSelected(child, true);
      expect(state.subtreeSelection(parent)).toBe('some');

      state.startDragSelect(parent, true);
      state.endDragSelect();

      expect(state.subtreeSelection(parent)).toBe('all');
      discardPeriodicTasks();
    }));

    it('a drag in the flat view still paints one call at a time', fakeAsync(() => {
      const { parent, child } = parentAndChild();
      const { state } = setup([parent, child]);
      tick();

      state.startDragSelect(parent);
      state.endDragSelect();

      expect(state.isSelected(parent)).toBe(true);
      expect(state.isSelected(child)).toBe(false);
      discardPeriodicTasks();
    }));
  });

  describe('folding', () => {
    it('folds and unfolds by call id, and fold-all reaches only the calls that have children', fakeAsync(() => {
      const parent = makeCall({ id: 'parent', source: 'internal', service_name: 'odeysys', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 10000 });
      const child = makeCall({ id: 'child', source: 'external', service_name: null, timestamp: '2026-01-01T00:00:01.000Z', duration_ms: 2000 });
      const { state } = setup([parent, child]);
      tick();

      state.foldAll();
      expect([...state.foldedIds()]).toEqual(['parent']);

      state.unfoldAll();
      expect(state.foldedIds().size).toBe(0);

      state.setFolded(['parent'], true);
      expect(state.foldedIds().has('parent')).toBe(true);
      discardPeriodicTasks();
    }));
  });
});
