import { ActivityEntry } from '../../core/models/board.models';

/**
 * A card's history as threads: every entry in time order, with the replies to a comment gathered under it (one
 * level - the backend points a reply to a reply at the first comment). A question is Claude's comment starting with
 * **Question**; it is answered once the user replied to it. Shared by the timeline and the exports.
 */
export interface HistoryItem {
  readonly entry: ActivityEntry;
  readonly replies: readonly ActivityEntry[];
  readonly question: boolean;
  readonly answered: boolean;
}

export function isQuestion(e: ActivityEntry): boolean {
  return e.kind === 'COMMENT' && e.actor === 'CLAUDE' && !!e.text && e.text.startsWith('**Question**');
}

export function historyThreads(entries: readonly ActivityEntry[]): HistoryItem[] {
  const comments = new Set(entries.filter((e) => e.kind === 'COMMENT').map((e) => e.id));
  const replies = new Map<number, ActivityEntry[]>();
  for (const e of entries) {
    if (e.replyTo != null && comments.has(e.replyTo)) {
      (replies.get(e.replyTo) ?? replies.set(e.replyTo, []).get(e.replyTo)!).push(e);
    }
  }
  return entries
    .filter((e) => e.replyTo == null || !comments.has(e.replyTo))
    .map((entry) => {
      const mine = replies.get(entry.id) ?? [];
      const question = isQuestion(entry);
      return { entry, replies: mine, question, answered: question && mine.some((r) => r.actor === 'USER') };
    });
}

/** Claude's questions no reply from the user answers yet. */
export function openQuestions(entries: readonly ActivityEntry[]): number {
  return historyThreads(entries).filter((i) => i.question && !i.answered).length;
}

/** " · ↳ reply to Claude (2026-10-10T09:00:00Z)" - which comment a reply answers. */
export function replyNote(e: ActivityEntry, history: readonly ActivityEntry[]): string {
  if (e.replyTo == null) return '';
  const to = history.find((h) => h.id === e.replyTo);
  return to ? ` · ↳ reply to ${to.actor === 'CLAUDE' ? 'Claude' : 'User'} (${to.at})` : ' · ↳ reply';
}
