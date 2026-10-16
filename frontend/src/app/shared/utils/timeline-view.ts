import { ActivityEntry } from '../../core/models/board.models';
import { HistoryItem } from './board-threads';

/** Which entries the card's Activity shows (specs/023): everything, the conversation, or the changes. */
export type TimelineFilter = 'all' | 'comments' | 'changes';

export type TimelineRow =
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  /** A comment and its replies, shown whole. */
  | { readonly kind: 'thread'; readonly key: string; readonly item: HistoryItem }
  /** Changes in a row (status, teams, links…) - one dim line that opens to each of them. */
  | { readonly kind: 'changes'; readonly key: string; readonly entries: readonly HistoryItem[] }
  /** Everything older than the recent threads, behind one "Show N earlier" line. */
  | { readonly kind: 'earlier'; readonly key: string; readonly threads: number; readonly changes: number };

export interface TimelineOptions {
  readonly filter: TimelineFilter;
  readonly newestFirst: boolean;
  /** Find in the activity: only the threads whose text holds it (case-insensitive); nothing hidden as earlier. */
  readonly query: string;
  /** Entries after this (not the user's own) are new - never hidden as earlier. */
  readonly newSince: string | null;
  /** How many of the latest threads show (Infinity: all) - the earlier history comes in a page at a time. */
  readonly recent: number;
  readonly now: Date;
  /** Plain text of an entry, for find. */
  readonly textOf: (e: ActivityEntry) => string;
}

/** How many of the latest threads show; older history waits behind one "Show N earlier" line. */
export const RECENT_THREADS = 5;
/** How many more threads one "Show earlier" (or scrolling up to it) brings in: a long card never draws all at once. */
export const EARLIER_PAGE = 15;

export function isNewEntry(e: ActivityEntry, newSince: string | null): boolean {
  return !!newSince && e.actor !== 'USER' && after(e.at, newSince);
}

/** a is later than b - as instants: the same moment written "…:00Z" and "…:00.000Z" must not compare as text. */
export function after(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a > b : x > y;
}

/**
 * The rows of the Activity tab: day dividers, whole threads, runs of changes gathered into one line - and, on a long
 * card, the history before the last few threads behind one "Show N earlier" line. An open question or anything new
 * is never hidden that way: the line starts after the earliest of them.
 */
export function timelineRows(items: readonly HistoryItem[], o: TimelineOptions): TimelineRow[] {
  const q = o.query.trim().toLowerCase();
  const isComment = (i: HistoryItem) => i.entry.kind === 'COMMENT';
  let shown = items.filter((i) => (o.filter === 'all' ? true : o.filter === 'comments' ? isComment(i) : !isComment(i)));
  if (q) {
    shown = shown.filter((i) => isComment(i) && [i.entry, ...i.replies].some((e) => o.textOf(e).toLowerCase().includes(q)));
  }
  let start = 0;
  if (!q && Number.isFinite(o.recent)) {
    const threadAt = shown.map((i, n) => (isComment(i) ? n : -1)).filter((n) => n >= 0);
    if (threadAt.length > o.recent) {
      start = threadAt[threadAt.length - o.recent];
      const mustShow = shown.findIndex((i) => isComment(i) && ((i.question && !i.answered) || [i.entry, ...i.replies].some((e) => isNewEntry(e, o.newSince))));
      if (mustShow >= 0 && mustShow < start) start = mustShow;
    }
  }
  const hidden = shown.slice(0, start);

  const blocks: TimelineRow[] = [];
  let run: HistoryItem[] = [];
  const flush = () => {
    if (run.length) blocks.push({ kind: 'changes', key: 'c' + run[0].entry.id, entries: run });
    run = [];
  };
  for (const i of shown.slice(start)) {
    if (!isComment(i)) {
      run.push(i);
      continue;
    }
    flush();
    blocks.push({ kind: 'thread', key: 't' + i.entry.id, item: i });
  }
  flush();
  if (o.newestFirst) blocks.reverse();

  const rows: TimelineRow[] = [];
  let day = '';
  for (const b of blocks) {
    const at = b.kind === 'thread' ? b.item.entry.at : b.kind === 'changes' ? b.entries[0].entry.at : '';
    const label = dayLabel(at, o.now);
    if (label !== day) {
      rows.push({ kind: 'day', key: 'd' + b.key, label });
      day = label;
    }
    rows.push(b);
  }
  if (hidden.length) {
    const earlier: TimelineRow = { kind: 'earlier', key: 'earlier', threads: hidden.filter(isComment).length, changes: hidden.filter((i) => !isComment(i)).length };
    if (o.newestFirst) rows.push(earlier);
    else rows.unshift(earlier);
  }
  return rows;
}

/** "Today", "Yesterday", or "Oct 14" (with the year when it is not this one). */
export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

/**
 * One reply in a thread's tree (specs/023): its replies under it, how many sit below it in all, and how many of those
 * are new - a folded reply says so on its "▸ N replies" line, so nothing new is hidden silently.
 */
export interface ReplyNode {
  readonly entry: ActivityEntry;
  readonly children: readonly ReplyNode[];
  readonly size: number;
  readonly fresh: number;
}

/**
 * The replies of a thread as a tree. A reply hangs under the reply it was written to ({@code answers}); a reply to the
 * thread's first comment, an older reply (written before the backend kept it) or one whose reply is gone hangs under
 * the first comment. Children keep their time order.
 */
export function replyTree(replies: readonly ActivityEntry[], newSince: string | null): ReplyNode[] {
  const ids = new Set(replies.map((r) => r.id));
  const kids = new Map<number | null, ActivityEntry[]>();
  for (const r of [...replies].sort((a, b) => a.id - b.id)) {
    // a reply answers an earlier entry; anything else (a reply that is gone, a bad id) hangs under the first comment
    const parent = r.answers != null && r.answers < r.id && ids.has(r.answers) ? r.answers : null;
    (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(r);
  }
  const seen = new Set<number>();
  const build = (parent: number | null): ReplyNode[] => (kids.get(parent) ?? []).filter((e) => !seen.has(e.id) && seen.add(e.id)).map((entry) => {
    const children = build(entry.id);
    return { entry, children, size: children.reduce((n, c) => n + 1 + c.size, 0),
      fresh: children.reduce((n, c) => n + (isNewEntry(c.entry, newSince) ? 1 : 0) + c.fresh, 0) };
  });
  return build(null);
}

/** The replies on the way to an entry in a thread's tree (its parents, nearest last), not the entry itself. */
export function pathTo(replies: readonly ActivityEntry[], id: number): number[] {
  const byId = new Map(replies.map((r) => [r.id, r]));
  const out: number[] = [];
  let at = byId.get(id);
  while (at && at.answers != null && at.answers < at.id && byId.has(at.answers)) {
    out.unshift(at.answers);
    at = byId.get(at.answers);
  }
  return out;
}
