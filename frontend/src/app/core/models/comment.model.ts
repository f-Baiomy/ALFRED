/**
 * The four Flat-view panels a call renders, plus 'call': a note on the call as a whole (no line - its
 * lineIndex is 0 and lineText empty), shown on the card and first in the exports' Flagged Issues.
 * Kept as a union rather than a free string so a typo can't silently create an orphaned comment block.
 */
export type CommentBlock = 'call' | 'request-headers' | 'request-body' | 'response-headers' | 'response-body';

export const COMMENT_BLOCK_LABELS: Record<CommentBlock, string> = {
  call: 'Whole Call',
  'request-headers': 'Request Headers',
  'request-body': 'Request Body',
  'response-headers': 'Response Headers',
  'response-body': 'Response Body',
};

/** A flagged issue on one line of a call's request/response - shown in the UI gutter and included in exports. */
export interface Comment {
  readonly id: string;
  readonly callId: string;
  readonly block: CommentBlock;
  readonly lineIndex: number;
  readonly lineText: string;
  readonly comment: string;
  readonly createdAt: string;
}

export interface NewComment {
  readonly callId: string;
  readonly block: CommentBlock;
  readonly lineIndex: number;
  readonly lineText: string;
  readonly comment: string;
}

/** GET /comments/counts: how many comments one call has, in all and per block - for badges, without loading any text. */
export interface CommentCount {
  readonly total: number;
  readonly byBlock: Readonly<Partial<Record<CommentBlock, number>>>;
}
