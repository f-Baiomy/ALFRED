/**
 * Multi-select of log lines (FR-039): click toggles, shift-click selects the range between the last
 * picked row and this one in on-screen order, and "all matching" is kept as a query plus exceptions
 * so a selection of millions never ships millions of ids.
 */
export interface Selection {
  readonly ids: ReadonlySet<string>;
  readonly lastPick: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), lastPick: null };

export function toggle(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, lastPick: id };
}

/** Adds every row between the last pick and {@code id}, in the order rows are shown. */
export function selectRange(sel: Selection, id: string, order: readonly string[]): Selection {
  const from = sel.lastPick ? order.indexOf(sel.lastPick) : -1;
  const to = order.indexOf(id);
  if (from < 0 || to < 0) return toggle(sel, id);
  const ids = new Set(sel.ids);
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) ids.add(order[i]);
  return { ids, lastPick: id };
}

export function selectAll(sel: Selection, order: readonly string[]): Selection {
  const allIn = order.length > 0 && order.every((id) => sel.ids.has(id));
  const ids = new Set(sel.ids);
  order.forEach((id) => (allIn ? ids.delete(id) : ids.add(id)));
  return { ids, lastPick: sel.lastPick };
}

/** How many selected lines the current result does not show ("N hidden by current filters"). */
export function hiddenCount(sel: Selection, visible: ReadonlySet<string>, visibleIsComplete: boolean): number {
  if (!visibleIsComplete) return 0;
  let n = 0;
  sel.ids.forEach((id) => {
    if (!visible.has(id)) n++;
  });
  return n;
}

/** Header checkbox state for the rows on screen. */
export function headerState(sel: Selection, order: readonly string[]): 'all' | 'some' | 'none' {
  const n = order.filter((id) => sel.ids.has(id)).length;
  return n === 0 ? 'none' : n === order.length ? 'all' : 'some';
}
