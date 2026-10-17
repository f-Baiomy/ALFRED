import { homeLabel, placementOf } from './board-cards-visibility';

describe('board-cards-visibility', () => {
  const names = new Map([['b-refund', 'Refund flow']]);

  it('treats every card as own when no board is picked', () => {
    expect(placementOf({ boardId: 'b-refund' }, null)).toEqual({ own: true, homeId: null });
  });

  it('marks a card homed elsewhere with its home', () => {
    const p = placementOf({ boardId: 'b-refund' }, 'b-sprint');
    expect(p.own).toBeFalse();
    expect(homeLabel(p, names)).toBe('home: Refund flow');
  });

  it('keeps an own card unmarked', () => {
    const p = placementOf({ boardId: 'b-refund' }, 'b-refund');
    expect(homeLabel(p, names)).toBeNull();
  });

  it('names a default board by its project and an unknown board by a short id', () => {
    expect(homeLabel(placementOf({ boardId: 'default:odeysys' }, 'b-1'), names)).toBe('home: odeysys');
    expect(homeLabel(placementOf({ boardId: '0123456789abcdef' }, 'b-1'), names)).toBe('home: 01234567');
  });

  it('treats a card with no home yet (older Alfred) as own', () => {
    expect(placementOf({}, 'b-1').own).toBeTrue();
  });
});
