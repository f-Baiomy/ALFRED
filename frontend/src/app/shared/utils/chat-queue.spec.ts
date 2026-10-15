import { ChatMessage } from '../../core/models/chat.models';
import { barTime, dayLine, initials, needsYouLine, nth, queuePosition, sinceSummary, threadsOf, ticksOf, tokens, unreadOf, waitingOrder } from './chat-queue';

function msg(id: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, project: 'p', scope: 'c1', parentId: null, author: 'USER', kind: 'TEXT', text: `m${id}`, state: 'WAITING', urgent: false,
    decision: false, origin: 'typed', context: [], quote: null, extra: null, reactions: {}, coversTo: null, replyTo: null, bridgeFrom: null,
    superseded: false, createdAt: '2026-10-15T10:00:00Z', editedAt: null, ...over };
}

describe('chat-queue', () => {
  it('orders the waiting messages urgent first, then oldest first, and counts what Claude is busy with', () => {
    const list = [msg(1), msg(2, { urgent: true }), msg(3, { state: 'ANSWERED' }), msg(4)];
    expect(waitingOrder(list).map((m) => m.id)).toEqual([2, 1, 4]);
    expect(queuePosition(list, 2)).toBe(1);
    expect(queuePosition(list, 4)).toBe(3);
    expect(queuePosition(list, 3)).toBeNull();
    const busy = [...list, msg(5, { state: 'TAKEN' })];
    expect(queuePosition(busy, 2)).toBe(2);
    expect(queuePosition(list, 1, 1)).toBe(3);
  });

  it('says 1st, 2nd, 3rd, 11th, 22nd', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 22, 101].map(nth)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '22nd', '101st']);
  });

  it('shows ticks for the user\'s own messages only', () => {
    expect(ticksOf(msg(1), true)?.text).toBe('sent');
    expect(ticksOf(msg(1), false)?.text).toBe('sent · waiting for Claude');
    expect(ticksOf(msg(1, { state: 'TAKEN' }), true)).toEqual({ marks: '✓✓', text: 'Claude has it', tone: 'got' });
    expect(ticksOf(msg(1, { state: 'ANSWERED' }), true)?.tone).toBe('done');
    expect(ticksOf(msg(1, { author: 'CLAUDE', state: 'DONE' }), true)).toBeNull();
  });

  it('counts unread from others after the last seen message', () => {
    const list = [msg(1), msg(2, { author: 'CLAUDE', state: 'DONE' }), msg(3), msg(4, { author: 'ALFRED', kind: 'SYSTEM', state: 'DONE' }),
      msg(5, { author: 'ALFRED', kind: 'TASK' })];
    expect(unreadOf(list, 1)).toEqual({ count: 2, firstId: 2 });
    expect(unreadOf(list, 4)).toEqual({ count: 0, firstId: null });
  });

  it('writes the needs-you line', () => {
    expect(needsYouLine({ questions: 2, proposals: 1, confirms: 0 })).toBe('2 questions · 1 proposal');
    expect(needsYouLine({ questions: 0, proposals: 0, confirms: 1 })).toBe('1 to confirm');
    expect(needsYouLine({ questions: 0, proposals: 0, confirms: 0 })).toBe('');
  });

  it('shows the time of today, the day of this week, else the date', () => {
    const now = new Date(2026, 9, 15, 18, 0);
    expect(barTime(new Date(2026, 9, 15, 9, 5).toISOString(), now)).toBe('09:05');
    expect(barTime(new Date(2026, 9, 13, 9, 5).toISOString(), now)).toBe('Tue');
    expect(barTime(new Date(2026, 8, 1).toISOString(), now)).toBe('1 Sept');
    expect(barTime(null, now)).toBe('');
  });

  it('draws a day line only when the day changes', () => {
    const now = new Date(2026, 9, 15, 18, 0);
    const today = new Date(2026, 9, 15, 9).toISOString();
    expect(dayLine(today, null, now)).toBe('Today');
    expect(dayLine(today, new Date(2026, 9, 15, 8).toISOString(), now)).toBeNull();
    expect(dayLine(new Date(2026, 9, 14, 9).toISOString(), null, now)).toBe('Yesterday');
  });

  it('makes initials, counts since the summary, groups threads, shortens token counts', () => {
    expect(initials('booking flow')).toBe('BF');
    expect(initials('project')).toBe('PR');
    expect(initials('')).toBe('?');
    const list = [msg(1), msg(2, { kind: 'SUMMARY', author: 'CLAUDE', coversTo: 1 }), msg(3), msg(4, { kind: 'SYSTEM' }), msg(5, { parentId: 3 })];
    expect(sinceSummary(list)).toBe(2);
    const t = threadsOf(list);
    expect(t.top.map((m) => m.id)).toEqual([1, 2, 3, 4]);
    expect(t.replies.get(3)?.map((m) => m.id)).toEqual([5]);
    expect([950, 1234, 34_000, 1_400_000].map(tokens)).toEqual(['950', '1.2k', '34k', '1.4M']);
  });
});
