import { signal } from '@angular/core';
import { CycleSpacer, CallReorderState } from '../../core/state/call-selection.tokens';
import { createSpacerGapController, mergeWithSpacers, reanchorSpacersAfterDrop } from './spacer-gap-controller';

function spacer(id: string, beforeCallId: string | null, label = id): CycleSpacer {
  return { id, label, beforeCallId };
}

function fakeReorderState(): CallReorderState & { readonly moveCalls: Array<{ id: string; beforeCallId: string | null }> } {
  const moveCalls: Array<{ id: string; beforeCallId: string | null }> = [];
  return {
    dragEnabled: signal(true),
    reorder: () => {},
    spacers: signal<readonly CycleSpacer[]>([]),
    addSpacer: () => {},
    renameSpacer: () => {},
    moveSpacer: (id, beforeCallId) => moveCalls.push({ id, beforeCallId }),
    deleteSpacer: () => {},
    moveCalls,
  };
}

describe('mergeWithSpacers', () => {
  it('returns items unchanged when there are no spacers', () => {
    const merged = mergeWithSpacers(['a', 'b'], (x) => x, []);
    expect(merged).toEqual([{ kind: 'item', item: 'a' }, { kind: 'item', item: 'b' }]);
  });

  it('splices a spacer immediately before the item it is anchored to', () => {
    const merged = mergeWithSpacers(['a', 'b'], (x) => x, [spacer('s1', 'b')]);
    expect(merged).toEqual([
      { kind: 'item', item: 'a' },
      { kind: 'spacer', spacer: spacer('s1', 'b') },
      { kind: 'item', item: 'b' },
    ]);
  });

  it('places a spacer with beforeCallId null at the very end', () => {
    const merged = mergeWithSpacers(['a', 'b'], (x) => x, [spacer('s1', null)]);
    expect(merged).toEqual([
      { kind: 'item', item: 'a' },
      { kind: 'item', item: 'b' },
      { kind: 'spacer', spacer: spacer('s1', null) },
    ]);
  });

  it('keeps multiple spacers anchored to the same item in their given order', () => {
    const merged = mergeWithSpacers(['a'], (x) => x, [spacer('s1', 'a'), spacer('s2', 'a')]);
    expect(merged.map((m) => (m.kind === 'spacer' ? m.spacer.id : m.item))).toEqual(['s1', 's2', 'a']);
  });

  it('omits a spacer anchored to an item that idOf never returns (not a valid anchor)', () => {
    const merged = mergeWithSpacers(['a', 'b'], (x) => (x === 'a' ? null : x), [spacer('s1', 'a')]);
    expect(merged).toEqual([{ kind: 'item', item: 'a' }, { kind: 'item', item: 'b' }]);
  });

  it('omits a spacer anchored to an id that does not appear among the items at all', () => {
    const merged = mergeWithSpacers(['a', 'b'], (x) => x, [spacer('s1', 'missing')]);
    expect(merged).toEqual([{ kind: 'item', item: 'a' }, { kind: 'item', item: 'b' }]);
  });
});

describe('reanchorSpacersAfterDrop', () => {
  it('re-anchors a spacer to whatever item now immediately follows it', () => {
    const reorderState = fakeReorderState();
    const merged = mergeWithSpacers(['a', 'b', 'c'], (x) => x, [spacer('s1', 'a')]);
    // merged is [spacer, a, b, c] - drag the spacer past 'a' so it now sits before 'b'.
    const dragged = [merged[1], merged[0], merged[2], merged[3]];

    reanchorSpacersAfterDrop(dragged, (x) => x, reorderState);

    expect(reorderState.moveCalls).toEqual([{ id: 's1', beforeCallId: 'b' }]);
  });

  it('re-anchors to null when the spacer is now last', () => {
    const reorderState = fakeReorderState();
    const merged = mergeWithSpacers(['a', 'b'], (x) => x, [spacer('s1', 'a')]);
    // merged is [spacer, a, b] - drag the spacer past both items to the end.
    const dragged = [merged[1], merged[2], merged[0]];

    reanchorSpacersAfterDrop(dragged, (x) => x, reorderState);

    expect(reorderState.moveCalls).toEqual([{ id: 's1', beforeCallId: null }]);
  });

  it('skips past ineligible items (idOf returning null) when finding the next real anchor', () => {
    const reorderState = fakeReorderState();
    // 'child' is never a valid anchor (mirrors the waterfall view's non-root rows).
    const idOf = (x: string) => (x === 'child' ? null : x);
    const merged = mergeWithSpacers(['root1', 'child', 'root2'], idOf, [spacer('s1', 'root1')]);
    // Drag the spacer from before root1 to between 'child' and 'root2'.
    const dragged = [merged[1], merged[0], merged[2], merged[3]];

    reanchorSpacersAfterDrop(dragged, idOf, reorderState);

    expect(reorderState.moveCalls).toEqual([{ id: 's1', beforeCallId: 'root2' }]);
  });

  it('does not call moveSpacer when the anchor is unchanged', () => {
    const reorderState = fakeReorderState();
    const merged = mergeWithSpacers(['a', 'b'], (x) => x, [spacer('s1', 'b')]);

    reanchorSpacersAfterDrop(merged, (x) => x, reorderState);

    expect(reorderState.moveCalls).toEqual([]);
  });
});

describe('createSpacerGapController', () => {
  it('starts with no composer open', () => {
    const controller = createSpacerGapController(fakeReorderState());
    expect(controller.composingBeforeCallId()).toBeUndefined();
  });

  it('addSpacerBefore opens the composer at the given anchor', () => {
    const controller = createSpacerGapController(fakeReorderState());
    controller.addSpacerBefore('call-1');
    expect(controller.composingBeforeCallId()).toBe('call-1');
  });

  it('confirmNewSpacer adds a trimmed, non-empty label and closes the composer', () => {
    const reorderState = fakeReorderState();
    const addCalls: Array<{ label: string; beforeCallId: string | null }> = [];
    reorderState.addSpacer = (label, beforeCallId) => addCalls.push({ label, beforeCallId });
    const controller = createSpacerGapController(reorderState);
    controller.addSpacerBefore('call-1');

    controller.confirmNewSpacer('  Retry attempt  ');

    expect(addCalls).toEqual([{ label: 'Retry attempt', beforeCallId: 'call-1' }]);
    expect(controller.composingBeforeCallId()).toBeUndefined();
  });

  it('confirmNewSpacer with a blank label closes the composer without adding anything', () => {
    const reorderState = fakeReorderState();
    const addCalls: unknown[] = [];
    reorderState.addSpacer = (...args) => addCalls.push(args);
    const controller = createSpacerGapController(reorderState);
    controller.addSpacerBefore('call-1');

    controller.confirmNewSpacer('   ');

    expect(addCalls).toEqual([]);
    expect(controller.composingBeforeCallId()).toBeUndefined();
  });

  it('confirmNewSpacer is a no-op when there is no reorderState (outside a session-cycle detail page)', () => {
    const controller = createSpacerGapController(null);
    controller.addSpacerBefore(null);

    expect(() => controller.confirmNewSpacer('Retry attempt')).not.toThrow();
    expect(controller.composingBeforeCallId()).toBeUndefined();
  });

  it('cancelSpacerEdit closes the composer without adding anything', () => {
    const reorderState = fakeReorderState();
    const addCalls: unknown[] = [];
    reorderState.addSpacer = (...args) => addCalls.push(args);
    const controller = createSpacerGapController(reorderState);
    controller.addSpacerBefore('call-1');

    controller.cancelSpacerEdit();

    expect(addCalls).toEqual([]);
    expect(controller.composingBeforeCallId()).toBeUndefined();
  });
});
