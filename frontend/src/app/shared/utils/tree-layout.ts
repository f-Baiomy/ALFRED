import { BoardItem } from '../../core/team/team.models';

/** One line of a board's Related items tree. */
export interface TreeLine {
  readonly item: BoardItem;
  /** Indent steps from the left. */
  readonly indent: number;
  /** tree: the main's ancestors, the main and its descendants; link: one hop of other links; added: added by hand or
   *  left the tree (no place in it any more). */
  readonly group: 'tree' | 'link' | 'added';
}

/**
 * Lays out a board's related items as a tree around its main (specs/028 US2): ancestors above it (depth < 0), the main,
 * its descendants under their parents in depth-first order, then the main's other links, then everything with no place
 * in the tree (added by hand, or left it). An item is listed once.
 */
export function layoutTree(main: BoardItem | null, items: readonly BoardItem[]): TreeLine[] {
  const all = main && !items.some((i) => same(i, main)) ? [main, ...items] : [...items];
  const out: TreeLine[] = [];
  const placed = new Set<string>();
  const key = (i: BoardItem) => i.row.conn + '/' + i.row.item;
  const put = (i: BoardItem, indent: number, group: TreeLine['group']) => {
    if (placed.has(key(i))) return;
    placed.add(key(i));
    out.push({ item: i, indent, group });
  };
  const root = main ? all.find((i) => same(i, main)) ?? main : null;
  const inTree = (i: BoardItem) => !i.row.leftTreeAt;
  if (root) {
    const ancestors = all.filter((i) => i.row.relation === 'ANCESTOR' && inTree(i)).sort((a, b) => a.row.depth - b.row.depth);
    const top = ancestors.length ? ancestors[0].row.depth : 0;
    for (const a of ancestors) put(a, a.row.depth - top, 'tree');
    const rootIndent = -top;
    put(root, rootIndent, 'tree');
    const children = new Map<string, BoardItem[]>();
    for (const d of all.filter((i) => i.row.relation === 'DESCENDANT' && inTree(i))) {
      const p = d.row.parent ?? root.row.item;
      children.set(p, [...(children.get(p) ?? []), d]);
    }
    const walk = (parent: string, indent: number) => {
      const kids = (children.get(parent) ?? []).sort((a, b) => Number(a.row.item) - Number(b.row.item) || a.row.item.localeCompare(b.row.item));
      for (const k of kids) {
        if (placed.has(key(k))) continue;
        put(k, indent, 'tree');
        walk(k.row.item, indent + 1);
      }
    };
    walk(root.row.item, rootIndent + 1);
    for (const l of all.filter((i) => i.row.relation === 'LINK' && inTree(i))) put(l, rootIndent + 1, 'link');
  }
  for (const rest of all) put(rest, 0, 'added');
  return out;
}

/** Groups items by their work item type (the "By type" view), types sorted, the main first in its type. */
export function byType(items: readonly BoardItem[]): { type: string; items: BoardItem[] }[] {
  const groups = new Map<string, BoardItem[]>();
  for (const i of items) {
    const t = i.row.type || 'Other';
    groups.set(t, [...(groups.get(t) ?? []), i]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([type, list]) => ({ type, items: list.sort((a, b) => Number(b.row.role === 'MAIN') - Number(a.row.role === 'MAIN')) }));
}

function same(a: BoardItem, b: BoardItem): boolean {
  return a.row.conn === b.row.conn && a.row.item === b.row.item;
}
