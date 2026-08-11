import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { CallListView, CallsQuery, createCallListView } from './call-list-view';

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

  it('refresh() re-fetches from offset 0 for at least the currently-loaded count', () => {
    const pageOne = [makeCall({ timestamp: 'a' }), makeCall({ timestamp: 'b' })];
    const { view, queries } = makeView([pageOne, pageOne]);

    view.refresh();

    expect(queries[1].offset).toBe(0);
    expect(queries[1].limit).toBeGreaterThanOrEqual(2);
  });
});
