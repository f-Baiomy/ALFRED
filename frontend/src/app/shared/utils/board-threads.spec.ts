import { ActivityEntry } from '../../core/models/board.models';
import { historyThreads, openQuestions, replyNote } from './board-threads';

function e(id: number, actor: ActivityEntry['actor'], text: string | null, replyTo: number | null = null, kind: ActivityEntry['kind'] = 'COMMENT'): ActivityEntry {
  return { id, cardId: 'k', actor, kind, text, oldValue: null, newValue: null, at: `2026-10-10T09:0${id}:00Z`, replyTo };
}

describe('board-threads', () => {
  const history = [
    e(1, 'CLAUDE', null, null, 'CREATED'),
    e(2, 'CLAUDE', '**Question** Stack vouchers?'),
    e(3, 'USER', 'No', 2),
    e(4, 'CLAUDE', '**Reply** Understood', 2),
    e(5, 'CLAUDE', '**Question** Name the branch?'),
    e(6, 'USER', 'plain comment'),
  ];

  it('gathers replies under the comment they answer and keeps the rest in time order', () => {
    const items = historyThreads(history);
    expect(items.map((i) => i.entry.id)).toEqual([1, 2, 5, 6]);
    expect(items[1].replies.map((r) => r.id)).toEqual([3, 4]);
  });

  it('a question is answered once the user replied to it', () => {
    const items = historyThreads(history);
    expect(items[1].question).toBeTrue();
    expect(items[1].answered).toBeTrue();
    expect(items[2].answered).toBeFalse();
    expect(items[3].question).toBeFalse();
    expect(openQuestions(history)).toBe(1);
  });

  it('a reply whose comment is not in the list still shows, on its own', () => {
    expect(historyThreads([e(9, 'USER', 'orphan', 404)]).map((i) => i.entry.id)).toEqual([9]);
  });

  it('exports say which comment a reply answers', () => {
    expect(replyNote(history[2], history)).toBe(' · ↳ reply to Claude (2026-10-10T09:02:00Z)');
    expect(replyNote(history[5], history)).toBe('');
  });

  it('reactions and edits annotate their comment - never a reply or an item of their own', () => {
    const all = [...history, e(7, 'USER', '✅', 2, 'REACTION'), e(8, 'USER', '👍', 2, 'REACTION'), e(9, 'USER', '<p>plain, edited</p>', 6, 'COMMENT_EDITED')];
    const items = historyThreads(all);
    expect(items.map((i) => i.entry.id)).toEqual([1, 2, 5, 6]);
    const q = items.find((i) => i.entry.id === 2)!;
    expect(q.replies.map((r) => r.id)).toEqual([3, 4]);
    expect(q.reactions).toEqual([{ emoji: '✅', count: 1, mine: true }, { emoji: '👍', count: 1, mine: true }]);
    expect(items.find((i) => i.entry.id === 6)!.edited).toBeTrue();
    expect(q.edited).toBeFalse();
  });
});
