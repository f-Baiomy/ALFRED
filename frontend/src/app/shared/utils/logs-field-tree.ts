import { FieldDef } from '../../core/models/logs.model';

/**
 * Things with dotted paths grouped like folders: `message` → `context`, `body` → `supplier`, ... Used
 * for a structure's fields (structure editor) and for one line's values (its Table view). A chain of
 * groups with a single child group and nothing of its own is merged into one node
 * (`response.flightBookingRequestBean.onwardFlightOption`), so nobody clicks through five levels.
 */
export interface TreeGroup<T> {
  readonly kind: 'group';
  /** Full path of the group, e.g. `message.body`. */
  readonly key: string;
  /** What the row shows: the group's own (possibly merged) segment(s). */
  readonly name: string;
  readonly children: readonly TreeNode<T>[];
  /** Items anywhere below. */
  readonly count: number;
}

export interface TreeLeaf<T> {
  readonly kind: 'field';
  /** The item's full path. */
  readonly key: string;
  /** The path after the parent group's key. */
  readonly name: string;
  readonly item: T;
}

export type TreeNode<T> = TreeGroup<T> | TreeLeaf<T>;

/** A row to render: the node, its depth and the parent group's path (with a trailing dot). */
export interface TreeRow<T> {
  readonly node: TreeNode<T>;
  readonly depth: number;
  readonly prefix: string;
}

export type FieldTreeNode = TreeNode<FieldDef>;
export type FieldGroup = TreeGroup<FieldDef>;

interface Building<T> {
  groups: Map<string, Building<T>>;
  items: { path: string; item: T }[];
}

export function buildPathTree<T>(items: readonly T[], pathOf: (t: T) => string): TreeNode<T>[] {
  const root: Building<T> = { groups: new Map(), items: [] };
  for (const item of items) {
    const path = pathOf(item);
    const seg = path.split('.');
    let at = root;
    for (const s of seg.slice(0, -1)) {
      if (!at.groups.has(s)) at.groups.set(s, { groups: new Map(), items: [] });
      at = at.groups.get(s)!;
    }
    at.items.push({ path, item });
  }
  return toNodes(root, '');
}

/** A structure's fields as a tree. */
export function buildFieldTree(fields: readonly FieldDef[]): FieldTreeNode[] {
  return buildPathTree(fields, (f) => f.path);
}

function toNodes<T>(b: Building<T>, prefix: string): TreeNode<T>[] {
  const out: TreeNode<T>[] = [];
  for (const [seg, g] of b.groups) {
    let name = seg;
    let cur = g;
    // Merge a chain: a group whose only content is one sub-group.
    while (cur.items.length === 0 && cur.groups.size === 1) {
      const [nextSeg, next] = [...cur.groups.entries()][0];
      name = `${name}.${nextSeg}`;
      cur = next;
    }
    const key = prefix + name;
    const children = toNodes(cur, key + '.');
    if (children.length === 1 && children[0].kind === 'field' && cur.groups.size === 0) {
      // A group holding one item is just that item with a longer name.
      const leaf = children[0];
      out.push({ kind: 'field', key: leaf.key, name: `${name}.${leaf.name}`, item: leaf.item });
      continue;
    }
    out.push({ kind: 'group', key, name, children, count: countItems(children) });
  }
  for (const it of b.items) {
    out.push({ kind: 'field', key: it.path, name: it.path.slice(prefix.length), item: it.item });
  }
  // Groups first, then items - each in path order - so a level reads like a folder listing.
  return out.sort((a, c) => (a.kind === c.kind ? a.name.localeCompare(c.name) : a.kind === 'group' ? -1 : 1));
}

function countItems<T>(nodes: readonly TreeNode<T>[]): number {
  return nodes.reduce((n, x) => n + (x.kind === 'field' ? 1 : x.count), 0);
}

/** Every item below a node (for whole-group actions). */
export function itemsUnder<T>(node: TreeNode<T>): T[] {
  return node.kind === 'field' ? [node.item] : node.children.flatMap((c) => itemsUnder(c));
}

export const fieldsUnder = itemsUnder<FieldDef>;

/** Every group key, for "Expand all". */
export function groupKeys<T>(nodes: readonly TreeNode<T>[]): string[] {
  return nodes.flatMap((n) => (n.kind === 'group' ? [n.key, ...groupKeys(n.children)] : []));
}

/**
 * The visible rows: a group shows its children when `isOpen(key)`. With a `filter`
 * (case-insensitive, on the full path and `extra` text), only matching items and the groups leading
 * to them are shown - all of them open.
 */
export function visibleRows<T>(
  nodes: readonly TreeNode<T>[],
  open: ReadonlySet<string> | ((key: string) => boolean),
  filter = '',
  extra: (t: T) => string = () => '',
): TreeRow<T>[] {
  const q = filter.trim().toLowerCase();
  const isOpen = typeof open === 'function' ? open : (k: string) => open.has(k);
  const matches = (n: TreeNode<T>): boolean =>
    n.kind === 'field' ? n.key.toLowerCase().includes(q) || extra(n.item).toLowerCase().includes(q) : n.children.some(matches);
  const rows: TreeRow<T>[] = [];
  const walk = (list: readonly TreeNode<T>[], depth: number, prefix: string): void => {
    for (const n of list) {
      if (q && !matches(n)) continue;
      rows.push({ node: n, depth, prefix });
      if (n.kind === 'group' && (q || isOpen(n.key))) walk(n.children, depth + 1, n.key + '.');
    }
  };
  walk(nodes, 0, '');
  return rows;
}
