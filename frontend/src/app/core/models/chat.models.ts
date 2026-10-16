import { MentionRef } from './board.models';

/**
 * The board chats (specs/022 contracts/rest-api.md): one chat per session cycle (answered by the cycle's own Claude
 * session) and one per project (answered by the project's live runner). `scope` is "project" or the cycle id.
 */
export const PROJECT_SCOPE = 'project';

export type ChatAuthor = 'USER' | 'CLAUDE' | 'ALFRED';
export type ChatKind = 'TEXT' | 'SUMMARY' | 'DIGEST' | 'SYSTEM' | 'TASK';
/** A user's message: WAITING → TAKEN → ANSWERED / STOPPED / CANCELLED; everything else DONE. */
export type ChatState = 'WAITING' | 'TAKEN' | 'ANSWERED' | 'STOPPED' | 'CANCELLED' | 'DONE';

export interface ChatQuestion {
  readonly id: string;
  readonly text: string;
  readonly options?: readonly string[];
  readonly answer?: string | null;
}

export interface ChatProposal {
  readonly id: string;
  /** what accepting does, in one line ("move #7 to To do", "add AC to spec.md") */
  readonly text: string;
  readonly kind?: string;
  /** null while open; applied / declined / outdated once handled */
  readonly state?: 'applied' | 'declined' | 'outdated' | null;
  readonly why?: string | null;
}

/** A resend or a rule Claude asks to run - nothing runs without the user's yes (FR-035). */
export interface ChatConsent {
  readonly kind: string;
  readonly summary: string;
  readonly payload?: unknown;
  readonly decided?: 'yes' | 'no' | null;
}

/** What Claude sent beside the text: questions, proposals, a consent, a fix report, a visual ... */
export interface ChatExtra {
  readonly questions?: readonly ChatQuestion[];
  readonly proposals?: readonly ChatProposal[];
  readonly consent?: ChatConsent;
  readonly [key: string]: unknown;
}

export interface ChatMessage {
  readonly id: number;
  readonly project: string;
  readonly scope: string;
  readonly parentId: number | null;
  readonly author: ChatAuthor;
  readonly kind: ChatKind;
  readonly text: string;
  readonly state: ChatState;
  readonly urgent: boolean;
  readonly decision: boolean;
  /** typed, ask-item, skill:/alfred-x, digest, watch, bridge, listen, asked-again */
  readonly origin: string | null;
  /** "looking at" refs as mention tokens */
  readonly context: readonly string[];
  readonly quote: string | null;
  readonly extra: ChatExtra | null;
  readonly reactions: Readonly<Record<string, number>>;
  /** a SUMMARY: the last message it covers - everything up to it folds under it */
  readonly coversTo: number | null;
  /** Claude's answer: the user message it answers */
  readonly replyTo: number | null;
  /** "project" when asked from the project chat (shown in both) */
  readonly bridgeFrom: string | null;
  readonly superseded: boolean;
  readonly createdAt: string;
  readonly editedAt: string | null;
  /** the automatic records this message made (FR-048) */
  readonly records?: readonly ChatRecord[];
}

export interface ChatPage {
  readonly messages: readonly ChatMessage[];
  readonly more: boolean;
}

export type ChatRecordKind = 'DECISION' | 'CARD' | 'ITEM' | 'FIX' | 'NEXT';

export interface ChatRecord {
  readonly id: number;
  readonly messageId: number;
  readonly kind: ChatRecordKind;
  readonly target: string | null;
  /** what the chat shows: "recorded the decision … in the brief" */
  readonly line: string;
  readonly createdAt: string;
  readonly undoneAt: string | null;
}

export type TerminalItemState = 'WAITING' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'UNDONE';

/** Something the chat sent its terminal session (FR-050, FR-051): a mirrored exchange, or an urgent item. */
export interface TerminalItem {
  readonly id: number;
  readonly project: string;
  readonly scope: string;
  readonly messageId: number | null;
  readonly urgent: boolean;
  readonly mirror: boolean;
  readonly text: string;
  /** exchange, contradicts, changed-files, addressed, compact */
  readonly reason: string | null;
  readonly state: TerminalItemState;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
}

export interface ChatNeedsYou {
  readonly questions: number;
  readonly proposals: number;
  readonly confirms: number;
}

/** A cycle chat's session as the runner keeps it: a copy (fork) of the terminal session, on `host`. */
export interface ChatTerminal {
  readonly open: boolean;
  readonly forkAt: string | null;
  readonly seenUpTo: string | null;
  readonly terminalAt: string | null;
  readonly host?: string | null;
  readonly chatSessionId?: string | null;
  readonly forkedFrom?: string | null;
  /** The terminal session itself answers (no copy): nothing to catch up, nothing mirrored back. */
  readonly answeredByTerminal?: boolean;
}

/** One row of the chats bar. */
export interface ChatSummary {
  readonly scope: string;
  readonly name: string;
  readonly kind: 'project' | 'cycle';
  readonly lastId: number | null;
  readonly lastAt: string | null;
  readonly lastPreview: string;
  readonly lastAuthor: ChatAuthor | null;
  readonly waiting: number;
  readonly typing: boolean;
  readonly needsYou: ChatNeedsYou;
  readonly claudeOn: boolean;
  readonly terminal: ChatTerminal | null;
}

/** A "tell me when" watch (FR-031): it posts once when its event comes, then ends. */
export interface ChatWatch {
  readonly id: number;
  readonly project: string;
  readonly scope: string;
  readonly kind: 'ITEM_PASSES' | 'STATUS' | 'ERROR_LOG';
  readonly target: string;
  readonly label: string;
  readonly messageId: number | null;
  readonly createdAt: string;
}

export interface ChatSettings {
  /** auto-compact after this many messages since the last summary; 0 = off, else 20..1000 */
  readonly autoN: number;
  /** the digest shows after this many minutes away (5..600) */
  readonly digestGapMin: number;
  readonly watching: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { autoN: 100, digestGapMin: 30, watching: false };

export interface NewChatMessage {
  readonly text: string;
  readonly parentId?: number | null;
  readonly context?: readonly MentionRef[];
  readonly quote?: string | null;
  readonly urgent?: boolean;
  readonly origin?: string;
  readonly imageIds?: readonly string[];
}

export type ChatSearchFilter = 'all' | 'mine' | 'claude' | 'decisions' | 'calls';

export interface ChatSearchHit {
  readonly id: number;
  readonly parentId: number | null;
  readonly folded: boolean;
}

export interface ChatSharedGroup {
  readonly type: string;
  readonly refs: readonly { readonly mention: MentionRef; readonly messageId: number; readonly at: string }[];
}

export interface ProposalOutcome {
  readonly results: Readonly<Record<string, string>>;
  readonly undoToken: string | null;
}

export interface AskAgain {
  readonly logs?: boolean;
  readonly sql?: boolean;
  readonly items?: boolean;
  readonly text?: string;
}

/** Where the open conversation sits (FR-017): beside the bar, wider, the whole page, or its own window. */
export type ChatView = 'docked' | 'expanded' | 'full' | 'window';

/** A chat is named by its scope; the bar shows a cycle by its name. */
export function isProjectScope(scope: string): boolean {
  return scope === PROJECT_SCOPE;
}

/** Messages folded under a summary: every one up to the newest summary's `coversTo`, never the summaries themselves. */
export function foldedIds(messages: readonly ChatMessage[]): ReadonlySet<number> {
  let covers = 0;
  for (const m of messages) if (m.kind === 'SUMMARY' && m.coversTo != null && m.coversTo > covers) covers = m.coversTo;
  return new Set(messages.filter((m) => m.kind !== 'SUMMARY' && m.id <= covers).map((m) => m.id));
}

export function needsYouCount(n: ChatNeedsYou): number {
  return n.questions + n.proposals + n.confirms;
}
