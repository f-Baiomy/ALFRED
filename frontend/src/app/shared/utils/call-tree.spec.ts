import { CallRecord, SortMode } from '../../core/models/call.model';
import { splitCallsForDisplay } from './call-utils';
import { buildCallTree, depthRailPx, depthRails, depthTintClass, foldableIds, indexCallTree, indexDescendants, isTreeSortMode, nestedCallIds, requiresChronologicalSort } from './call-tree';

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

describe('indexDescendants', () => {
  it('gives each call everything below it at ANY depth, not just its direct children', () => {
    const index = indexDescendants(buildCallTree(chainFixture()));

    // odeysys called core-service, which called three suppliers - all four are odeysys's work.
    expect(index.get('odeysys')!.map((c) => c.id)).toEqual(['core', 'travelport', 'sabre', 'ndc']);
    expect(index.get('core')!.map((c) => c.id)).toEqual(['travelport', 'sabre', 'ndc']);
  });

  it('gives a leaf an empty list rather than nothing, so callers need not special-case it', () => {
    const index = indexDescendants(buildCallTree(chainFixture()));

    expect(index.get('sabre')).toEqual([]);
    expect(index.has('sabre')).toBe(true);
  });
});

describe('foldableIds', () => {
  it('names only the calls that have something to fold', () => {
    // The three suppliers are leaves: folding one would hide nothing and then need cleaning up.
    expect(foldableIds(buildCallTree(chainFixture()))).toEqual(['odeysys', 'core']);
  });
});

describe('a long-running same-service call must not orphan a real parent', () => {
  /**
   * The live shape this was found on (session cycle 456c336f): a 193-SECOND
   * `GET /Master2/airline/?status=1` on service odeysys spans most of the capture, so it contains
   * BOTH the 5.9s `POST get-upselling-flights` (odeysys) and the supplier call that POST actually
   * made. Two owners - but one is plainly inside the other, so this is a chain, not ambiguity.
   */
  function longRunningFixture(): CallRecord[] {
    return [
      call({ id: 'long-poll', startMs: 0, durationMs: 193133, service_name: 'odeysys' }),
      call({ id: 'real-parent', startMs: 135000, durationMs: 5944, service_name: 'odeysys' }),
      call({ id: 'supplier', startMs: 136321, durationMs: 3440, source: 'external', service_name: null }),
    ];
  }

  it('attributes the supplier call to the call that made it, not to the root', () => {
    const tree = buildCallTree(longRunningFixture());

    // long-poll and real-parent stay SIBLINGS - one odeysys call never nests under another (a
    // service does not call itself through Alfred). What matters is that the supplier call lands
    // under real-parent instead of becoming a third root, which is what it did before the fix: the
    // chain test used canOwn, which refuses one odeysys call owning another, so the two owners did
    // not look nested, the veto fired, and a real parent was thrown away.
    expect(tree.map((n) => n.call.id)).toEqual(['long-poll', 'real-parent']);
    const realParent = tree.find((n) => n.call.id === 'real-parent')!;
    expect(realParent.children.map((c) => c.call.id)).toEqual(['supplier']);
  });

  it('does not flag it as ambiguous', () => {
    const depths = indexCallTree(longRunningFixture());

    expect(depths.get('supplier')!.ambiguous).toBe(false);
    expect(depths.get('supplier')!.parentLabel).toBe('Odeysys');
    expect(depths.get('supplier')!.parentId).toBe('real-parent');
    expect(depths.get('supplier')!.depth).toBe(1);
  });

  it('still vetoes owners that merely OVERLAP, which is what ambiguity actually means', () => {
    // Neither of these two contains the other, and both contain the supplier call - there is no way
    // to tell whose work it was, so it takes no parent and is flagged. This is the case the veto is
    // for, and it must keep working.
    const overlapping = [
      call({ id: 'a', startMs: 0, durationMs: 5000, service_name: 'odeysys' }),
      call({ id: 'b', startMs: 1000, durationMs: 5000, service_name: 'core-service' }),
      call({ id: 'supplier', startMs: 2000, durationMs: 500, source: 'external', service_name: null }),
    ];

    const tree = buildCallTree(overlapping);
    expect(tree.some((n) => n.call.id === 'supplier')).toBe(true);
    expect(indexCallTree(overlapping).get('supplier')!.ambiguous).toBe(true);
  });

  it('agrees with the split algorithm, which has always used strict containment', () => {
    // The tree and the flat view's request/response split must never disagree about whose
    // downstream work a call was - see the mirror-per-consumer convention in call-utils.ts. This is
    // the pair that had drifted: the split got this fixture right the whole time.
    const calls = longRunningFixture();
    const candidates = calls.map((c) => ({
      id: c.id,
      timestamp: c.timestamp,
      durationMs: c.duration_ms ?? 0,
      source: c.source ?? 'external',
      serviceName: c.service_name ?? null,
      status: c.response?.status,
    }));

    // 'real-parent' is bracketed into a request half and a response half, which happens exactly when
    // the split finds it owns something.
    const rows = splitCallsForDisplay(calls, 'oldest-call', candidates as never, 'all');
    expect(rows.filter((r) => r.call.id === 'real-parent').map((r) => r.variant).sort()).toEqual(['request', 'response']);

    // ...and the tree now says the same.
    const realParent = buildCallTree(calls).find((n) => n.call.id === 'real-parent')!;
    expect(realParent.children.map((c) => c.call.id)).toEqual(['supplier']);
  });
});

describe('nestedCallIds', () => {
  it('keeps a parent AND everything under it, so a kept chain is never rendered hollow', () => {
    // Every call in chainFixture is either a parent or a child, so the whole chain survives - a
    // rule that dropped the leaves would leave core-service visibly containing nothing.
    const ids = nestedCallIds(buildCallTree(chainFixture()));

    expect([...ids].sort()).toEqual(['core', 'ndc', 'odeysys', 'sabre', 'travelport']);
  });

  it('drops only a call that is neither a parent nor a child', () => {
    const standalone = call({ id: 'alone', startMs: 60000, durationMs: 500, source: 'external', service_name: null });
    const ids = nestedCallIds(buildCallTree([...chainFixture(), standalone]));

    expect(ids.has('alone')).toBe(false);
    expect(ids.has('odeysys')).toBe(true);
    expect(ids.has('sabre')).toBe(true);
  });

  it('drops every call when nothing is nested in anything', () => {
    const loners = [
      call({ id: 'a', startMs: 0, durationMs: 100, source: 'external', service_name: null }),
      call({ id: 'b', startMs: 5000, durationMs: 100, source: 'external', service_name: null }),
    ];

    expect(nestedCallIds(buildCallTree(loners)).size).toBe(0);
  });
});

describe('depthTintClass', () => {
  it('gives each level its own hue and cycles rather than running out', () => {
    expect(depthTintClass(0)).toBe('depth-tint-0');
    expect(depthTintClass(3)).toBe('depth-tint-3');
    // Depth is uncapped in the data, so the ramp has to wrap somewhere - four levels apart is far
    // enough down the page that two rows sharing a hue can't be mistaken for the same level.
    expect(depthTintClass(4)).toBe('depth-tint-0');
    expect(depthTintClass(9)).toBe('depth-tint-1');
  });

  it('keeps colouring levels the indent has stopped distinguishing', () => {
    // depthRailPx caps at MAX_INDENT_LEVELS, so 3 and 9 are drawn at the same x - the hue is the
    // only thing left that tells them apart.
    expect(depthRailPx(3)).toBe(depthRailPx(9));
    expect(depthTintClass(3)).not.toBe(depthTintClass(9));
  });
});

describe('depthRails', () => {
  it('draws one line per ancestor level, then the row\'s own', () => {
    expect(depthRails(0).map((r) => r.tint)).toEqual(['depth-tint-0']);
    expect(depthRails(2).map((r) => r.tint)).toEqual(['depth-tint-0', 'depth-tint-1', 'depth-tint-2']);
    expect(depthRails(2).map((r) => r.own)).toEqual([false, false, true]);
  });

  it('adds the lines inside the indent that was already reserved, not on top of it', () => {
    for (const depth of [0, 1, 2, 3, 7]) {
      const total = depthRails(depth).reduce((sum, rail) => sum + rail.widthPx, 0);
      expect(total).toBe(depthRailPx(depth));
    }
  });

  it('keeps colouring the row\'s own level past the indent cap, where ancestors run out of room', () => {
    const deep = depthRails(5);
    // Three ancestor lines is all the capped indent has space for - but the last one still carries
    // level 5's hue, or depth 5 would be drawn as depth 3.
    expect(deep.length).toBe(4);
    expect(deep[deep.length - 1].tint).toBe(depthTintClass(5));
    expect(deep[deep.length - 1].own).toBe(true);
  });
});
