import { signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CycleSpacer, CallReorderState } from '../../core/state/call-selection.tokens';
import {
  MergedWithSpacer,
  SpacerOrder,
  TRAILING_ANCHOR,
  createSpacerGapController,
  layoutSpacers,
  reanchorDroppedSpacer,
  rootIndex,
  spacerOrderFor,
} from './spacer-gap-controller';

const ASC: SpacerOrder = { descending: false, byTime: true };
const DESC: SpacerOrder = { descending: true, byTime: true };
const CUSTOM: SpacerOrder = { descending: false, byTime: false };

/** Calls a..e at seconds 1..5 - `ts('c')` is c's own timestamp. */
const ts = (id: string) => `2026-01-01T00:00:0${'abcde'.indexOf(id) + 1}.000Z`;
const call = (id: string) => ({ id, timestamp: ts(id), method: 'GET', url: `https://x/${id}` }) as CallRecord;
const calls = (ids: string) => ids.split('').map(call);
const self = (c: CallRecord) => c;

function spacer(id: string, beforeCallId: string | null, anchorTimestamp: string | null = beforeCallId ? ts(beforeCallId) : null): CycleSpacer {
  return { id, label: id, beforeCallId, anchorTimestamp };
}

/** 'a|s1|b' - items by id, spacers by id, detached ones suffixed '!'. */
function render(merged: readonly MergedWithSpacer<CallRecord>[]): string {
  return merged.map((e) => (e.kind === 'item' ? e.item.id : e.spacer.id + (e.detached ? '!' : ''))).join('|');
}

function fakeReorderState(): CallReorderState & { readonly moveCalls: Array<[string, string | null, string | null]> } {
  const moveCalls: Array<[string, string | null, string | null]> = [];
  return {
    dragEnabled: signal(true),
    reorder: () => {},
    spacers: signal<readonly CycleSpacer[]>([]),
    addSpacer: () => {},
    renameSpacer: () => {},
    moveSpacer: (id, beforeCallId, anchorTimestamp) => moveCalls.push([id, beforeCallId, anchorTimestamp]),
    deleteSpacer: () => {},
    moveCalls,
  };
}

describe('spacerOrderFor', () => {
  it('treats the newest-first sorts as descending and every time sort as chronological', () => {
    expect(spacerOrderFor('newest')).toEqual({ descending: true, byTime: true });
    expect(spacerOrderFor('newest-call')).toEqual({ descending: true, byTime: true });
    expect(spacerOrderFor('oldest')).toEqual({ descending: false, byTime: true });
    expect(spacerOrderFor('oldest-call')).toEqual({ descending: false, byTime: true });
    expect(spacerOrderFor('custom')).toEqual({ descending: false, byTime: false });
    expect(spacerOrderFor('slowest')).toEqual({ descending: false, byTime: false });
  });
});

describe('layoutSpacers', () => {
  it('returns items unchanged when there are no spacers', () => {
    expect(render(layoutSpacers(calls('ab'), self, [], ASC).merged)).toBe('a|b');
  });

  describe('exact anchor', () => {
    it('ascending: sits directly before its anchor call', () => {
      expect(render(layoutSpacers(calls('abc'), self, [spacer('s1', 'b')], ASC).merged)).toBe('a|s1|b|c');
    });

    it('descending: sits directly BELOW its anchor call, since "before it" in time is below it', () => {
      expect(render(layoutSpacers(calls('cba'), self, [spacer('s1', 'b')], DESC).merged)).toBe('c|b|s1|a');
    });

    it('descending: below the anchor even when it is the last item', () => {
      expect(render(layoutSpacers(calls('ba'), self, [spacer('s1', 'a')], DESC).merged)).toBe('b|a|s1');
    });

    it('keeps several spacers on one anchor in creation order', () => {
      expect(render(layoutSpacers(calls('a'), self, [spacer('s1', 'a'), spacer('s2', 'a')], ASC).merged)).toBe('s1|s2|a');
    });

    it('never anchors to an ineligible item', () => {
      const merged = layoutSpacers(calls('ab'), (c) => (c.id === 'a' ? null : c), [spacer('s1', 'a', null)], CUSTOM).merged;
      expect(render(merged)).toBe('a|b|s1!');
    });

    it('in a tree view, sits before the root containing a nested anchor call', () => {
      const rootOf = new Map([['child', 'b']]);
      const merged = layoutSpacers(calls('abc'), self, [spacer('s1', 'child', null)], CUSTOM, (id) => rootOf.get(id)).merged;
      expect(render(merged)).toBe('a|s1|b|c');
    });
  });

  describe('anchor call not shown (filtered, searched out, deleted)', () => {
    it('ascending: placed by time, before the first shown call at or after its anchor', () => {
      // b is hidden; the spacer marked "before b" belongs between a and c.
      expect(render(layoutSpacers(calls('acd'), self, [spacer('s1', 'b')], ASC).merged)).toBe('a|s1|c|d');
    });

    it('descending: placed by time, above the first shown call older than its anchor', () => {
      expect(render(layoutSpacers(calls('dca'), self, [spacer('s1', 'b')], DESC).merged)).toBe('d|c|s1|a');
    });

    it('an orphan (anchor call deleted, only a timestamp left) still sits at its time', () => {
      expect(render(layoutSpacers(calls('acd'), self, [spacer('s1', null, ts('b'))], ASC).merged)).toBe('a|s1|c|d');
    });

    it('goes to the tail when every shown call is earlier than its anchor', () => {
      expect(render(layoutSpacers(calls('ab'), self, [spacer('s1', 'd')], ASC).merged)).toBe('a|b|s1');
    });

    it('is detached (at the end, flagged) in a non-time sort, rather than dropped', () => {
      expect(render(layoutSpacers(calls('acd'), self, [spacer('s1', 'b')], CUSTOM).merged)).toBe('a|c|d|s1!');
    });

    it('is detached when it predates anchorTimestamp and its anchor is hidden', () => {
      expect(render(layoutSpacers(calls('acd'), self, [spacer('s1', 'b', null)], ASC).merged)).toBe('a|c|d|s1!');
    });
  });

  describe('trailing (both anchor fields null)', () => {
    it('ascending: after every call', () => {
      expect(render(layoutSpacers(calls('ab'), self, [spacer('s1', null)], ASC).merged)).toBe('a|b|s1');
    });

    it('descending: above every call, since "after every call" is the top of a newest-first list', () => {
      expect(render(layoutSpacers(calls('ba'), self, [spacer('s1', null)], DESC).merged)).toBe('s1|b|a');
    });

    it('detached spacers go after trailing ones', () => {
      expect(render(layoutSpacers(calls('a'), self, [spacer('s1', 'x', null), spacer('s2', null)], CUSTOM).merged)).toBe('a|s2|s1!');
    });
  });

  describe('gap anchors', () => {
    it('ascending: the gap above a call anchors to that call; the tail gap is trailing', () => {
      const layout = layoutSpacers(calls('ab'), self, [], ASC);
      expect(layout.gapAnchors.get('a')).toEqual({ beforeCallId: 'a', anchorTimestamp: ts('a') });
      expect(layout.gapAnchors.get('b')).toEqual({ beforeCallId: 'b', anchorTimestamp: ts('b') });
      expect(layout.tailAnchor).toEqual(TRAILING_ANCHOR);
    });

    it('descending: the gap above a call anchors to the call above it; top is trailing; the tail anchors to the last call', () => {
      const layout = layoutSpacers(calls('ba'), self, [], DESC);
      expect(layout.gapAnchors.get('b')).toEqual(TRAILING_ANCHOR);
      expect(layout.gapAnchors.get('a')).toEqual({ beforeCallId: 'b', anchorTimestamp: ts('b') });
      expect(layout.tailAnchor).toEqual({ beforeCallId: 'a', anchorTimestamp: ts('a') });
    });

    for (const [name, order, ids] of [
      ['ascending', ASC, 'abc'],
      ['descending', DESC, 'cba'],
    ] as const) {
      it(`${name}: a spacer created from any gap renders back in that same gap`, () => {
        const items = calls(ids);
        const layout = layoutSpacers(items, self, [], order);
        const gaps: Array<[number, { beforeCallId: string | null; anchorTimestamp: string | null }]> = [
          ...items.map((item, i) => [i, layout.gapAnchors.get(item.id)!] as [number, { beforeCallId: string | null; anchorTimestamp: string | null }]),
          [items.length, layout.tailAnchor],
        ];
        for (const [position, anchor] of gaps) {
          const merged = layoutSpacers(items, self, [{ id: 'new', label: 'new', ...anchor }], order).merged;
          expect(merged.findIndex((e) => e.kind === 'spacer')).withContext(`gap ${position}`).toBe(position);
        }
      });
    }
  });
});

describe('reanchorDroppedSpacer', () => {
  const items = (merged: string) =>
    merged.split('|').map((id) => (id.startsWith('s') ? { kind: 'spacer' as const, spacer: spacer(id, 'a'), detached: false } : { kind: 'item' as const, item: call(id) }));

  it('ascending: anchors the dropped spacer to the call below it', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('a|b|s1|c'), 2, self, false, reorderState);
    expect(reorderState.moveCalls).toEqual([['s1', 'c', ts('c')]]);
  });

  it('ascending: dropped last becomes trailing', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('a|b|s1'), 2, self, false, reorderState);
    expect(reorderState.moveCalls).toEqual([['s1', null, null]]);
  });

  it('descending: anchors the dropped spacer to the call ABOVE it', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('c|b|s1|a'), 2, self, true, reorderState);
    expect(reorderState.moveCalls).toEqual([['s1', 'b', ts('b')]]);
  });

  it('descending: dropped at the top becomes trailing', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('s1|c|b'), 0, self, true, reorderState);
    expect(reorderState.moveCalls).toEqual([['s1', null, null]]);
  });

  it('only ever touches the dropped spacer, never the others', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('s2|a|b|s1|c|s3'), 3, self, false, reorderState);
    expect(reorderState.moveCalls.map(([id]) => id)).toEqual(['s1']);
  });

  it('skips ineligible items looking for the anchor', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('a|s1|b|c'), 1, (c) => (c.id === 'b' ? null : c), false, reorderState);
    expect(reorderState.moveCalls).toEqual([['s1', 'c', ts('c')]]);
  });

  it('does nothing when the anchor did not change', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('s1|a|b'), 0, self, false, reorderState);
    expect(reorderState.moveCalls).toEqual([]);
  });

  it('does nothing when the dropped entry is not a spacer', () => {
    const reorderState = fakeReorderState();
    reanchorDroppedSpacer(items('a|s1|b'), 0, self, false, reorderState);
    expect(reorderState.moveCalls).toEqual([]);
  });
});

describe('rootIndex', () => {
  it('maps every descendant of a root to that root', () => {
    const [a, b] = calls('ab');
    const index = rootIndex([a, b], new Map([
      ['a', [call('c'), call('d')]],
      ['b', []],
    ]));
    expect([...index.entries()]).toEqual([
      ['c', 'a'],
      ['d', 'a'],
    ]);
  });
});

describe('createSpacerGapController', () => {
  it('starts with no composer open', () => {
    const controller = createSpacerGapController(fakeReorderState());
    expect(controller.composingGapKey()).toBeUndefined();
  });

  it('addSpacerAt opens the composer at the given gap', () => {
    const controller = createSpacerGapController(fakeReorderState());
    controller.addSpacerAt('call-1', { beforeCallId: 'call-1', anchorTimestamp: 't1' });
    expect(controller.composingGapKey()).toBe('call-1');
  });

  it('confirmNewSpacer adds a trimmed, non-empty label with the gap anchor and closes the composer', () => {
    const reorderState = fakeReorderState();
    const addCalls: unknown[][] = [];
    reorderState.addSpacer = (...args) => addCalls.push(args);
    const controller = createSpacerGapController(reorderState);
    controller.addSpacerAt('call-1', { beforeCallId: 'call-0', anchorTimestamp: 't0' });

    controller.confirmNewSpacer('  Retry attempt  ');

    expect(addCalls).toEqual([['Retry attempt', 'call-0', 't0']]);
    expect(controller.composingGapKey()).toBeUndefined();
  });

  it('confirmNewSpacer with a blank label closes the composer without adding anything', () => {
    const reorderState = fakeReorderState();
    const addCalls: unknown[] = [];
    reorderState.addSpacer = (...args) => addCalls.push(args);
    const controller = createSpacerGapController(reorderState);
    controller.addSpacerAt('call-1', TRAILING_ANCHOR);

    controller.confirmNewSpacer('   ');

    expect(addCalls).toEqual([]);
    expect(controller.composingGapKey()).toBeUndefined();
  });

  it('confirmNewSpacer is a no-op when there is no reorderState (outside a session-cycle detail page)', () => {
    const controller = createSpacerGapController(null);
    controller.addSpacerAt(null, TRAILING_ANCHOR);

    expect(() => controller.confirmNewSpacer('Retry attempt')).not.toThrow();
    expect(controller.composingGapKey()).toBeUndefined();
  });

  it('cancelSpacerEdit closes the composer without adding anything', () => {
    const reorderState = fakeReorderState();
    const addCalls: unknown[] = [];
    reorderState.addSpacer = (...args) => addCalls.push(args);
    const controller = createSpacerGapController(reorderState);
    controller.addSpacerAt('call-1', TRAILING_ANCHOR);

    controller.cancelSpacerEdit();

    expect(addCalls).toEqual([]);
    expect(controller.composingGapKey()).toBeUndefined();
  });
});
