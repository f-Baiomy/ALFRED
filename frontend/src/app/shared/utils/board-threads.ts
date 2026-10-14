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
  /** Reactions on this comment: emoji, how many, whether the user's own is on (✅ from the user = Go for Claude). */
  readonly reactions: readonly Reaction[];
  /** The comment was edited after it was written (its history is kept, docs/board.md "Rich text"). */
  readonly edited: boolean;
}

export interface Reaction {
  readonly emoji: string;
  readonly count: number;
  readonly mine: boolean;
}

/** Entries that annotate a comment rather than being part of the conversation. */
export function isAnnotation(e: ActivityEntry): boolean {
  return e.kind === 'REACTION' || e.kind === 'COMMENT_EDITED';
}

/** A comment's reactions, toggles applied in time order: a REACTION entry with newValue "on"/"off" per emoji. */
export function reactionsOf(entries: readonly ActivityEntry[], commentId: number): Reaction[] {
  const on = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.kind !== 'REACTION' || e.replyTo !== commentId || !e.text) continue;
    const who = on.get(e.text) ?? on.set(e.text, new Set()).get(e.text)!;
    if (e.newValue === 'off') who.delete(e.actor); else who.add(e.actor);
  }
  return Array.from(on.entries()).filter(([, w]) => w.size).map(([emoji, w]) => ({ emoji, count: w.size, mine: w.has('USER') }));
}

export function isQuestion(e: ActivityEntry): boolean {
  return e.kind === 'COMMENT' && e.actor === 'CLAUDE' && !!e.text && e.text.startsWith('**Question**');
}

export function historyThreads(all: readonly ActivityEntry[]): HistoryItem[] {
  const entries = all.filter((e) => !isAnnotation(e));
  const edited = new Set(all.filter((e) => e.kind === 'COMMENT_EDITED').map((e) => e.replyTo));
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
      return { entry, replies: mine, question, answered: question && mine.some((r) => r.actor === 'USER'),
        reactions: entry.kind === 'COMMENT' ? reactionsOf(all, entry.id) : [], edited: edited.has(entry.id) };
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
