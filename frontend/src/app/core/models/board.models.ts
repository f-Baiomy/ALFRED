/** The task board (specs/014-task-board): cards, their history and mentions, cycle briefs, spec files and checklist marks. */

export type CardKind = 'BUG' | 'TASK' | 'NOTE' | 'QUESTION';
export type CardStatus = 'INBOX' | 'TO_DO' | 'IN_PROGRESS' | 'FIXED' | 'VERIFIED' | 'DONE' | 'CLOSED';
export type Resolution = 'FINE' | 'NOT_IN_FLOW' | 'WONT_FIX';
export type Flag = 'URGENT' | 'RISK' | 'BLOCKER' | 'AFFECTS_PROJECT' | 'NEEDS_DECISION';
export type Scope = 'NOT_DECIDED' | 'IN_SCOPE' | 'OUT_OF_SCOPE';
export type Actor = 'USER' | 'CLAUDE';
/** Lower-case in text (`@[call:...]`), upper-case in JSON - compare through {@link mentionTypeOf}. */
export type MentionType = 'call' | 'stmt' | 'log' | 'redis' | 'spec' | 'code' | 'cycle' | 'spacer' | 'card' | 'rule';
export type ActivityKind = 'COMMENT' | 'CREATED' | 'STATUS' | 'KIND' | 'SCOPE' | 'FLAGS' | 'RESOLUTION' | 'REASON' | 'TITLE'
  | 'DESCRIPTION' | 'LINK_ADDED' | 'LINK_REMOVED' | 'CYCLE' | 'PROJECT' | 'SPEC_REPLACED' | 'REOPENED' | 'IMPORTED' | 'DELETED'
  | 'PROPOSED' | 'PROPOSAL_ACCEPTED' | 'PROPOSAL_DISMISSED';
export type Mark = 'PASS' | 'FAIL' | 'CANT_TELL';
export type BulkAction = 'FINE' | 'NOT_IN_FLOW' | 'TO_DO' | 'MARK_URGENT';

export const OPEN_STATUSES: readonly CardStatus[] = ['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'DONE'];
export const ALL_STATUSES: readonly CardStatus[] = [...OPEN_STATUSES, 'CLOSED'];
export const KINDS: readonly CardKind[] = ['BUG', 'TASK', 'NOTE', 'QUESTION'];
export const FLAGS: readonly Flag[] = ['URGENT', 'RISK', 'BLOCKER', 'AFFECTS_PROJECT', 'NEEDS_DECISION'];
export const MENTION_TYPES: readonly MentionType[] = ['call', 'stmt', 'log', 'redis', 'spec', 'code', 'cycle', 'spacer', 'card', 'rule'];

export const STATUS_LABELS: Record<CardStatus, string> = {
  INBOX: 'Inbox', TO_DO: 'To do', IN_PROGRESS: 'In progress', FIXED: 'Fixed', VERIFIED: 'Verified', DONE: 'Done', CLOSED: 'Closed',
};
/** Chips and exports use the full names; buttons use the short ones in {@link RESOLUTION_BUTTONS}. */
export const RESOLUTION_LABELS: Record<Resolution, string> = {
  FINE: 'Fine - not an issue', NOT_IN_FLOW: 'Not in this flow', WONT_FIX: "Won't fix",
};
export const RESOLUTION_BUTTONS: Record<Resolution, string> = { FINE: '✓ Fine', NOT_IN_FLOW: '⊘ Not in flow', WONT_FIX: "✕ Won't fix" };
export const FLAG_LABELS: Record<Flag, string> = {
  URGENT: 'Urgent', RISK: 'Risk', BLOCKER: 'Blocker', AFFECTS_PROJECT: 'Affects project', NEEDS_DECISION: 'Needs decision',
};
export const SCOPE_LABELS: Record<Scope, string> = { NOT_DECIDED: 'Not decided', IN_SCOPE: 'In scope', OUT_OF_SCOPE: 'Out of scope' };
export const MARK_LABELS: Record<Mark, string> = { PASS: '✓ Pass', FAIL: '✗ Fail', CANT_TELL: "? Can't tell" };
export const MENTION_ICONS: Record<MentionType, string> = {
  call: '⇄', stmt: '◆', log: '▤', redis: '⬢', spec: '📄', code: '{ }', cycle: '◷', spacer: '┃', card: '▣', rule: '⚙',
};

export interface MentionRef {
  readonly type: string;
  readonly ref: string;
  readonly label: string;
}

export function mentionTypeOf(ref: MentionRef): MentionType {
  return ref.type.toLowerCase() as MentionType;
}

export interface SimilarClosed {
  readonly number: number;
  readonly title: string;
  readonly resolution: Resolution;
  readonly reason: string | null;
}

export interface CardSummary {
  readonly id: string;
  readonly project: string;
  readonly number: number;
  readonly kind: CardKind;
  readonly title: string;
  readonly status: CardStatus;
  readonly resolution: Resolution | null;
  readonly reason: string | null;
  readonly flags: readonly Flag[];
  readonly scope: Scope;
  readonly author: Actor;
  readonly cycleId: string | null;
  readonly cycleDeleted: boolean;
  readonly signature: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: Actor;
  readonly commentCount: number;
  readonly mentionChips?: readonly MentionRef[];
  readonly similarClosed: SimilarClosed | null;
  /** Claude asking the user to take a step only the user takes (Verified, Done, closing). */
  readonly proposal?: Proposal | null;
  /** Empty in list rows; filled in a detail. */
  readonly description: string;
}

/** Claude's open proposal on a card: accepted, it is taken as the user's own step; dismissed, it is gone. */
export interface Proposal {
  readonly cardId: string;
  readonly status: CardStatus;
  readonly resolution: Resolution | null;
  readonly reason: string;
  readonly evidence: string;
  readonly at: string;
}

export interface CardDetail extends CardSummary {
  readonly links: readonly MentionRef[];
}

export interface CardsPage {
  readonly cards: readonly CardSummary[];
  readonly total: number;
  readonly counts: { readonly open: number; readonly fixed: number; readonly done: number };
}

export interface ActivityEntry {
  readonly id: number;
  readonly cardId: string;
  readonly actor: Actor;
  readonly kind: ActivityKind;
  readonly text: string | null;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly at: string;
}

export interface ActivityPage {
  readonly entries: readonly ActivityEntry[];
  readonly total: number;
}

export interface CallBadge {
  readonly project: string;
  readonly number: number;
  readonly kind: CardKind;
  readonly status: CardStatus;
  readonly resolution: Resolution | null;
  readonly title?: string | null;
}

export interface ClosedReason {
  readonly number: number;
  readonly title: string;
  readonly signature: string | null;
  readonly resolution: Resolution;
  readonly reason: string | null;
}

export interface CycleBrief {
  readonly cycleId: string;
  readonly text: string;
  readonly updatedAt: string | null;
}

export interface SpecFileInfo {
  readonly name: string;
  readonly size: number;
  readonly uploadedAt: string;
}

export interface ChecklistMarkChange {
  readonly mark: Mark;
  readonly actor: Actor;
  readonly at: string;
}

export interface ChecklistMark {
  readonly cycleId: string;
  readonly fileName: string;
  readonly itemKey: string;
  readonly mark: Mark;
  readonly actor: Actor;
  readonly evidence: string;
  readonly history: readonly ChecklistMarkChange[];
  readonly updatedAt: string;
}

export interface ChecklistItem {
  readonly key: string;
  readonly text: string;
  readonly mark: ChecklistMark | null;
  /** The mark Claude suggests, grey until the user accepts it. */
  readonly suggestion?: ChecklistSuggestion | null;
}

export interface ChecklistSuggestion {
  readonly cycleId: string;
  readonly fileName: string;
  readonly itemKey: string;
  readonly mark: Mark;
  readonly evidence: string;
  readonly at: string;
}

export interface ChecklistFile {
  readonly fileName: string;
  readonly items: readonly ChecklistItem[];
}

export interface AgentStatus {
  readonly project: string;
  readonly cycleId: string | null;
  readonly state: 'WATCHING' | 'PAUSED' | 'STOPPED';
  readonly callsChecked: number;
  readonly cardsAdded: number;
  readonly lastCheckAt: string;
  readonly updatedAt: string;
}

export interface BoardAccess {
  readonly editable: boolean;
  readonly reason: string;
  readonly howToEdit: string;
}

export interface NewCard {
  readonly project: string;
  readonly kind: CardKind;
  readonly title: string;
  readonly description?: string;
  readonly flags?: readonly Flag[];
  readonly cycleId?: string | null;
  readonly status?: CardStatus;
  readonly links?: readonly MentionRef[];
}

export interface CardEdit {
  readonly title?: string;
  readonly description?: string;
  readonly kind?: CardKind;
  readonly flags?: readonly Flag[];
  readonly scope?: Scope;
  /** "" removes the card from its cycle. */
  readonly cycleId?: string;
  readonly project?: string;
}

export interface BoardFilters {
  readonly kinds: readonly CardKind[];
  readonly flags: readonly Flag[];
  readonly author: Actor | null;
  readonly scopeNotDecided: boolean;
  readonly q: string;
}

export const NO_FILTERS: BoardFilters = { kinds: [], flags: [], author: null, scopeNotDecided: false, q: '' };

/** A /ws/board message (contracts/websocket.md). */
export type BoardSocketEvent =
  | { readonly type: 'board-changed'; readonly project?: string; readonly cycleId?: string; readonly cardId?: string; readonly what: string }
  | ({ readonly type: 'agent-status' } & AgentStatus);

/** A card unchanged for this long in an open status shows as stale (FR-013). */
export const STALE_AFTER_MS = 5 * 24 * 60 * 60 * 1000;

export function isStale(card: Pick<CardSummary, 'status' | 'updatedAt'>, now: number): boolean {
  return card.status !== 'CLOSED' && card.status !== 'DONE' && now - Date.parse(card.updatedAt) > STALE_AFTER_MS;
}

/** "4 min", "2 h", "6 d" - a card's age on the board. */
export function ageText(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
