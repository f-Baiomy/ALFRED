import { ActivityEntry } from '../../core/models/board.models';
import { after, dayLabel, isNewEntry, visibleReplies } from './timeline-view';

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

  it('a long thread shows its last two replies until the middle is opened', () => {
    const replies = [1, 2, 3, 4, 5].map((i) => e(`2026-10-15T0${i}:00:00Z`));
    expect(visibleReplies(replies.slice(0, 4), false).hidden).toBe(0);
    expect(visibleReplies(replies, false)).toEqual({ hidden: 3, shown: replies.slice(-2) });
    expect(visibleReplies(replies, true).hidden).toBe(0);
  });
});
