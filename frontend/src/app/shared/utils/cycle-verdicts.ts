import { BoardMarks, CallResult, CallVerdicts } from '../../core/models/board.models';

/**
 * The shared-cycle verdicts table (specs/027 US3, mock §Shared cycle): one column per related board, each cell the worst
 * result that board's items gave the call. Pure, so the dialog only renders.
 */
const WORST: readonly CallResult[] = ['CONTRADICTS', 'WRONG', 'NO_DATA', 'UNKNOWN', 'MEETS', 'SKIPPED'];

export interface VerdictCell {
  readonly result: CallResult | null;
  readonly items: number;
  readonly tone: 'bad' | 'warn' | 'ok' | 'none';
  readonly text: string;
}

const TEXT: Record<CallResult, string> = {
  CONTRADICTS: 'missing', WRONG: 'wrong', NO_DATA: 'no data', UNKNOWN: 'unknown', MEETS: 'met', SKIPPED: '-',
};

export function cellFor(call: CallVerdicts, boardId: string): VerdictCell {
  const marks = call.boards.find((b) => b.boardId === boardId)?.items ?? [];
  const results: CallResult[] = marks.map((m) => m.result).filter((r) => r !== 'SKIPPED');
  if (!results.length) return { result: null, items: 0, tone: 'none', text: '' };
  const worst = WORST.find((w) => results.includes(w)) ?? results[0];
  const tone = worst === 'CONTRADICTS' || worst === 'WRONG' ? 'bad' : worst === 'MEETS' ? 'ok' : 'warn';
  return { result: worst, items: results.length, tone, text: TEXT[worst] + (results.length > 1 ? ` ·${results.length}` : '') };
}

/** Rows to show: every call, or only those where {@code boardId} has a verdict or a card homed on it. */
export function rowsFor(calls: readonly CallVerdicts[], boardId: string | null): readonly CallVerdicts[] {
  if (!boardId) return calls;
  return calls.filter((c) => cellFor(c, boardId).result !== null || c.cards.some((k) => k.home === boardId));
}

/** The column order: the board asked about first, then the others as the server listed them. */
export function columnsFor(boards: readonly BoardMarks[], first: string | null): readonly BoardMarks[] {
  if (!first) return boards;
  return [...boards.filter((b) => b.boardId === first), ...boards.filter((b) => b.boardId !== first)];
}
