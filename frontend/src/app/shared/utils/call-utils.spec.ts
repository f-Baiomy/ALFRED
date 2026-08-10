import { CallRecord } from '../../core/models/call.model';
import {
  callKey,
  durationClass,
  methodClass,
  sortCalls,
  statusClass,
  statusRank,
  supplierOf,
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

  it('sorts by the call\'s own timestamp for oldest-call/newest-call, independent of list order', () => {
    const outOfOrder = [
      makeCall({ timestamp: '2026-01-01T00:00:03.000Z', duration_ms: 1 }),
      makeCall({ timestamp: '2026-01-01T00:00:01.000Z', duration_ms: 2 }),
      makeCall({ timestamp: '2026-01-01T00:00:02.000Z', duration_ms: 3 }),
    ];

    expect(sortCalls(outOfOrder, 'oldest-call').map((c) => c.timestamp)).toEqual([
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:03.000Z',
    ]);
    expect(sortCalls(outOfOrder, 'newest-call').map((c) => c.timestamp)).toEqual([
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:01.000Z',
    ]);
  });

  it('treats an unparseable timestamp as epoch 0 rather than throwing', () => {
    const calls = [makeCall({ timestamp: '2026-01-01T00:00:01.000Z' }), makeCall({ timestamp: 'not-a-date' })];

    expect(() => sortCalls(calls, 'oldest-call')).not.toThrow();
    expect(sortCalls(calls, 'oldest-call').map((c) => c.timestamp)).toEqual(['not-a-date', '2026-01-01T00:00:01.000Z']);
  });

  it('leaves order untouched for newest', () => {
    expect(sortCalls(calls, 'newest')).toEqual(calls);
  });

  // callKey is derived from timestamp+method+original_url (not duration/status), so these two
  // tests need distinct timestamps per call - the shared `calls` fixture above deliberately
  // varies only duration_ms/response to test those sort modes, so all three share one callKey.
  const distinctCalls = [
    makeCall({ timestamp: '2026-01-01T00:00:01.000Z' }),
    makeCall({ timestamp: '2026-01-01T00:00:02.000Z' }),
    makeCall({ timestamp: '2026-01-01T00:00:03.000Z' }),
  ];

  it('orders calls by a custom callKey arrangement, ignoring their list order', () => {
    const [a, b, c] = distinctCalls;
    const customOrder = [callKey(c), callKey(a), callKey(b)];

    expect(sortCalls(distinctCalls, 'custom', customOrder)).toEqual([c, a, b]);
  });

  it('places a call not present in the custom order after every ranked call, in its prior relative order', () => {
    const [a, b, c] = distinctCalls;
    const customOrder = [callKey(b)];

    expect(sortCalls(distinctCalls, 'custom', customOrder)).toEqual([b, a, c]);
  });

  it('leaves order untouched for custom with no arrangement saved yet', () => {
    expect(sortCalls(distinctCalls, 'custom')).toEqual(distinctCalls);
    expect(sortCalls(distinctCalls, 'custom', [])).toEqual(distinctCalls);
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

