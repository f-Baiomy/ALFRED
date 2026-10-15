import { ChatSummary, PROJECT_SCOPE, needsYouCount } from '../../core/models/chat.models';

/** How much a chat may interrupt (FR-042): every reply, only Claude's questions and failures, nothing (no unread, no pop-up). */
export type ChatMute = 'all' | 'questions' | 'none';

/** One row of the bar, with what this browser knows: the cycle's name, unread, draft, mute. */
export interface BarRow extends ChatSummary {
  readonly label: string;
  readonly unread: number;
  readonly draft: boolean;
  readonly mute: ChatMute;
}

/** What the bar's rows are built from: the server's summaries plus this viewer's own marks (specs/022 US4). */
export interface BarInput {
  readonly project: string;
  readonly summaries: readonly ChatSummary[];
  /** The cycle open on the page - it gets a row before its chat has a message. */
  readonly inView: string | null;
  /** The newest message seen per `project/scope`. */
  readonly seen: Readonly<Record<string, number>>;
  readonly mute: Readonly<Record<string, ChatMute>>;
  readonly names: ReadonlyMap<string, string>;
  readonly hasDraft: (key: string) => boolean;
  /** How many unread messages a loaded chat holds after `lastSeen` (1 when it is not loaded). */
  readonly unreadIn: (scope: string, lastSeen: number) => number;
}

/** The project chat first, then the cycles newest first; unread only when the last word is not the user's. */
export function barRows(i: BarInput): BarRow[] {
  const rows = [...i.summaries];
  if (i.inView && !rows.some((r) => r.scope === i.inView)) {
    rows.push({ scope: i.inView, name: i.inView, kind: 'cycle', lastId: null, lastAt: null, lastPreview: '', lastAuthor: null, waiting: 0, typing: false,
      needsYou: { questions: 0, proposals: 0, confirms: 0 }, claudeOn: false, terminal: null });
  }
  return rows.map((r) => {
    const key = `${i.project}/${r.scope}`;
    const seen = i.seen[key] ?? 0;
    const unread = r.lastAuthor && r.lastAuthor !== 'USER' && (r.lastId ?? 0) > seen ? Math.max(1, i.unreadIn(r.scope, seen)) : 0;
    return { ...r, label: r.scope === PROJECT_SCOPE ? (i.project || 'No project') : i.names.get(r.scope) ?? r.scope,
      unread, draft: i.hasDraft(key), mute: i.mute[key] ?? 'all' };
  }).sort((a, b) => Number(b.scope === PROJECT_SCOPE) - Number(a.scope === PROJECT_SCOPE) || (b.lastId ?? 0) - (a.lastId ?? 0));
}

/**
 * Whether a new last message of a chat may pop up a notification: never when muted, always at "every reply", and at
 * "questions and failures" only when Claude asks something new or a run failed or was stopped.
 */
export function shouldNotify(row: BarRow, needsBefore: number): boolean {
  if (row.mute === 'none' || row.lastAuthor === 'USER') return false;
  if (row.mute === 'all') return true;
  return needsYouCount(row.needsYou) > needsBefore || (row.lastAuthor === 'ALFRED' && /could not answer|^Stopped/.test(row.lastPreview));
}

/** The tab badge: unread of every chat not muted to nothing. */
export function totalUnread(rows: readonly BarRow[]): number {
  return rows.filter((r) => r.mute !== 'none').reduce((n, r) => n + r.unread, 0);
}

export interface BarSection {
  readonly label: string;
  readonly rows: readonly BarRow[];
}

/** The bar's sections for a search: chats waiting on the user on top (each once), then Project, then Cycles. */
export function barSections(rows: readonly BarRow[], query: string): { needs: BarRow[]; sections: BarSection[] } {
  const q = query.trim().toLowerCase();
  const found = rows.filter((r) => !q || r.label.toLowerCase().includes(q) || r.scope.toLowerCase().includes(q));
  const needs = found.filter((r) => needsYouCount(r.needsYou) > 0);
  const rest = found.filter((r) => !needs.includes(r));
  return { needs, sections: [{ label: 'Project', rows: rest.filter((r) => r.scope === PROJECT_SCOPE) },
    { label: 'Cycles', rows: rest.filter((r) => r.scope !== PROJECT_SCOPE) }] };
}
