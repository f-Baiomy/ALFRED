import { ActivityEntry } from '../../core/models/board.models';
import { after, dayLabel, isNewEntry, pathTo, replyTree } from './timeline-view';

describe('timeline-view (specs/023)', () => {
  const e = (at: string, actor: ActivityEntry['actor'] = 'CLAUDE'): ActivityEntry =>
    ({ id: 1, cardId: 'k', actor, kind: 'COMMENT', text: 'x', oldValue: null, newValue: null, at, replyTo: null });

  it('compares times as instants: the same second written with and without milliseconds is not "later"', () => {
    expect(after('2026-10-15T09:00:00Z', '2026-10-15T09:00:00.500Z')).toBeFalse();
    expect(after('2026-10-15T09:00:01Z', '2026-10-15T09:00:00.500Z')).toBeTrue();
  });

  it('only what others wrote after the user looked is new', () => {
    expect(isNewEntry(e('2026-10-15T10:00:00Z'), '2026-10-15T09:00:00Z')).toBeTrue();
    expect(isNewEntry(e('2026-10-15T10:00:00Z', 'USER'), '2026-10-15T09:00:00Z')).toBeFalse();
    expect(isNewEntry(e('2026-10-15T10:00:00Z'), null)).toBeFalse();
  });

  it('names the day: Today, Yesterday, else a short date', () => {
    const now = new Date(2026, 9, 16, 12, 0);
    expect(dayLabel(new Date(2026, 9, 16, 1, 0).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 15, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 1, 9, 0).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });

  it('draws the replies of a thread as a tree by the reply each was written to, counting what is new below each', () => {
    const r = (id: number, answers: number | null, at = `2026-10-15T0${id}:00:00Z`): ActivityEntry => ({ ...e(at), id, replyTo: 1, answers });
    // 2 and 5 answer the first comment; 3 answers 2, 4 answers 3; 6 answers a reply that is gone; 7 is an older reply
    const replies = [r(2, null), r(3, 2), r(4, 3, '2026-10-15T09:30:00Z'), r(5, null), r(6, 99), { ...r(7, null), answers: undefined }];
    const tree = replyTree(replies, '2026-10-15T08:00:00Z');
    expect(tree.map((n) => n.entry.id)).toEqual([2, 5, 6, 7]);
    expect(tree[0].children.map((n) => n.entry.id)).toEqual([3]);
    expect(tree[0].children[0].children.map((n) => n.entry.id)).toEqual([4]);
    expect(tree[0].size).toBe(2);
    expect(tree[0].fresh).toBe(1);
    expect(tree[1].size).toBe(0);
    expect(pathTo(replies, 4)).toEqual([2, 3]);
    expect(pathTo(replies, 2)).toEqual([]);
  });
});
