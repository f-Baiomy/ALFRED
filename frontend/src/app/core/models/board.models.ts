/** The task board (specs/014-task-board): cards, their history and mentions, cycle briefs, spec files and checklist marks. */

export type CardKind = 'BUG' | 'TASK' | 'NOTE' | 'QUESTION';
export type CardStatus = 'INBOX' | 'TO_DO' | 'IN_PROGRESS' | 'FIXED' | 'VERIFIED' | 'DONE' | 'CLOSED';
export type Resolution = 'FINE' | 'NOT_IN_FLOW' | 'WONT_FIX' | 'DUPLICATE';
/** Who a card waits on (specs/015): the user, Claude, a re-test, or nobody. */
export type Waiting = 'USER' | 'CLAUDE' | 'RETEST' | 'NONE';
export type Flag = 'URGENT' | 'RISK' | 'BLOCKER' | 'AFFECTS_PROJECT' | 'NEEDS_DECISION';
export type Scope = 'NOT_DECIDED' | 'IN_SCOPE' | 'OUT_OF_SCOPE';
export type Actor = 'USER' | 'CLAUDE';
/** Lower-case in text (`@[call:...]`), upper-case in JSON - compare through {@link mentionTypeOf}. */
export type MentionType = 'call' | 'stmt' | 'log' | 'redis' | 'spec' | 'code' | 'cycle' | 'spacer' | 'card' | 'rule';
export type ActivityKind = 'COMMENT' | 'CREATED' | 'STATUS' | 'KIND' | 'SCOPE' | 'FLAGS' | 'RESOLUTION' | 'REASON' | 'TITLE'
  | 'DESCRIPTION' | 'LINK_ADDED' | 'LINK_REMOVED' | 'CYCLE' | 'PROJECT' | 'SPEC_REPLACED' | 'REOPENED' | 'IMPORTED' | 'DELETED'
  | 'PROPOSED' | 'PROPOSAL_ACCEPTED' | 'PROPOSAL_DISMISSED' | 'MERGED' | 'BLOCKED' | 'UNBLOCKED' | 'SPEC_ITEM' | 'TEAMS'
  /** Rich text (docs/board.md "Rich text"): a reaction on a comment (text = the emoji, replyTo = the comment), and the user's edit of one. */
  | 'REACTION' | 'COMMENT_EDITED';
export type Mark = 'PASS' | 'FAIL' | 'CANT_TELL';
export type BulkAction = 'FINE' | 'NOT_IN_FLOW' | 'TO_DO' | 'MARK_URGENT' | 'DELETE';

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
  FINE: 'Fine - not an issue', NOT_IN_FLOW: 'Not in this flow', WONT_FIX: "Won't fix", DUPLICATE: 'Duplicate',
};
export const RESOLUTION_BUTTONS: Record<Resolution, string> = { FINE: '✓ Fine', NOT_IN_FLOW: '⊘ Not in flow', WONT_FIX: "✕ Won't fix", DUPLICATE: '⧉ Duplicate' };
export const WAITING_LABELS: Record<Waiting, string> = { USER: 'you', CLAUDE: 'Claude', RETEST: 'a re-test', NONE: 'nobody' };
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
  /** Ids of the teams the card is assigned to (Settings → Teams); several when the fix spans them. */
  readonly teams?: readonly string[];
  readonly commentCount: number;
  readonly mentionChips?: readonly MentionRef[];
  readonly similarClosed: SimilarClosed | null;
  /** Claude asking the user to take a step only the user takes (Verified, Done, closing, a merge, a reopen). */
  readonly proposal?: Proposal | null;
  /** Who the card waits on, and since when (specs/015). */
  readonly waiting?: WaitingOn | null;
  /** Cards this one waits for. */
  readonly blockedBy?: readonly CardRef[];
  /** Empty in list rows; filled in a detail. */
  readonly description: string;
}

export interface WaitingOn {
  readonly who: Waiting;
  readonly since: string;
  readonly setBy: Actor;
}

/** Another card, as a line. */
export interface CardRef {
  readonly project: string;
  readonly number: number;
  readonly title: string;
  readonly status: CardStatus;
}

/** An Acceptance item a card is about; text null when the item is gone. */
export interface SpecItemLink {
  readonly cycleId: string;
  readonly fileName: string;
  readonly itemKey: string;
  readonly text: string | null;
}

/** What one board waits on (the next-step bar). */
export interface NextSteps {
  readonly waitingOnUser: readonly { readonly project: string; readonly number: number; readonly title: string; readonly status: CardStatus;
    readonly why: 'question' | 'proposal' | 'inbox' | 'other'; readonly since: string }[];
  readonly waitingOnClaude: number;
  readonly toDo: number;
  readonly inProgress: number;
  readonly fixed: number;
  readonly inbox: number;
}

export type StepState = 'UNTESTED' | 'SEEN' | 'FAILED';

/** A numbered step under the brief's "Test steps" heading, and what the cycle showed for it. */
export interface TestStep {
  readonly key: string;
  readonly text: string;
  readonly state: StepState;
  readonly calls: number;
  readonly cardNumber: number | null;
  readonly note: string | null;
}

/** One skill run Claude logged on a cycle. */
export interface SessionLogEntry {
  readonly id: number;
  readonly cycleId: string;
  readonly skill: string;
  readonly did: string;
  readonly found: string;
  readonly next: string;
  readonly at: string;
}

/** Claude's open proposal on a card: accepted, it is taken as the user's own step; dismissed, it is gone. */
export interface Proposal {
  readonly cardId: string;
  readonly status: CardStatus;
  readonly resolution: Resolution | null;
  readonly reason: string;
  readonly evidence: string;
  readonly at: string;
  readonly kind?: 'STATUS' | 'MERGE' | 'REOPEN';
  readonly intoNumber?: number | null;
}

export interface CardDetail extends CardSummary {
  readonly links: readonly MentionRef[];
  readonly specItems?: readonly SpecItemLink[];
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
  /** The comment this one answers (one level), or null. */
  readonly replyTo?: number | null;
}

/** An earlier text of a comment or description, kept when it was edited. */
export interface TextVersion {
  readonly owner: string;
  readonly text: string;
  readonly actor: Actor;
  readonly at: string;
}

/** The reactions a comment can get; ✅ on Claude's plan or question is the go-ahead. */
export const REACTIONS: readonly string[] = ['👍', '✅', '🤔', '👀', '🎉', '❌'];

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
  readonly updatedBy?: Actor;
  /** The text the last write replaced is kept - Restore previous. */
  readonly hasPrevious?: boolean;
}

export interface SpecFileInfo {
  readonly name: string;
  readonly size: number;
  readonly uploadedAt: string;
  readonly uploadedBy?: Actor;
  readonly hasPrevious?: boolean;
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
  /** The cards about this item. */
  readonly cards?: readonly CardRef[];
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
  /** What Claude is doing now ("reviewing ODY-482 · 34/120 calls"). */
  readonly step?: string | null;
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
  readonly waiting?: Waiting | null;
  /** Only cards whose cycle was deleted (cleaning up after it). */
  readonly cycleDeleted?: boolean;
  /** Cards of any of these team ids; NO_TEAM for cards with none. */
  readonly teams?: readonly string[];
}

/** The team filter value for cards with no team. */
export const NO_TEAM = '-';

/** A team cards are assigned to (Settings → Teams). `owns` is what Claude reads to pick it; `hints` pre-fill a new card. */
export interface Team {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly icon: string;
  readonly owns: string;
  readonly hints: readonly string[];
  readonly position: number;
}

export interface TeamEdit {
  readonly name: string;
  readonly color: string;
  readonly icon: string;
  readonly owns: string;
  readonly hints: readonly string[];
}

export const NO_FILTERS: BoardFilters = { kinds: [], flags: [], author: null, scopeNotDecided: false, q: '', waiting: null, cycleDeleted: false, teams: [] };

/** board.db on disk (Settings -> Storage -> Board). */
export interface BoardStorage {
  readonly fileBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly cards: number;
  readonly comments: number;
  readonly specFiles: number;
  readonly briefs: number;
  readonly cardsOfDeletedCycles: number;
}

/** A /ws/board message (contracts/websocket.md). */
export type BoardSocketEvent =
  | { readonly type: 'board-changed'; readonly project?: string; readonly cycleId?: string; readonly cardId?: string; readonly what: string }
  | ({ readonly type: 'agent-status' } & AgentStatus)
  | { readonly type: 'live-work'; readonly work: LiveWork }
  | { readonly type: 'live-runner'; readonly project: string; readonly host: string | null; readonly kind: string }
  | { readonly type: 'skill-run'; readonly project: string; readonly id: string; readonly cardNumber?: number; readonly state: SkillRunState }
  | { readonly type: 'cycle-chat'; readonly project: string; readonly cycleId: string };

/** QUEUED for the cycle's chat · SENT into it (waiting for its turn) · RUNNING in it · ended. */
export type SkillRunState = 'QUEUED' | 'SENT' | 'RUNNING' | 'DONE' | 'FAILED' | 'STOPPED' | 'CANCELLED';

/**
 * A skill the user ran from the board with ▶ (docs/board.md "Run from the board"): sent to the Claude Code chat that
 * handles the cycle, run there with that chat's context, and kept as the card's run history.
 */
export interface SkillRun {
  readonly id: string;
  readonly project: string;
  readonly cycleId: string | null;
  readonly cardNumber: number | null;
  readonly command: string;
  readonly prompt: string;
  readonly note: string | null;
  readonly model: string | null;
  readonly host: string | null;
  readonly state: SkillRunState;
  readonly outcome: string | null;
  /** limit, auth, timeout, lost, error */
  readonly failure: string | null;
  readonly retryAt: string | null;
  readonly autoRetry: boolean;
  /** What it wrote: "#36" (a card) or "#35" (on that card). */
  readonly result: string | null;
  readonly steps: readonly string[];
  readonly stop: boolean;
  readonly takenBy: string | null;
  readonly createdAt: string;
  readonly takenAt: string | null;
  readonly endedAt: string | null;
  readonly updatedAt: string;
  /** The chat it was sent to. */
  readonly chatId: string | null;
}

export interface SkillRunsPage {
  readonly runs: readonly SkillRun[];
  /** The median duration of each skill's finished runs, e.g. { "/alfred-fix": 38000 }. */
  readonly usualMs: Readonly<Record<string, number>>;
}

/** The Claude Code chat that handles a cycle: it runs /alfred-live and/or /alfred-listen for it, and every ▶ goes into it. */
export interface CycleChat {
  readonly project: string;
  readonly cycleId: string;
  readonly chatId: string;
  readonly host: string;
  /** The app's repo the chat runs in. */
  readonly cwd: string | null;
  /** "live", "listen" */
  readonly kinds: readonly string[];
  /** The chat's process still runs (its runner checks); false → the board says the chat seems closed. */
  readonly chatAlive: boolean;
  readonly since: string;
  readonly lastSeen: string;
}

/** GET /board/cycle-chat: the cycle's chat, and the repo folder the project's last chat ran in (for the start steps). */
export interface CycleChatInfo {
  readonly chat: CycleChat | null;
  readonly lastCwd: string | null;
}

export interface SkillRunRequest {
  readonly project: string;
  readonly cycleId?: string | null;
  readonly cardNumber?: number | null;
  readonly command: string;
  readonly prompt: string;
  readonly note?: string | null;
}

/**
 * What /alfred-live is doing on one card right now (docs/board.md "Live answers"): the heading, each step as it
 * happens, the reply as it is written, and how it ended. In memory on the backend; never a record.
 */
export interface LiveWork {
  readonly id: string;
  readonly project: string;
  readonly cardNumber: number;
  readonly head: string;
  readonly steps: readonly string[];
  readonly draft: string | null;
  readonly state: 'WORKING' | 'DONE' | 'FAILED' | 'STOPPED';
  readonly outcome: string | null;
  readonly stop: boolean;
  readonly startedAt: string;
  readonly updatedAt: string;
}

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

// ------------------------------------------------------------------------------------------------ re-test (specs/016)

export type ExpectationKind = 'SQL_COUNT' | 'STATUS' | 'NO_LOG' | 'DURATION' | 'SAME_RESPONSE';

/** What "fixed" means for a card, checked by Alfred on every call to its endpoint after the fix. */
export interface Expectation {
  readonly kind: ExpectationKind;
  readonly table?: string | null;
  readonly max?: number | null;
  readonly range?: string | null;
  readonly level?: 'ERROR' | 'WARN' | null;
  readonly minCalls?: number | null;
  readonly path?: string | null;
}

export interface RetestStep {
  readonly text: string;
  readonly endpoint?: string | null;
}

export interface RetestPlan {
  readonly cardId: string;
  readonly expectations: readonly Expectation[];
  readonly steps: readonly RetestStep[];
  readonly updatedBy: Actor | null;
  readonly updatedAt: string | null;
}

export type RetestVerdict = 'PASSES' | 'PARTIAL' | 'FLAKY' | 'FAILS' | 'NO_CALLS' | 'NOT_CHECKABLE';
export type RetestOutcome = 'PASS' | 'FAIL' | 'UNKNOWN' | 'WAITING';

export interface RetestResult {
  readonly text: string;
  readonly expectation: Expectation;
  readonly outcome: RetestOutcome;
  readonly before: string | null;
  readonly after: readonly string[];
  readonly note: string | null;
}

export interface RetestCheck {
  readonly number: number;
  readonly project: string;
  readonly title: string;
  readonly status: CardStatus;
  readonly since: string | null;
  readonly verdict: RetestVerdict;
  readonly statusOnly: boolean;
  readonly summary: string;
  readonly results: readonly RetestResult[];
  readonly calls: readonly { readonly ref: string; readonly label: string; readonly at: string | null; readonly passed: boolean; readonly failed: string | null }[];
  readonly steps: readonly { readonly text: string; readonly endpoint: string | null; readonly seen: boolean; readonly calls: number }[];
  readonly newBuild: boolean;
}

export interface RetestRun {
  readonly id: number;
  readonly at: string;
  readonly actor: Actor;
  readonly source: string;
  readonly verdict: RetestVerdict;
  readonly calls: number;
  readonly summary: string;
}

export interface RetestReport {
  readonly at: string;
  readonly source: string;
  readonly checks: readonly RetestCheck[];
  readonly markdown: string;
}

export interface CardRetest {
  readonly plan: RetestPlan;
  readonly check: RetestCheck;
  readonly history: readonly RetestRun[];
  readonly lastStart: string | null;
}

/** The chip on a card: "✓ passes · 3 calls", "✗ fails · …", with its look. */
export function retestChip(c: RetestCheck): { readonly text: string; readonly tone: 'pass' | 'fail' | 'part' | 'wait' } {
  const guard = c.status === 'VERIFIED' || c.status === 'DONE';
  switch (c.verdict) {
    case 'PASSES': return { text: guard ? `🛡 guarded · ${c.calls.length} calls ok` : `✓ ${c.summary}`, tone: 'pass' };
    case 'FAILS': return { text: guard ? `⚠ guard failed · ${c.summary.replace(/^fails · /, '')}` : `✗ ${c.summary}`, tone: 'fail' };
    case 'FLAKY': return { text: `≈ ${c.summary}`, tone: 'part' };
    case 'PARTIAL': return { text: `◐ ${c.summary}`, tone: 'part' };
    case 'NO_CALLS': return { text: guard ? '🛡 guarded · no calls since' : c.newBuild ? '⟳ new build · ready to re-test' : `… ${c.summary}`, tone: 'wait' };
    default: return { text: `? ${c.summary}`, tone: 'wait' };
  }
}

/** Expectations Alfred suggests for a card, from what it is about (specs/016 FR-9). */
export function suggestExpectations(card: Pick<CardSummary, 'kind' | 'title'> & { readonly signature?: string | null }): Expectation[] {
  const title = card.title;
  const out: Expectation[] = [];
  const table = /\b([A-Z][A-Z0-9_]{3,})\b/.exec(title)?.[1] ?? null;
  if (/n\+1|queries|query per|statements/i.test(title)) out.push({ kind: 'SQL_COUNT', table, max: 3 });
  if (/slow|\d+(\.\d+)?\s*s\b|ms\b|timeout|takes/i.test(title)) out.push({ kind: 'DURATION', max: 1000, minCalls: 3 });
  const status = /\b([45]\d\d)\b/.exec(title)?.[1];
  if (status) out.push({ kind: 'STATUS', range: `!${status}` });
  if (card.kind === 'BUG' || /error|exception|fails|500/i.test(title)) out.push({ kind: 'NO_LOG', level: 'ERROR' });
  if (!out.some((e) => e.kind === 'STATUS')) out.push({ kind: 'STATUS', range: '2xx' });
  return out;
}

/** One line for an expectation, as the backend writes it. */
export function expectationText(e: Expectation): string {
  switch (e.kind) {
    case 'SQL_COUNT': return `≤ ${e.max} ${e.max === 1 ? 'query' : 'queries'}${e.table ? ` on ${e.table}` : ' in all'}`;
    case 'STATUS': return e.range?.startsWith('!') ? `Status not ${e.range.slice(1)}` : `Status ${e.range}`;
    case 'NO_LOG': return e.level === 'WARN' ? 'No WARN or ERROR log line' : 'No ERROR log line';
    case 'DURATION': return `Under ${e.max} ms (${e.minCalls ?? 3} calls)`;
    case 'SAME_RESPONSE': return `Response ${e.path} the same as before the fix`;
  }
}
