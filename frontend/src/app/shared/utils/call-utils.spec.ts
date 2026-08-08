import { CallRecord, CapturedCall } from '../../core/models/call.model';
import {
  callKey,
  durationClass,
  matchesSearch,
  mergeLiveCalls,
  mergeLiveCapturedCalls,
  methodClass,
  sortCalls,
  statusClass,
  statusRank,
  supplierOf,
  unconfirmedLiveCalls,
  unconfirmedLiveCapturedCalls,
} from './call-utils';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'GET',
    request: { headers: { Accept: 'application/json' }, body: '' },
    timestamp: '2026-01-01T00:00:00.000000+00:00',
    duration_ms: 100,
    response: { status: 200, headers: {}, body: '{}' },
    ...overrides,
  };
}

describe('callKey', () => {
  it('is stable for the same call content', () => {
    const call = makeCall();
    expect(callKey(call)).toBe(callKey(makeCall()));
  });

  it('differs when timestamp, method, or url differ', () => {
    const base = callKey(makeCall());
    expect(callKey(makeCall({ timestamp: '2026-01-02T00:00:00.000000+00:00' }))).not.toBe(base);
    expect(callKey(makeCall({ method: 'POST' }))).not.toBe(base);
    expect(callKey(makeCall({ original_url: 'https://other.com-proxy/x' }))).not.toBe(base);
  });
});

describe('statusRank', () => {
  it('ranks errors above any status code', () => {
    expect(statusRank(makeCall({ error: 'boom', response: undefined }))).toBeGreaterThan(
      statusRank(makeCall({ response: { status: 599, headers: {}, body: '' } }))
    );
  });

  it('treats a missing response as lower than any real status', () => {
    expect(statusRank(makeCall({ response: undefined }))).toBeLessThan(statusRank(makeCall({ response: { status: 100, headers: {}, body: '' } })));
  });
});

describe('sortCalls', () => {
  const calls = [
    makeCall({ duration_ms: 50, response: { status: 200, headers: {}, body: '' } }),
    makeCall({ duration_ms: 500, response: { status: 404, headers: {}, body: '' } }),
    makeCall({ duration_ms: 200, response: { status: 500, headers: {}, body: '' } }),
  ];

  it('does not mutate the input array', () => {
    const copy = [...calls];
    sortCalls(calls, 'slowest');
    expect(calls).toEqual(copy);
  });

  it('sorts slowest first by duration', () => {
    expect(sortCalls(calls, 'slowest').map((c) => c.duration_ms)).toEqual([500, 200, 50]);
  });

  it('sorts fastest first by duration', () => {
    expect(sortCalls(calls, 'fastest').map((c) => c.duration_ms)).toEqual([50, 200, 500]);
  });

  it('sorts worst status first', () => {
    expect(sortCalls(calls, 'status').map((c) => c.response!.status)).toEqual([500, 404, 200]);
  });

  it('reverses for oldest-first (backend already returns newest-first)', () => {
    expect(sortCalls(calls, 'oldest')).toEqual([...calls].reverse());
  });

  it('leaves order untouched for newest', () => {
    expect(sortCalls(calls, 'newest')).toEqual(calls);
  });
});

describe('matchesSearch', () => {
  it('matches an empty query against anything', () => {
    expect(matchesSearch(makeCall(), '')).toBe(true);
  });

  it('matches against the method, url, and status', () => {
    const call = makeCall({ method: 'POST', url: 'https://supplier.example/x' });
    expect(matchesSearch(call, 'post')).toBe(true);
    expect(matchesSearch(call, 'supplier.example')).toBe(true);
    expect(matchesSearch(call, '200')).toBe(true);
  });

  it('matches inside request/response headers and bodies, not just top-level fields', () => {
    const call = makeCall({
      request: { headers: { 'x-api-key': 'secret-value' }, body: '{"supplier":"FlyNas"}' },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    });
    expect(matchesSearch(call, 'flynas')).toBe(true);
    expect(matchesSearch(call, 'secret-value')).toBe(true);
    expect(matchesSearch(call, 'nonexistent-term')).toBe(false);
  });
});

describe('supplierOf', () => {
  it('extracts the hostname from a valid url', () => {
    expect(supplierOf(makeCall({ url: 'https://supplier.example.com/api/x' }))).toBe('supplier.example.com');
  });

  it('falls back to the raw url when it cannot be parsed', () => {
    expect(supplierOf(makeCall({ url: 'not a url', original_url: 'also not a url' }))).toBe('not a url');
  });
});

describe('durationClass', () => {
  it('classifies fast/mid/slow thresholds', () => {
    expect(durationClass(100)).toBe('fast');
    expect(durationClass(500)).toBe('mid');
    expect(durationClass(2000)).toBe('slow');
    expect(durationClass(null)).toBe('');
  });
});

describe('statusClass', () => {
  it('classifies status buckets and missing status as an error', () => {
    expect(statusClass(200)).toBe('status-2xx');
    expect(statusClass(301)).toBe('status-3xx');
    expect(statusClass(404)).toBe('status-4xx');
    expect(statusClass(500)).toBe('status-5xx');
    expect(statusClass(null)).toBe('status-err');
  });
});

describe('methodClass', () => {
  it('recognizes known methods and falls back for unknown ones', () => {
    expect(methodClass('POST')).toBe('method-POST');
    expect(methodClass('post')).toBe('method-POST');
    expect(methodClass('TRACE')).toBe('method-DEFAULT');
  });
});

describe('mergeLiveCalls', () => {
  it('puts live-only calls ahead of the polled list', () => {
    const polled = [makeCall({ timestamp: 'polled-1' })];
    const live = [makeCall({ timestamp: 'live-1' })];

    const result = mergeLiveCalls(live, polled);

    expect(result.map((c) => c.timestamp)).toEqual(['live-1', 'polled-1']);
  });

  it('does not duplicate a call that is both live-pushed and already polled', () => {
    const shared = makeCall({ timestamp: 'shared' });

    const result = mergeLiveCalls([shared], [shared]);

    expect(result.length).toBe(1);
  });

  it('returns just the polled list when there are no live calls', () => {
    const polled = [makeCall({ timestamp: 'a' }), makeCall({ timestamp: 'b' })];

    expect(mergeLiveCalls([], polled)).toEqual(polled);
  });
});

describe('unconfirmedLiveCalls', () => {
  it('keeps live calls the polled list has not caught up to yet', () => {
    const live = [makeCall({ timestamp: 'still-live' })];
    const polled = [makeCall({ timestamp: 'unrelated' })];

    expect(unconfirmedLiveCalls(live, polled)).toEqual(live);
  });

  it('drops a live call once the same call appears in the polled list', () => {
    const confirmed = makeCall({ timestamp: 'now-polled' });
    const live = [confirmed, makeCall({ timestamp: 'still-live' })];

    const result = unconfirmedLiveCalls(live, [confirmed]);

    expect(result.map((c) => c.timestamp)).toEqual(['still-live']);
  });

  it('returns an empty array once every live call has been confirmed', () => {
    const confirmed = makeCall({ timestamp: 'now-polled' });

    expect(unconfirmedLiveCalls([confirmed], [confirmed])).toEqual([]);
  });
});

// Identity for merge/unconfirmed is derived from callKey(c.call), not CapturedCall.id (a
// live-pushed captured call doesn't have its real backend id yet) - so distinctness in these
// tests comes from varying the underlying call's timestamp, not the wrapper id.
function makeCapturedCall(id: string, callOverrides: Partial<CallRecord> = {}): CapturedCall {
  return {
    id,
    capturedAt: '2026-01-01T00:00:00.000000+00:00',
    call: makeCall({ timestamp: id, ...callOverrides }),
  };
}

describe('mergeLiveCapturedCalls', () => {
  it('puts live-only captured calls ahead of the polled list', () => {
    const polled = [makeCapturedCall('polled-1')];
    const live = [makeCapturedCall('live-1')];

    const result = mergeLiveCapturedCalls(live, polled);

    expect(result.map((c) => c.id)).toEqual(['live-1', 'polled-1']);
  });

  it('does not duplicate a captured call that is both live-pushed and already polled', () => {
    const shared = makeCapturedCall('shared');

    expect(mergeLiveCapturedCalls([shared], [shared]).length).toBe(1);
  });

  it('returns just the polled list when there are no live captured calls', () => {
    const polled = [makeCapturedCall('a'), makeCapturedCall('b')];

    expect(mergeLiveCapturedCalls([], polled)).toEqual(polled);
  });
});

describe('unconfirmedLiveCapturedCalls', () => {
  it('keeps live captured calls the polled list has not caught up to yet', () => {
    const live = [makeCapturedCall('still-live')];
    const polled = [makeCapturedCall('unrelated')];

    expect(unconfirmedLiveCapturedCalls(live, polled)).toEqual(live);
  });

  it('drops a live captured call once the same underlying call appears in the polled list', () => {
    const confirmed = makeCapturedCall('now-polled');
    const live = [confirmed, makeCapturedCall('still-live')];

    const result = unconfirmedLiveCapturedCalls(live, [confirmed]);

    expect(result.map((c) => c.id)).toEqual(['still-live']);
  });

  it('returns an empty array once every live captured call has been confirmed', () => {
    const confirmed = makeCapturedCall('now-polled');

    expect(unconfirmedLiveCapturedCalls([confirmed], [confirmed])).toEqual([]);
  });
});
