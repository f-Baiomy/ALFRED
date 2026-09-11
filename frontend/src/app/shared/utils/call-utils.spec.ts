import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import {
  callKey,
  durationClass,
  methodClass,
  sortCalls,
  sourceLabelOf,
  splitCallsForDisplay,
  statusClass,
  statusRank,
  supplierOf,
} from './call-utils';

function makeCandidate(overrides: Partial<CallOverlapCandidate> = {}): CallOverlapCandidate {
  return {
    id: 'candidate-1',
    source: 'external',
    serviceName: null,
    timestamp: '2026-01-01T00:00:00.010Z',
    durationMs: 10,
    status: 200,
    error: null,
    ...overrides,
  };
}

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
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

describe('sourceLabelOf', () => {
  it('labels a plain, unattributed external call "External"', () => {
    expect(sourceLabelOf(makeCall({ source: 'external', service_name: undefined }))).toBe('External');
    expect(sourceLabelOf(makeCall({ source: 'external', service_name: null }))).toBe('External');
  });

  it('labels an attributed external call "External · via <Project>" once outbound attribution names the calling project', () => {
    expect(sourceLabelOf(makeCall({ source: 'external', service_name: 'odeysys' }))).toBe('External · via Odeysys');
  });

  it('labels an internal call by its own service_name, title-cased, regardless of attribution', () => {
    expect(sourceLabelOf(makeCall({ source: 'internal', service_name: 'odeysys' }))).toBe('Odeysys');
    expect(sourceLabelOf(makeCall({ source: 'internal', service_name: 'unknown' }))).toBe('Unknown');
  });
});

describe('splitCallsForDisplay', () => {
  it('never splits an external call, regardless of sort mode', () => {
    const call = makeCall({ source: 'external' });
    for (const mode of ['newest', 'oldest', 'newest-call', 'oldest-call', 'status', 'custom'] as const) {
      const rows = splitCallsForDisplay([call], mode, undefined, 'all');
      expect(rows).toEqual([{ call, variant: 'full', rowKey: call.id }]);
    }
  });

  it('produces only a request row for an in-progress internal call', () => {
    const call = makeCall({ source: 'internal', state: 'IN_PROGRESS', response: undefined, duration_ms: 0 });
    const rows = splitCallsForDisplay([call], 'newest', undefined, 'all');
    expect(rows).toEqual([{ call, variant: 'request', rowKey: `${call.id}::request` }]);
  });

  it('renders provisionally split (never provisionally merged) while overlap candidates for the current range have not loaded yet', () => {
    const call = makeCall({ id: 'call-1', source: 'internal', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 100 });
    // overlapCandidates === undefined means "not loaded (yet)" - the safe default is split, even
    // though there are zero real candidates that would ever justify it once loaded.
    const rows = splitCallsForDisplay([call], 'oldest-call', undefined, 'all');
    expect(rows.map((r) => r.variant)).toEqual(['request', 'response']);
  });

  it('stays split when a genuine blocking child exists - high coverage, short tail, different service', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    // 80% of the parent's duration, ending 20ms before it - a genuine blocking child.
    const candidate = makeCandidate({ source: 'internal', serviceName: 'core-service', timestamp: '2026-01-01T00:00:00.000Z', durationMs: 80 });
    const rows = splitCallsForDisplay([call], 'oldest-call', [candidate], 'all');
    expect(rows.map((r) => r.variant)).toEqual(['request', 'response']);
  });

  it('merges into a single full row when a contained candidate only covers a small fraction of the parent\'s duration - a coincidental overlap, not a blocking child', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    // Strictly contained and a different service, but only 10% coverage - below MIN_COVERAGE_RATIO.
    const briefOverlap = makeCandidate({ source: 'internal', serviceName: 'core-service', timestamp: '2026-01-01T00:00:00.010Z', durationMs: 10 });
    const rows = splitCallsForDisplay([call], 'oldest-call', [briefOverlap], 'all');
    expect(rows).toEqual([{ call, variant: 'full', rowKey: call.id }]);
  });

  it('stays split when a candidate sits exactly at the coverage and tail boundary', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 1000,
    });
    // coverage = 300/1000 = 0.3 exactly (MIN_COVERAGE_RATIO); tail = 1000 - 750 = 250 exactly
    // (MIN_TAIL_MS, since max(250, 1000*0.1=100) === 250) - both thresholds are inclusive (>=/<=).
    const boundaryCandidate = makeCandidate({
      source: 'internal',
      serviceName: 'core-service',
      timestamp: '2026-01-01T00:00:00.450Z',
      durationMs: 300,
    });
    const rows = splitCallsForDisplay([call], 'oldest-call', [boundaryCandidate], 'all');
    expect(rows.map((r) => r.variant)).toEqual(['request', 'response']);
  });

  it('merges into a single full row when every contained, coverage/tail-qualifying candidate shares the call\'s own service name', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    const sameServiceCandidate = makeCandidate({ source: 'internal', serviceName: 'odeysys', timestamp: '2026-01-01T00:00:00.000Z', durationMs: 80 });
    const rows = splitCallsForDisplay([call], 'oldest-call', [sameServiceCandidate], 'all');
    expect(rows).toEqual([{ call, variant: 'full', rowKey: call.id }]);
  });

  it('merges into a single full row when a candidate only overlaps rather than being strictly contained', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    // Starts inside the call's window but ends after it - not strictly contained.
    const overlappingCandidate = makeCandidate({
      source: 'external',
      timestamp: '2026-01-01T00:00:00.050Z',
      durationMs: 200,
    });
    const rows = splitCallsForDisplay([call], 'oldest-call', [overlappingCandidate], 'all');
    expect(rows).toEqual([{ call, variant: 'full', rowKey: call.id }]);
  });

  it('excludes a candidate that fails the active status-pill filter from counting towards containment', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    // A contained, different-service, high-coverage candidate that would otherwise keep this call
    // split - but it failed (5xx), so it's filtered out under the 'ok' status-pill bucket, and the
    // call merges.
    const failedCandidate = makeCandidate({
      source: 'internal',
      serviceName: 'core-service',
      timestamp: '2026-01-01T00:00:00.000Z',
      durationMs: 80,
      status: 500,
      error: 'boom',
    });
    const merged = splitCallsForDisplay([call], 'oldest-call', [failedCandidate], 'ok');
    expect(merged).toEqual([{ call, variant: 'full', rowKey: call.id }]);

    // Under 'all' (or 'failed'), the same candidate counts and the call stays split.
    const stillSplit = splitCallsForDisplay([call], 'oldest-call', [failedCandidate], 'all');
    expect(stillSplit.map((r) => r.variant)).toEqual(['request', 'response']);
  });

  it('stays split for an external candidate whose serviceName exactly matches the internal call\'s own service_name - a definite outbound attribution, not excluded the way a same-name internal candidate would be', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    const attributedExternal = makeCandidate({
      source: 'external',
      serviceName: 'odeysys',
      timestamp: '2026-01-01T00:00:00.000Z',
      durationMs: 80,
    });
    const rows = splitCallsForDisplay([call], 'oldest-call', [attributedExternal], 'all');
    expect(rows.map((r) => r.variant)).toEqual(['request', 'response']);
  });

  it('merges when an external candidate carries a serviceName that does NOT match the internal call\'s own service_name - attribution says it belongs to a different call entirely', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    const misattributedExternal = makeCandidate({
      source: 'external',
      serviceName: 'some-other-project',
      timestamp: '2026-01-01T00:00:00.000Z',
      durationMs: 80,
    });
    const rows = splitCallsForDisplay([call], 'oldest-call', [misattributedExternal], 'all');
    expect(rows).toEqual([{ call, variant: 'full', rowKey: call.id }]);
  });

  it('stays split for an unattributed external candidate (serviceName null) regardless of the internal call\'s own service_name - backward-compat fallback for data predating outbound attribution', () => {
    const call = makeCall({
      id: 'call-1',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 100,
    });
    const unattributedExternal = makeCandidate({
      source: 'external',
      serviceName: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      durationMs: 80,
    });
    const rows = splitCallsForDisplay([call], 'oldest-call', [unattributedExternal], 'all');
    expect(rows.map((r) => r.variant)).toEqual(['request', 'response']);
  });

  it('the ambiguity veto merges BOTH internal calls when the same candidate is their only otherwise-qualifying evidence', () => {
    const callA = makeCall({
      id: 'call-a',
      source: 'internal',
      service_name: 'proj-a',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 1000,
    });
    const callB = makeCall({
      id: 'call-b',
      source: 'internal',
      service_name: 'proj-b',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 1000,
    });
    // Contained in, and a high-coverage/short-tail blocking signature for, BOTH calls' identical
    // windows - and named for neither project, so ownership passes against both too.
    const ambiguousCandidate = makeCandidate({
      id: 'ambiguous',
      source: 'internal',
      serviceName: 'core-service',
      timestamp: '2026-01-01T00:00:00.000Z',
      durationMs: 800,
    });
    const rows = splitCallsForDisplay([callA, callB], 'oldest-call', [ambiguousCandidate], 'all');
    expect(rows).toEqual(
      jasmine.arrayWithExactContents([
        { call: callA, variant: 'full', rowKey: callA.id },
        { call: callB, variant: 'full', rowKey: callB.id },
      ])
    );
  });

  it('produces a request row then a response row (chronologically) for a resolved internal call', () => {
    const call = makeCall({ id: 'call-1', source: 'internal', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 100 });
    const oldestFirst = splitCallsForDisplay([call], 'oldest-call', undefined, 'all');
    expect(oldestFirst.map((r) => r.variant)).toEqual(['request', 'response']);
    expect(oldestFirst.map((r) => r.rowKey)).toEqual(['call-1::request', 'call-1::response']);
    expect(oldestFirst.map((r) => r.call)).toEqual([call, call]);

    const newestFirst = splitCallsForDisplay([call], 'newest-call', undefined, 'all');
    expect(newestFirst.map((r) => r.variant)).toEqual(['response', 'request']);
  });

  it('interleaves request/response rows from multiple internal calls in true chronological order', () => {
    const a = makeCall({ id: 'a', source: 'internal', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.000Z', duration_ms: 500 });
    const b = makeCall({ id: 'b', source: 'internal', state: 'COMPLETED', timestamp: '2026-01-01T00:00:00.100Z', duration_ms: 50 });
    // a starts first but finishes after b starts and after b finishes: a-request, b-request, b-response, a-response.
    const rows = splitCallsForDisplay([a, b], 'oldest-call', undefined, 'all');
    expect(rows.map((r) => r.rowKey)).toEqual(['a::request', 'b::request', 'b::response', 'a::response']);
  });

  it('returns one unsplit full row per call for a non-chronological sort mode, even for internal calls', () => {
    const calls = [
      makeCall({ id: 'a', source: 'internal', state: 'COMPLETED' }),
      makeCall({ id: 'b', source: 'external' }),
    ];
    for (const mode of ['slowest', 'fastest', 'status', 'custom'] as const) {
      const rows = splitCallsForDisplay(calls, mode, undefined, 'all');
      expect(rows).toEqual(calls.map((call) => ({ call, variant: 'full', rowKey: call.id })));
    }
  });
});

