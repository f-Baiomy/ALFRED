import { BoardSummary } from '../../core/models/board.models';

/** One board's group in Session Cycles (specs/027 FR-007): the board, its cycles, and per cycle the other boards it is on. */
export interface CycleGroup<C extends { readonly id: string }> {
  /** Null for "Not on any board". */
  readonly board: BoardSummary | null;
  readonly cycles: readonly C[];
  /** Per cycle id: the names of the other boards that cycle is related to ("Also on"). */
  readonly alsoOn: ReadonlyMap<string, readonly string[]>;
}

/**
 * Groups cycles by the boards they are related to, in the cycles' own order: a cycle on two boards appears under both,
 * a cycle on none under the last group, "Not on any board". Default boards come first, then task boards by name; boards
 * with no listed cycle are left out.
 */
export function groupCyclesByBoard<C extends { readonly id: string }>(cycles: readonly C[], boards: readonly BoardSummary[]): CycleGroup<C>[] {
  const boardsOf = new Map<string, BoardSummary[]>();
  for (const b of boards) {
    for (const id of b.cycleIds) {
      const list = boardsOf.get(id) ?? [];
      list.push(b);
      boardsOf.set(id, list);
    }
  }
  const ordered = [...boards].sort((a, b) => Number(b.board.isDefault) - Number(a.board.isDefault) || a.board.name.localeCompare(b.board.name));
  const groups: CycleGroup<C>[] = [];
  for (const b of ordered) {
    const own = cycles.filter((c) => b.cycleIds.includes(c.id));
    if (!own.length) continue;
    const alsoOn = new Map<string, string[]>();
    for (const c of own) {
      alsoOn.set(c.id, (boardsOf.get(c.id) ?? []).filter((o) => o.board.id !== b.board.id).map((o) => o.board.name));
    }
    groups.push({ board: b, cycles: own, alsoOn });
  }
  const loose = cycles.filter((c) => !boardsOf.has(c.id));
  if (loose.length) {
    groups.push({ board: null, cycles: loose, alsoOn: new Map() });
  }
  return groups;
}
