/**
 * Links and streams between Alfreds (specs/035). A link joins this Alfred with another on the LAN; a stream lets the
 * other read one cycle or one board live. Refs to another Alfred's things carry the link's slug: `<id>@<slug>`.
 */

export type StreamKind = 'CYCLE' | 'BOARD';
export type StreamMode = 'VIEW' | 'COMMENT';
export type RequestKind = 'CARD_COMMENT' | 'CARD_QUESTION' | 'BRIEF_COMMENT' | 'CALL_NOTE';
export type RequestState = 'WAITING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'UNDONE' | 'FAILED';

export interface AlfredSelf {
  readonly alfredId: string;
  readonly name: string;
  readonly announce: boolean;
  readonly version: string;
}

export interface LinkInfo {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly peerAlfredId: string;
  readonly peerName: string | null;
  readonly address: string | null;
  readonly dialer: boolean;
  readonly createdAt: string;
  readonly lastSeen: string | null;
  readonly peerVersion: string | null;
  readonly online: boolean;
  readonly rttMs: number | null;
  readonly clockOffsetMs: number | null;
  readonly skewed: boolean;
  readonly lastError: string | null;
  readonly stateSince: string | null;
  readonly inFlight: number;
  readonly streamsOut: number;
  readonly streamsIn: number;
}

export interface Pairing {
  readonly id: string;
  readonly address: string;
  readonly peerAlfredId: string;
  readonly peerName: string;
  readonly code: string;
  readonly name: string;
  readonly state: 'WAITING' | 'LINKED' | 'REJECTED' | 'EXPIRED' | 'FAILED' | 'CANCELLED';
  readonly message: string;
  readonly createdAt: string;
  readonly linkId: string | null;
}

export interface Offer {
  readonly id: string;
  readonly code: string;
  readonly fromAlfredId: string;
  readonly fromName: string;
  readonly fromAddress: string | null;
  readonly fromVersion: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: string;
}

export interface Stream {
  readonly id: string;
  /** True on the owner; the reader keeps a copy (names only). */
  readonly mine: boolean;
  readonly linkId: string;
  readonly kind: StreamKind;
  readonly target: string;
  readonly targetName: string | null;
  readonly project: string | null;
  readonly mode: StreamMode;
  readonly autoAccept: boolean;
  readonly passOn: boolean;
  readonly passMode: StreamMode;
  readonly unmasked: boolean;
  /** A test cycle recorded for an environment (D38): its name, and the host's board it is for. */
  readonly env: string | null;
  readonly forBoard: string | null;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface StreamIn {
  readonly linkId: string;
  readonly kind: StreamKind;
  readonly target: string;
  readonly targetName: string;
  readonly project: string | null;
  readonly mode: StreamMode;
  readonly autoAccept: boolean;
  readonly passOn: boolean;
  readonly passMode: StreamMode;
  readonly unmasked: boolean;
}

export interface LinkRequest {
  readonly id: string;
  readonly streamId: string;
  readonly linkId: string;
  /** True on the owner (it was asked); false on the reader (it asked). */
  readonly incoming: boolean;
  readonly kind: RequestKind;
  readonly target: string;
  readonly targetLabel: string | null;
  readonly text: string;
  readonly extra: string | null;
  readonly author: string;
  readonly state: RequestState;
  readonly resultRef: string | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
  readonly auto: boolean;
}

export interface SendRequest {
  /** The slug of the link the stream came over. */
  readonly via: string;
  readonly streamId: string;
  readonly kind: RequestKind;
  /** The owner's own id of the card, call or board. */
  readonly target: string;
  readonly targetLabel?: string;
  readonly text: string;
  readonly extra?: string;
}

export interface ReadEntry {
  readonly linkId: string;
  readonly family: string;
  readonly target: string;
  readonly day: string;
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly via: string;
}

export interface Presence {
  readonly linkId: string;
  readonly target: string;
  readonly viewers: number;
  readonly since: string;
}

// ---------------------------------------------------------------------------------------------------- environments

export interface EnvDef {
  readonly boardId: string;
  readonly name: string;
  /** null: this Alfred itself (its board's own marks). */
  readonly linkId: string | null;
  readonly required: boolean;
  readonly ord: number;
}

export interface EnvMark {
  readonly hostLinkId: string | null;
  readonly boardId: string;
  readonly fileName: string;
  readonly itemKey: string;
  readonly mark: 'PASS' | 'FAIL' | 'CANT_TELL';
  readonly evidence: string;
  readonly actor: string;
  readonly at: string | null;
}

export interface EnvStep {
  readonly hostLinkId: string | null;
  readonly boardId: string;
  readonly stepKey: string;
  readonly state: 'SEEN' | 'FAILED';
  readonly note: string | null;
  readonly actor: string;
  readonly at: string | null;
}

export interface EnvRetest {
  readonly hostLinkId: string | null;
  readonly boardId: string;
  readonly cardNumber: number;
  readonly verdict: 'PASS' | 'FAIL' | 'UNKNOWN';
  readonly summary: string | null;
  readonly cycleId: string | null;
  readonly actor: string;
  readonly at: string | null;
}

export interface EnvCycle {
  readonly hostLinkId: string | null;
  readonly boardId: string;
  readonly cycleRef: string;
  readonly env: string;
  readonly name: string | null;
  readonly retestFor: readonly number[];
  readonly at: string;
}

export interface EnvColumn {
  readonly name: string;
  readonly linkId: string | null;
  readonly slug: string | null;
  readonly alfred: string;
  readonly required: boolean;
  /** This Alfred's own column (the board's own marks). */
  readonly here: boolean;
  readonly online: boolean;
  readonly error: string | null;
  readonly marks: readonly EnvMark[];
  readonly steps: readonly EnvStep[];
  readonly retests: readonly EnvRetest[];
  readonly cycles: readonly EnvCycle[];
  readonly verdict: 'PASS' | 'FAIL' | 'WAITING';
  readonly missing: readonly string[];
  readonly asks: EnvAsks;
}

/** What a board asks every environment (D35): its acceptance items, test steps, and the Fixed cards to re-test. */
export interface EnvAsks {
  readonly items: readonly { readonly fileName: string; readonly itemKey: string; readonly text: string | null }[];
  readonly steps: readonly string[];
  readonly fixedCards: readonly number[];
}

export interface EnvBoard {
  readonly boardId: string;
  readonly columns: readonly EnvColumn[];
  readonly overall: 'PASS' | 'FAIL' | 'WAITING' | 'NONE';
  readonly waitingOn: readonly string[];
  readonly failing: readonly string[];
  readonly at: string;
  readonly asks: EnvAsks;
}

export interface EnvAssigned {
  readonly hostLinkId: string;
  readonly hostSlug: string;
  readonly hostName: string;
  readonly hostOnline: boolean;
  readonly boardId: string;
  readonly boardName: string | null;
  readonly project: string | null;
  readonly env: string;
}

/** A /ws/links message. */
export type LinksSocketEvent =
  | { readonly type: 'signal'; readonly slug: string; readonly channel: string; readonly data: Record<string, unknown> }
  | { readonly type: 'links-changed' | 'offers-changed' | 'pairings-changed' | 'streams-changed' | 'requests-changed' | 'presence-changed'
      | 'env-changed' | 'self-changed'; readonly data?: Record<string, unknown> };

/** A failed read of another Alfred's thing, as the backend says it (D21: offline is a state). */
export interface LinkProblem {
  readonly error: string;
  readonly message: string;
  readonly slug?: string;
}
