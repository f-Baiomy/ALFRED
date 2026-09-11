import { CallRecord, SortMode } from '../../core/models/call.model';
import { buildCallTree, depthRailPx, indexCallTree, isTreeSortMode, requiresChronologicalSort } from './call-tree';

/** Start times are ms offsets from this instant, so a test reads as "starts at +4s, runs 2s". */
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(overrides: Partial<CallRecord> & { id: string; startMs: number; durationMs: number }): CallRecord {
  const { id, startMs, durationMs, ...rest } = overrides;
  return {
    id,
    original_url: `http://localhost/${id}`,
    url: `http://host/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200 },
    source: 'internal',
    state: 'COMPLETED',
    ...rest,
  };
}

/** odeysys (0 -> 27000) wrapping core-service (4000 -> 8800) wrapping three suppliers. */
function chainFixture(): CallRecord[] {
  return [
    call({ id: 'odeysys', startMs: 0, durationMs: 27000, service_name: 'odeysys' }),
    call({ id: 'core', startMs: 4000, durationMs: 4800, service_name: 'core-service' }),
    call({ id: 'sabre', startMs: 4200, durationMs: 1780, source: 'external', service_name: 'core-service' }),
    call({ id: 'ndc', startMs: 4300, durationMs: 3600, source: 'external', service_name: 'core-service' }),
    call({ id: 'travelport', startMs: 4100, durationMs: 900, source: 'external', service_name: 'core-service' }),
  ];
}

describe('buildCallTree', () => {
  it('nests three levels deep, attaching each call to its innermost proven owner', () => {
    const tree = buildCallTree(chainFixture());

    expect(tree.length).toBe(1);
    expect(tree[0].call.id).toBe('odeysys');
    expect(tree[0].depth).toBe(0);

    expect(tree[0].children.map((c) => c.call.id)).toEqual(['core']);
    const core = tree[0].children[0];
    expect(core.depth).toBe(1);

    // Attributed to core-service, and core-service is the innermost owner - so they hang off it,
    // not off odeysys, even though odeysys contains them too.
    expect(core.children.map((c) => c.call.id)).toEqual(['travelport', 'sabre', 'ndc']);
    expect(core.children.every((c) => c.depth === 2)).toBe(true);
  });

  it('orders a parent\'s children chronologically regardless of the order they were passed in', () => {
    const reversed = [...chainFixture()].reverse();
    const core = buildCallTree(reversed)[0].children[0];

    expect(core.children.map((c) => c.call.id)).toEqual(['travelport', 'sabre', 'ndc']);
  });

  it('leaves an unattributed external call under the outer call when nothing inner can claim it', () => {
    // serviceName null passes the ownership check against ANY parent, so the innermost owner wins.
    const calls = [
      call({ id: 'odeysys', startMs: 0, durationMs: 27000, service_name: 'odeysys' }),
      call({ id: 'core', startMs: 4000, durationMs: 4800, service_name: 'core-service' }),
      call({ id: 'cdn', startMs: 20000, durationMs: 300, source: 'external', service_name: null }),
    ];
    const tree = buildCallTree(calls);

    // Starts after core-service finished, so odeysys is its only owner.
    expect(tree[0].children.map((c) => c.call.id)).toEqual(['core', 'cdn']);
  });

  it('keeps a call at root level when two merely-overlapping calls could equally claim it', () => {
    // Neither owner contains the other, so there's no way to tell whose work the child was.
    const calls = [
      call({ id: 'proj-a', startMs: 0, durationMs: 5000, service_name: 'proj-a' }),
      call({ id: 'proj-b', startMs: 1000, durationMs: 5000, service_name: 'proj-b' }),
      call({ id: 'shared', startMs: 2000, durationMs: 500, source: 'external', service_name: null }),
    ];
    const tree = buildCallTree(calls);

    expect(tree.map((n) => n.call.id).sort()).toEqual(['proj-a', 'proj-b', 'shared']);
    expect(indexCallTree(calls).get('shared')!.ambiguous).toBe(true);
  });

  it('never nests a call under an external call, or under a still-in-progress one', () => {
    const calls = [
      call({ id: 'outer-external', startMs: 0, durationMs: 9000, source: 'external', service_name: null }),
      call({ id: 'unresolved', startMs: 0, durationMs: 0, state: 'IN_PROGRESS', response: undefined }),
      call({ id: 'inner', startMs: 1000, durationMs: 100, source: 'external', service_name: null }),
    ];
    const tree = buildCallTree(calls);

    expect(tree.map((n) => n.call.id).sort()).toEqual(['inner', 'outer-external', 'unresolved']);
  });

  it('does not nest a call under another call of the same service - siblings, not parent and child', () => {
    const calls = [
      call({ id: 'outer', startMs: 0, durationMs: 5000, service_name: 'odeysys' }),
      call({ id: 'inner', startMs: 1000, durationMs: 500, service_name: 'odeysys' }),
    ];
    expect(buildCallTree(calls).map((n) => n.call.id)).toEqual(['outer', 'inner']);
  });

  it('keeps root order as given, so the list\'s own sort mode still decides what comes first', () => {
    const calls = [
      call({ id: 'second', startMs: 9000, durationMs: 100, service_name: 'a' }),
      call({ id: 'first', startMs: 0, durationMs: 100, service_name: 'b' }),
    ];
    expect(buildCallTree(calls).map((n) => n.call.id)).toEqual(['second', 'first']);
  });
});

describe('indexCallTree', () => {
  it('states each call\'s depth, parent, counts and span against its own root', () => {
    const index = indexCallTree(chainFixture());

    const odeysys = index.get('odeysys')!;
    expect(odeysys.depth).toBe(0);
    expect(odeysys.parentLabel).toBeNull();
    expect(odeysys.childCount).toBe(1);
    expect(odeysys.descendantCount).toBe(4);
    expect(odeysys.spanStart).toBe(0);
    expect(odeysys.spanWidth).toBe(1);

    const core = index.get('core')!;
    expect(core.depth).toBe(1);
    expect(core.parentLabel).toBe('Odeysys');
    expect(core.parentId).toBe('odeysys');
    expect(core.childCount).toBe(3);
    expect(core.descendantCount).toBe(3);
    // Starts 4s into a 27s root and runs 4.8s of it.
    expect(core.spanStart).toBeCloseTo(4000 / 27000, 5);
    expect(core.spanWidth).toBeCloseTo(4800 / 27000, 5);

    const sabre = index.get('sabre')!;
    expect(sabre.depth).toBe(2);
    expect(sabre.parentLabel).toBe('Core-service');
    expect(sabre.childCount).toBe(0);
    // Measured against the ROOT's window, not its immediate parent's.
    expect(sabre.spanStart).toBeCloseTo(4200 / 27000, 5);
    expect(sabre.spanWidth).toBeCloseTo(1780 / 27000, 5);
  });

  it('reports no span at all for a root with no measurable duration, rather than a misleading full bar', () => {
    const index = indexCallTree([call({ id: 'pending', startMs: 0, durationMs: 0, state: 'IN_PROGRESS', response: undefined })]);

    expect(index.get('pending')!.spanStart).toBeNull();
    expect(index.get('pending')!.spanWidth).toBeNull();
  });

  it('covers every call exactly once, roots included', () => {
    const calls = chainFixture();
    const index = indexCallTree(calls);

    expect(index.size).toBe(calls.length);
    for (const c of calls) expect(index.has(c.id)).toBe(true);
  });
});

describe('view mode helpers', () => {
  it('marks only the tree views as needing a chronological sort', () => {
    expect(requiresChronologicalSort('nested')).toBe(true);
    expect(requiresChronologicalSort('waterfall')).toBe(true);
    expect(requiresChronologicalSort('flat-depth')).toBe(false);
  });

  it('recognises exactly the four time-ordered sort modes', () => {
    const chronological: SortMode[] = ['newest', 'oldest', 'newest-call', 'oldest-call'];
    const other: SortMode[] = ['slowest', 'fastest', 'status', 'custom'];

    expect(chronological.every((mode) => isTreeSortMode(mode))).toBe(true);
    expect(other.some((mode) => isTreeSortMode(mode))).toBe(false);
  });

  it('stops widening the indent past the cap without flattening the depth itself', () => {
    expect(depthRailPx(0)).toBe(0);
    expect(depthRailPx(3)).toBe(depthRailPx(9));
    expect(depthRailPx(1)).toBeLessThan(depthRailPx(3));
  });
});
