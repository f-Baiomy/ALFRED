import { signal } from '@angular/core';
import { CallRecord } from '../models/call.model';
import { createCallListView } from './call-list-view';

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

describe('createCallListView default sort mode', () => {
  const calls = [makeCall({ timestamp: 'first' }), makeCall({ timestamp: 'second' })];

  it('defaults to newest when no options are given (the dashboard convention)', () => {
    const view = createCallListView(signal(calls), signal(new Set()));

    expect(view.sortMode()).toBe('newest');
    expect(view.mainListCalls().map((c) => c.timestamp)).toEqual(['first', 'second']);
  });

  it('honors an explicit defaultSortMode (a session-cycle detail view opts into oldest-call)', () => {
    const chronological = [
      makeCall({ timestamp: '2026-01-01T00:00:01.000Z' }),
      makeCall({ timestamp: '2026-01-01T00:00:02.000Z' }),
    ];
    const view = createCallListView(signal(chronological), signal(new Set()), { defaultSortMode: 'oldest-call' });

    expect(view.sortMode()).toBe('oldest-call');
    expect(view.mainListCalls().map((c) => c.timestamp)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    ]);
  });

  it('setSortMode still overrides whatever the default was', () => {
    const view = createCallListView(signal(calls), signal(new Set()), { defaultSortMode: 'oldest-call' });

    view.setSortMode('newest');

    expect(view.sortMode()).toBe('newest');
  });
});
