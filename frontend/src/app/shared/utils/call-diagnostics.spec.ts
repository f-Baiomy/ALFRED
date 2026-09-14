import { CallRecord } from '../../core/models/call.model';
import { CallTreeNode } from './call-tree';
import { analyzeCall } from './call-diagnostics';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(id: string, startMs: number, durationMs: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    original_url: `https://host/${id}`,
    url: `https://host/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200 },
    source: 'external',
    state: 'COMPLETED',
    ...overrides,
  } as CallRecord;
}

function node(root: CallRecord, children: readonly CallRecord[]): CallTreeNode {
  return {
    call: root,
    depth: 0,
    children: children.map((child) => ({ call: child, depth: 1, children: [] })),
  };
}

/** Builds a tree with one relay level between the root and its real leaf calls - odeysys ->
 * core-service -> [sabre calls], the shape a live 2-level-deep capture actually has. */
function nodeWithRelay(root: CallRecord, relay: CallRecord, leaves: readonly CallRecord[]): CallTreeNode {
  return {
    call: root,
    depth: 0,
    children: [
      {
        call: relay,
        depth: 1,
        children: leaves.map((leaf) => ({ call: leaf, depth: 2, children: [] })),
      },
    ],
  };
}

describe('analyzeCall', () => {
  it('assigns every millisecond of the root to exactly one bucket', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(node(root, [call('a', 1000, 2000), call('b', 5000, 1000)]))!;
    const { setupMs, upstreamMs, betweenMs, tailMs, durationMs } = result.ledger;

    expect(setupMs + upstreamMs + betweenMs + tailMs).toBe(durationMs);
  });

  it('counts overlapping calls once, so parallel work cannot claim more time than the request took', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    // Three calls, all inside 1000-4000ms. Summed they are 6500ms - more than the window they sit in.
    const result = analyzeCall(
      node(root, [call('a', 1000, 3000), call('b', 1500, 2000), call('c', 2000, 1500)])
    )!;

    expect(result.ledger.upstreamMs).toBe(3000);
    expect(result.parallelism!.sumOfDurationsMs).toBe(6500);
    expect(result.ledger.setupMs + result.ledger.upstreamMs + result.ledger.betweenMs + result.ledger.tailMs)
      .toBe(10_000);
  });

  it('reports gaps as the stretches with nothing in flight, not as per-pair differences', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    // a and b overlap (no gap between them); c starts 1000ms after b ends.
    const result = analyzeCall(
      node(root, [call('a', 1000, 1000), call('b', 1500, 1000), call('c', 3500, 500)])
    )!;

    expect(result.ledger.gaps.length).toBe(1);
    expect(result.ledger.gaps[0].durationMs).toBe(1000);
    expect(result.ledger.betweenMs).toBe(1000);
  });

  it('measures the real trace: 3.69s setup, 5.79s upstream, 17.24s tail', () => {
    // The Amadeus/Travelport/Sabre fan-out from a live 26.72s odeysys search.
    const root = call('odeysys', 0, 26_721, { source: 'internal' });
    const result = analyzeCall(
      node(root, [
        call('sabre', 3690, 2108),
        call('travelport-1', 3690, 2609),
        call('ndc-1', 3730, 5749),
        call('ndc-2', 3730, 4729),
        call('travelport-2', 4070, 2093),
      ])
    )!;

    expect(result.ledger.setupMs).toBe(3690);
    expect(result.ledger.upstreamMs).toBe(5789);
    expect(result.ledger.betweenMs).toBe(0);
    expect(result.ledger.tailMs).toBe(17_242);
    // Two thirds of the request happens after every supplier has already answered.
    expect(result.findings.some((f) => f.level === 'problem' && /after every response/.test(f.title))).toBe(true);
  });

  it('numbers the outbound calls in the order they were made, and names them in the findings', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(
      node(root, [call('first', 1000, 500), call('second', 1500, 4000), call('third', 2000, 500)])
    )!;

    expect(result.timings.map((t) => t.index)).toEqual([1, 2, 3]);
    // The findings have to name a number, not just a url: a fan-out routinely sends the same method
    // and path twice, and then "this call decides the total" points at two rows.
    const critical = result.findings.find((f) => /critical path/.test(f.title))!;
    expect(critical.title).toContain('#2');
    expect(critical.detail).toContain('#2');
  });

  it('keeps numbering aligned with the waterfall when a call never got a duration', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    // The middle call died before it was timed. The waterfall still gives it a numbered row, so if
    // this numbered only the measurable ones, its table would call the third call "#2".
    const result = analyzeCall(
      node(root, [
        call('ok', 1000, 500),
        call('refused', 1200, 0, { error: 'connection refused', response: undefined }),
        call('also-ok', 1500, 500),
      ])
    )!;

    expect(result.timings.map((t) => t.index)).toEqual([1, 3]);
  });

  it('reports a failure that never got a duration, which has no timing row to be found in', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(
      node(root, [
        call('ok', 1000, 500),
        call('refused', 1200, 0, { error: 'connection refused', response: undefined }),
      ])
    )!;

    const failure = result.findings.find((f) => /failed/.test(f.title))!;
    expect(failure.title).toBe('1 outbound call failed');
    expect(failure.detail).toContain('#2');
  });

  it('carries the numbers on a duplicate candidate so the confirmed finding can name them', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const url = 'https://ndc.example.com/api/FlightSearch/Search';
    const result = analyzeCall(
      node(root, [call('a', 1000, 2000, { url }), call('c', 1100, 100), call('b', 1140, 2000, { url })])
    )!;

    expect(result.duplicateCandidates[0].timings.map((t) => t.index)).toEqual([1, 3]);
  });

  it('gives slack to every call except the one that finishes last', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(node(root, [call('slow', 1000, 4000), call('quick', 1000, 1000)]))!;

    const slow = result.timings.find((t) => t.call.id === 'slow')!;
    const quick = result.timings.find((t) => t.call.id === 'quick')!;
    expect(slow.onCriticalPath).toBe(true);
    expect(slow.slackMs).toBe(0);
    expect(quick.onCriticalPath).toBe(false);
    expect(quick.slackMs).toBe(3000);
  });

  it('flags a sequential fan-out, which is what an await in a loop looks like', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(
      node(root, [call('a', 0, 1000), call('b', 1000, 1000), call('c', 2000, 1000)])
    )!;

    expect(result.parallelism!.maxConcurrent).toBe(1);
    expect(result.findings.some((f) => /run one at a time/.test(f.title))).toBe(true);
  });

  it('does not call back-to-back calls concurrent when one ends exactly as the next begins', () => {
    const root = call('root', 0, 5000, { source: 'internal' });
    const result = analyzeCall(node(root, [call('a', 0, 1000), call('b', 1000, 1000)]))!;

    expect(result.parallelism!.maxConcurrent).toBe(1);
  });

  it('offers same-url calls as CANDIDATES only, never as a finding claiming they are identical', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const url = 'https://ndc.example.com/api/FlightSearch/Search';
    const result = analyzeCall(
      node(root, [call('a', 1000, 2000, { url }), call('b', 1040, 2000, { url })])
    )!;

    // Matching method and url proves nothing on its own: a supplier fan-out posts to one search
    // endpoint repeatedly with different payloads. Only comparing the bodies settles it, and the
    // bodies are not in the list payload - so nothing is claimed here.
    expect(result.findings.some((f) => /identical/.test(f.title))).toBe(false);
    expect(result.duplicateCandidates.length).toBe(1);
    expect(result.duplicateCandidates[0].closestMs).toBe(40);
    expect(result.duplicateCandidates[0].timings.map((t) => t.index)).toEqual([1, 2]);
  });

  it('does not even offer the same endpoint called again much later as a candidate', () => {
    const root = call('root', 0, 20_000, { source: 'internal' });
    const url = 'https://ndc.example.com/api/FlightSearch/Search';
    const result = analyzeCall(
      node(root, [call('a', 1000, 500, { url }), call('b', 9000, 500, { url })])
    )!;

    expect(result.duplicateCandidates.length).toBe(0);
  });

  it('does not offer calls to different urls as candidates, however close together', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(
      node(root, [
        call('a', 1000, 500, { url: 'https://one.example.com/search' }),
        call('b', 1001, 500, { url: 'https://two.example.com/search' }),
      ])
    )!;

    expect(result.duplicateCandidates.length).toBe(0);
  });

  it('says so plainly when a call made no logged outbound requests at all', () => {
    const root = call('root', 0, 4000, { source: 'internal' });
    const result = analyzeCall(node(root, []))!;

    expect(result.ledger.unaccountedMs).toBe(4000);
    expect(result.ledger.upstreamMs).toBe(0);
    expect(result.findings[0].title).toContain('No outbound calls');
  });

  it('ignores in-progress children, which have no end to place on a timeline', () => {
    const root = call('root', 0, 10_000, { source: 'internal' });
    const result = analyzeCall(
      node(root, [call('done', 1000, 1000), call('pending', 2000, 0, { state: 'IN_PROGRESS' })])
    )!;

    expect(result.timings.length).toBe(1);
    expect(result.ledger.upstreamMs).toBe(1000);
  });

  it('returns nothing for a root that has no measurable window of its own', () => {
    expect(analyzeCall(node(call('root', 0, 0, { state: 'IN_PROGRESS' }), []))).toBeNull();
  });

  describe('calls nested more than one level deep', () => {
    // The bug this section guards: opening diagnose on a call two levels above its real suppliers
    // (odeysys -> core-service -> the two Sabre calls) used to show a single opaque row for
    // core-service and nothing about what it actually called - "full call data" was missing for
    // anyone above the immediate relay. leafDescendants flattens through the relay so the root's own
    // diagnose sees what it actually talked to, however many hops down that sits.
    it('sees straight through a relay to the calls it actually made', () => {
      const root = call('odeysys', 0, 22_000, { source: 'internal' });
      const relay = call('core-service', 4000, 17_000, { source: 'internal' });
      const leaf1 = call('sabre-getBooking', 4200, 9300);
      const leaf2 = call('sabre-checkTickets', 13_600, 7300);

      const result = analyzeCall(nodeWithRelay(root, relay, [leaf1, leaf2]))!;

      // The relay itself never appears as a row - only what it actually called does.
      expect(result.timings.map((t) => t.call.id)).toEqual(['sabre-getBooking', 'sabre-checkTickets']);
      expect(result.ledger.upstreamMs).toBe(16_600);
      expect(result.ledger.setupMs).toBe(4200);
      expect(result.ledger.betweenMs).toBe(100);
      expect(result.ledger.tailMs).toBe(1100);
      expect(result.ledger.setupMs + result.ledger.upstreamMs + result.ledger.betweenMs + result.ledger.tailMs)
        .toBe(22_000);
    });

    it('numbers a leaf by its position under its OWN direct parent, not by its position in the flattened list', () => {
      const root = call('root', 0, 20_000, { source: 'internal' });
      const relayA = call('relay-a', 1000, 5000, { source: 'internal' });
      const leafA1 = call('a1', 1200, 4000);
      const relayB = call('relay-b', 7000, 8000, { source: 'internal' });
      const leafB1 = call('b1', 7200, 3000);
      const leafB2 = call('b2', 10_500, 3000);

      const tree: CallTreeNode = {
        call: root,
        depth: 0,
        children: [
          { call: relayA, depth: 1, children: [{ call: leafA1, depth: 2, children: [] }] },
          {
            call: relayB,
            depth: 1,
            children: [
              { call: leafB1, depth: 2, children: [] },
              { call: leafB2, depth: 2, children: [] },
            ],
          },
        ],
      };

      const result = analyzeCall(tree)!;
      const indexById = new Map(result.timings.map((t) => [t.call.id, t.index]));

      // leafA1 is relayA's only child (local #1); leafB1/leafB2 are relayB's 1st and 2nd - NOT a
      // fresh 1/2/3 count across the flattened table, which would number leafB1 as "#2".
      expect(indexById.get('a1')).toBe(1);
      expect(indexById.get('b1')).toBe(1);
      expect(indexById.get('b2')).toBe(2);
    });
  });
});
