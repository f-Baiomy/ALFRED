import { EMPTY_SELECTION, headerState, hiddenCount, selectAll, selectRange, toggle } from './logs-selection';

describe('logs-selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('toggles and selects shift-click ranges in on-screen order', () => {
    let s = toggle(EMPTY_SELECTION, 'b');
    s = selectRange(s, 'd', order);
    expect([...s.ids].sort()).toEqual(['b', 'c', 'd']);
    s = selectRange(s, 'a', order);
    expect([...s.ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    s = toggle(s, 'c');
    expect(s.ids.has('c')).toBeFalse();
  });

  it('select-all flips between all and none of the rows shown', () => {
    let s = selectAll(EMPTY_SELECTION, order);
    expect(headerState(s, order)).toBe('all');
    s = selectAll(s, order);
    expect(headerState(s, order)).toBe('none');
    expect(headerState(toggle(EMPTY_SELECTION, 'a'), order)).toBe('some');
  });

  it('counts selected lines hidden by the current filters', () => {
    const s = toggle(toggle(EMPTY_SELECTION, 'a'), 'z');
    expect(hiddenCount(s, new Set(order), true)).toBe(1);
    expect(hiddenCount(s, new Set(order), false)).toBe(0);
  });
});
