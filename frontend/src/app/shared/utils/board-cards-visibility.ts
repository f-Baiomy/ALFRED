/**
 * Where a card lives, seen from the board being looked at (specs/027 US2, mock §Board): a card has one home board; on
 * any other board it shows only through a relation (a shared cycle, a related cycle, a related board), drawn dashed with
 * "home: <board>". With no board picked (All cards) every card is shown as its own.
 */
export interface CardPlacement {
  /** True when the card's home is the board being looked at (or no board is picked). */
  readonly own: boolean;
  /** The card's home board id, when it is not the board being looked at. */
  readonly homeId: string | null;
}

export function placementOf(card: { readonly boardId?: string | null }, viewBoard: string | null): CardPlacement {
  const home = card.boardId ?? null;
  if (!viewBoard || !home || home === viewBoard) return { own: true, homeId: null };
  return { own: false, homeId: home };
}

/** "home: Refund flow" for a card seen through a relation, null for an own card. An unknown board shows its short id. */
export function homeLabel(placement: CardPlacement, names: ReadonlyMap<string, string>): string | null {
  if (placement.own || !placement.homeId) return null;
  const id = placement.homeId;
  const name = names.get(id) ?? (id.startsWith('default:') ? id.slice('default:'.length) : id.slice(0, 8));
  return 'home: ' + name;
}
