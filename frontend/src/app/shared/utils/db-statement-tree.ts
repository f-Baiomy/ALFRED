import { CapturedStatement, StatementTransaction, SupplierMarker } from '../../core/models/db-capture.model';

/**
 * The database window's tree (mock: "transactions / repeated queries are parent rows, their statements hang under
 * them"). Input is a call's statements and supplier markers, which share one sequence counter; output is that
 * sequence with:
 *  - each transaction (from its first to its last seq, supplier calls in between included) as a group, and
 *  - each run of the same statement shape repeated at least `repeatThreshold` times in a row as a group, folded at
 *    first ("looks like N+1" / "could be cached").
 * Pure: the window re-runs it whenever a page of statements arrives.
 */

export type DbNode = DbStatementNode | DbSupplierNode | DbGroupNode;

export interface DbStatementNode {
  readonly type: 'stmt';
  readonly seq: number;
  readonly statement: CapturedStatement;
}

export interface DbSupplierNode {
  readonly type: 'supplier';
  readonly seq: number;
  readonly marker: SupplierMarker;
}

export interface DbGroupNode {
  readonly type: 'tx' | 'repeat';
  readonly key: string;
  readonly seq: number;
  readonly children: readonly DbNode[];
  /** Transactions only. */
  readonly tx?: StatementTransaction;
  /** Repeats only: the repeated SQL. */
  readonly sql?: string;
  readonly rolledBack: boolean;
}

export function buildStatementTree(
  statements: readonly CapturedStatement[],
  markers: readonly SupplierMarker[],
  transactions: readonly StatementTransaction[],
  repeatThreshold: number,
): DbNode[] {
  const flat: (DbStatementNode | DbSupplierNode)[] = [
    ...statements.map((s) => ({ type: 'stmt' as const, seq: s.seq, statement: s })),
    ...markers.map((m) => ({ type: 'supplier' as const, seq: m.seq, marker: m })),
  ].sort((a, b) => a.seq - b.seq || (a.type === 'supplier' ? 1 : -1));

  // Every transaction that ran something is a group, in order; an overlapping one (another connection) stays flat.
  const txs = [...transactions].filter((t) => t.statementCount > 0).sort((a, b) => a.firstSeq - b.firstSeq);
  const out: DbNode[] = [];
  let i = 0;
  let t = 0;
  while (i < flat.length) {
    while (t < txs.length && txs[t].lastSeq < flat[i].seq) t++;
    const tx = txs[t];
    if (tx && flat[i].seq >= tx.firstSeq && flat[i].seq <= tx.lastSeq) {
      const members: (DbStatementNode | DbSupplierNode)[] = [];
      while (i < flat.length && flat[i].seq <= tx.lastSeq) members.push(flat[i++]);
      out.push({
        type: 'tx',
        key: `tx:${tx.txId}`,
        seq: members[0].seq,
        tx,
        children: groupRepeats(members, repeatThreshold),
        rolledBack: tx.outcome === 'ROLLED_BACK',
      });
      t++;
    } else {
      const members: (DbStatementNode | DbSupplierNode)[] = [];
      while (i < flat.length && !(tx && flat[i].seq >= tx.firstSeq)) members.push(flat[i++]);
      out.push(...groupRepeats(members, repeatThreshold));
    }
  }
  return out;
}

function shapeOf(node: DbStatementNode | DbSupplierNode): string | null {
  if (node.type !== 'stmt') return null;
  const s = node.statement;
  if (s.kind === 'COMMIT' || s.kind === 'ROLLBACK') return null;
  return s.fingerprint || s.sql;
}

function groupRepeats(nodes: readonly (DbStatementNode | DbSupplierNode)[], threshold: number): DbNode[] {
  const out: DbNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const shape = shapeOf(nodes[i]);
    let j = i + 1;
    if (shape) while (j < nodes.length && shapeOf(nodes[j]) === shape) j++;
    if (shape && j - i >= Math.max(2, threshold)) {
      const first = nodes[i] as DbStatementNode;
      out.push({
        type: 'repeat',
        key: `rep:${first.seq}`,
        seq: first.seq,
        sql: first.statement.sql,
        children: nodes.slice(i, j),
        rolledBack: false,
      });
      i = j;
    } else {
      out.push(nodes[i]);
      i++;
    }
  }
  return out;
}

/** Every statement under a node, in order. */
export function statementsOf(node: DbNode): CapturedStatement[] {
  if (node.type === 'stmt') return [node.statement];
  if (node.type === 'supplier') return [];
  return node.children.flatMap(statementsOf);
}

/** Group keys from the root down to the node holding `seq` - what must be unfolded to show it. */
export function pathTo(nodes: readonly DbNode[], seq: number): string[] {
  for (const node of nodes) {
    if (node.type === 'tx' || node.type === 'repeat') {
      if (node.children.some((c) => c.seq === seq)) return [node.key];
      const inner = pathTo(node.children, seq);
      if (inner.length) return [node.key, ...inner];
    }
  }
  return [];
}

/** Groups that start folded: transactions and repeated statements - one line each until opened. */
export function initiallyFolded(nodes: readonly DbNode[]): Set<string> {
  const keys = new Set<string>();
  const walk = (list: readonly DbNode[]) => {
    for (const n of list) {
      if (n.type === 'repeat' || n.type === 'tx') keys.add(n.key);
      if (n.type === 'tx' || n.type === 'repeat') walk(n.children);
    }
  };
  walk(nodes);
  return keys;
}
