import { signal } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { CallListView, CallsQuery, REFRESH_WINDOW_MS, createCallListView } from './call-list-view';

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

/** Search/sort/supplier-filter are backend query params now - createCallListView delegates to
 * whatever `fetchPage` returns rather than filtering/sorting client-side, so these tests assert
 * on what query was sent and how the (already-server-ordered) result is exposed, not on
 * client-side sorting logic (that's covered server-side by CallListSupportTest in the backend). */
function makeView(
  pages: readonly CallRecord[][],
  options: { defaultSortMode?: 'newest' | 'oldest' | 'newest-call' | 'oldest-call' | 'slowest' | 'fastest' | 'status' | 'custom'; customOrder?: ReturnType<typeof signal<readonly string[]>> } = {}
): { view: CallListView; queries: CallsQuery[] } {
  const queries: CallsQuery[] = [];
  let call = 0;
  return TestBed.runInInjectionContext(() => ({
    view: createCallListView(signal(new Set<string>()), {
      ...options,
      fetchPage: (query) => {
        queries.push(query);
        const page = pages[Math.min(call, pages.length - 1)];
        call++;
        return of({ calls: page, total: page.length });
      },
      // None of these tests exercise the overlap-candidates fetch itself (see call-utils.spec.ts
      // for that) - every fixture call here uses an unparseable timestamp, so overlapRange is
      // always null and this is never actually invoked.
      fetchOverlaps: () => of([]),
    }),
    queries,
  }));
}

describe('createCallListView', () => {
  const calls = [makeCall({ timestamp: 'first' }), makeCall({ timestamp: 'second' })];

  it('defaults to newest when no options are given (the dashboard convention) and fetches it', () => {
    const { view, queries } = makeView([calls]);

    expect(view.sortMode()).toBe('newest');
    expect(queries[0].sort).toBe('newest');
    expect(view.mainListCalls().map((c) => c.timestamp)).toEqual(['first', 'second']);
  });

  it('honors an explicit defaultSortMode (a session-cycle detail view opts into oldest-call)', () => {
    const { view, queries } = makeView([calls], { defaultSortMode: 'oldest-call' });

    expect(view.sortMode()).toBe('oldest-call');
    expect(queries[0].sort).toBe('oldest-call');
  });

  it('setSortMode to a non-custom mode triggers a fresh fetch with that sort', () => {
    const { view, queries } = makeView([calls, calls], { defaultSortMode: 'oldest-call' });

    view.setSortMode('newest');

    expect(view.sortMode()).toBe('newest');
    expect(queries.length).toBe(2);
    expect(queries[1].sort).toBe('newest');
  });

  it('setSortMode to custom does not trigger a fetch - it just reorders what is already loaded', () => {
    const customOrder = signal<readonly string[]>([]);
    const { view, queries } = makeView([calls], { customOrder });

    view.setSortMode('custom');
    customOrder.set([...view.mainListCalls()].reverse().map((c) => c.timestamp).map((t) => 'c_' + t));

    expect(view.sortMode()).toBe('custom');
    expect(queries.length).toBe(1);
  });

  it('loadMore fetches the next page with an offset and appends it', () => {
    const pageOne = [makeCall({ timestamp: 'a' })];
    const pageTwo = [makeCall({ timestamp: 'b' })];
    const { view, queries } = makeView([pageOne, pageTwo]);

    view.loadMore();

    expect(queries[1].offset).toBe(1);
    expect(view.mainListCalls().map((c) => c.timestamp)).toEqual(['a', 'b']);
  });

  it('setSearchQuery resets to offset 0 and sends the trimmed query text', () => {
    const { view, queries } = makeView([calls, calls]);

    view.setSearchQuery('  hello  ');

    expect(queries[1].search).toBe('hello');
    expect(queries[1].offset).toBe(0);
  });

  it('folds a burst of refresh() calls into one fetch now and one at the end of the window', fakeAsync(() => {
    const pageOne = [makeCall({ timestamp: 'a' })];
    const { view, queries } = makeView([pageOne]);
    expect(queries.length).toBe(1);

    // Twenty calls arriving together are forty WebSocket pushes, each asking for a refresh.
    for (let i = 0; i < 40; i++) view.refresh();
    expect(queries.length).toBe(2); // the first refresh, at once

    tick(REFRESH_WINDOW_MS);
    expect(queries.length).toBe(3); // the rest of the burst, once - nothing left unshown

    tick(REFRESH_WINDOW_MS * 2);
    expect(queries.length).toBe(3);
    view.refresh();
    expect(queries.length).toBe(4); // a quiet list refreshes at once again
    tick(REFRESH_WINDOW_MS);
  }));

  it('refresh() re-fetches from offset 0 for at least the currently-loaded count', () => {
    const pageOne = [makeCall({ timestamp: 'a' }), makeCall({ timestamp: 'b' })];
    const { view, queries } = makeView([pageOne, pageOne]);

    view.refresh();

    expect(queries[1].offset).toBe(0);
    expect(queries[1].limit).toBeGreaterThanOrEqual(2);
  });

  describe('showOptionsCalls', () => {
    const SHOW_OPTIONS_CALLS_KEY = 'alfred_show_options_calls';
    afterEach(() => localStorage.removeItem(SHOW_OPTIONS_CALLS_KEY));

    it('defaults to off and hides OPTIONS calls from mainListCalls/stats/supplierOptions', () => {
      const page = [makeCall({ id: 'preflight', method: 'OPTIONS', timestamp: 'first' }), makeCall({ id: 'real', method: 'GET', timestamp: 'second' })];
      const { view } = makeView([page]);

      expect(view.showOptionsCalls()).toBe(false);
      expect(view.mainListCalls().map((c) => c.id)).toEqual(['real']);
      expect(view.stats().total).toBe(1);
      expect(view.supplierOptions().reduce((sum, s) => sum + s.count, 0)).toBe(1);
    });

    it('toggleShowOptionsCalls reveals OPTIONS calls again and persists the preference', () => {
      const page = [makeCall({ id: 'preflight', method: 'OPTIONS', timestamp: 'first' }), makeCall({ id: 'real', method: 'GET', timestamp: 'second' })];
      const { view } = makeView([page]);

      view.toggleShowOptionsCalls();

      expect(view.showOptionsCalls()).toBe(true);
      expect(view.mainListCalls().map((c) => c.id)).toEqual(['preflight', 'real']);
      expect(localStorage.getItem(SHOW_OPTIONS_CALLS_KEY)).toBe('true');
    });

    it('a fresh view picks up a previously-saved preference', () => {
      localStorage.setItem(SHOW_OPTIONS_CALLS_KEY, 'true');
      const page = [makeCall({ id: 'preflight', method: 'OPTIONS', timestamp: 'first' })];
      const { view } = makeView([page]);

      expect(view.showOptionsCalls()).toBe(true);
      expect(view.mainListCalls().map((c) => c.id)).toEqual(['preflight']);
    });
  });

  describe('nestedOnly', () => {
    /** One internal call (0 -> 5s) wrapping one external call, plus a standalone external call
     * well outside it. Real timestamps, unlike the fixtures above - nesting is derived by comparing
     * windows, so it can't be exercised with unparseable ones. */
    const T0 = Date.parse('2026-01-01T00:00:00.000Z');
    const nestedPage = () => [
      makeCall({ id: 'parent', source: 'internal', state: 'COMPLETED', service_name: 'odeysys', timestamp: new Date(T0).toISOString(), duration_ms: 5000 }),
      makeCall({ id: 'child', source: 'external', service_name: null, timestamp: new Date(T0 + 1000).toISOString(), duration_ms: 500 }),
      makeCall({ id: 'standalone', source: 'external', service_name: null, timestamp: new Date(T0 + 60000).toISOString(), duration_ms: 500 }),
    ];

    it('defaults to off and shows everything', () => {
      const { view } = makeView([nestedPage()]);

      expect(view.nestedOnly()).toBe(false);
      expect(view.mainListCalls().map((c) => c.id)).toEqual(['parent', 'child', 'standalone']);
    });

    it('keeps a parent and its children, and drops a call involved in no nesting', () => {
      const { view } = makeView([nestedPage()]);

      view.setNestedOnly(true);

      expect(view.mainListCalls().map((c) => c.id)).toEqual(['parent', 'child']);
    });

    it('leaves the stat-pill counts alone, so turning it on cannot shrink the totals it is read against', () => {
      const { view } = makeView([nestedPage()]);

      view.setNestedOnly(true);

      expect(view.stats().total).toBe(3);
      expect(view.supplierOptions().reduce((sum, s) => sum + s.count, 0)).toBe(3);
    });

    it('narrows without refetching - it re-filters the window already in hand', () => {
      const { view, queries } = makeView([nestedPage()]);

      view.setNestedOnly(true);

      expect(queries.length).toBe(1);
      expect(view.callTree().length).toBe(1);
    });

    it('setNestedOnly(false) puts the standalone call back', () => {
      const { view } = makeView([nestedPage()]);

      view.setNestedOnly(true);
      view.setNestedOnly(false);

      expect(view.mainListCalls().map((c) => c.id)).toEqual(['parent', 'child', 'standalone']);
    });
  });
});
