import { AlfredError, seg, type AlfredClient } from './alfred-client.ts';
import type { BoardRow } from './board-scope.ts';

/**
 * How a board is named in a command (specs/030 FR-009): its id, `AB#1234` / `<conn>/1234` / the item's URL (the board
 * whose MAIN item that is), or its name (exact, then a unique prefix). A bare `#12` is a card number, never a board.
 */
export interface BoardSummaryRow {
  readonly board: BoardRow & { readonly migratedFrom?: string | null; readonly createdAt?: string };
  readonly cards: number;
  readonly cycleIds: readonly string[];
  readonly boardIds: readonly string[];
  /** The main item as "<conn>/<id>", or null. */
  readonly linkedItem: string | null;
}

export type BoardRef = { readonly board: BoardSummaryRow } | { readonly candidates: readonly BoardSummaryRow[] } | null;

const CARD_NUMBER = /^#\d+$/;
const ITEM_URL = /_workitems\/edit\/(\d+)/i;

/** The work item a ref names (`AB#1234`, `c1/1234`, an Azure URL), or null when it names none. */
export function itemOfRef(ref: string): { conn: string | null; id: string } | null {
  const r = ref.trim();
  const ab = /^AB#(\d+)$/i.exec(r);
  if (ab) return { conn: null, id: ab[1] };
  const url = ITEM_URL.exec(r);
  if (url) return { conn: null, id: url[1] };
  const conn = /^([A-Za-z0-9_-]+)\/(\d+)$/.exec(r);
  if (conn) return { conn: conn[1], id: conn[2] };
  return null;
}

async function allBoards(client: AlfredClient): Promise<BoardSummaryRow[]> {
  return client.get<BoardSummaryRow[]>('/board/boards', { query: { state: 'OPEN,DONE' } });
}

/**
 * The board a ref names; `candidates` when several match (ask the user); null when nothing matches as a board (the
 * caller may still read it as a cycle). Throws for a bare card number.
 */
export async function resolveBoard(client: AlfredClient, ref: string): Promise<BoardRef> {
  const r = ref.trim();
  if (CARD_NUMBER.test(r)) {
    throw new AlfredError('invalid', `"${r}" is a card number, not a board - name the board by AB#<item id>, its name or its id (board_boards)`);
  }
  try {
    return { board: await client.get<BoardSummaryRow>(`/board/boards/${seg(r)}`) };
  } catch (e) {
    if (!(e instanceof AlfredError) || e.kind !== 'not_found') throw e;
  }
  const item = itemOfRef(r);
  const boards = await allBoards(client).catch(() => [] as BoardSummaryRow[]);
  if (item) {
    const hits = boards.filter((b) => b.linkedItem !== null
      && (item.conn ? b.linkedItem === `${item.conn}/${item.id}` : b.linkedItem.endsWith('/' + item.id)));
    if (hits.length === 1) return { board: hits[0] };
    if (hits.length > 1) return { candidates: hits };
    throw new AlfredError('not_found', `No board has ${r} as its main item - make one from the item in the Team tab (New board), then name it again`);
  }
  const needle = r.toLowerCase();
  const exact = boards.filter((b) => b.board.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return { board: exact[0] };
  if (exact.length > 1) return { candidates: exact };
  const prefix = boards.filter((b) => b.board.name.toLowerCase().startsWith(needle));
  if (prefix.length === 1) return { board: prefix[0] };
  if (prefix.length > 1) return { candidates: prefix };
  return null;
}

/** "AB#1234" when the board has a main item, else its name - how the skills and the stage strip name it. */
export function boardRefText(b: BoardSummaryRow): string {
  const id = b.linkedItem?.split('/').pop();
  return id ? `AB#${id}` : b.board.name;
}

export function candidatesText(ref: string, c: readonly BoardSummaryRow[]): string {
  return `"${ref}" matches ${c.length} boards - ask the user which: `
    + c.map((b) => `${b.board.id} ("${b.board.name}", ${b.board.project}${b.linkedItem ? ', main ' + b.linkedItem : ''})`).join('; ');
}

/** The id of the one board a ref names; an error naming the candidates, or saying none matched. */
export async function boardIdOf(client: AlfredClient, ref: string): Promise<string> {
  const found = await resolveBoard(client, ref);
  if (found && 'candidates' in found) throw new AlfredError('invalid', candidatesText(ref, found.candidates));
  if (!found) throw new AlfredError('not_found', `No board "${ref}" - board_boards lists them (AB#<item id>, a name or an id)`);
  return found.board.board.id;
}
