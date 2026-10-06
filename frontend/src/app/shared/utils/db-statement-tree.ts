import { CapturedStatement, StatementOrigin, StatementTransaction, SupplierMarker } from '../../core/models/db-capture.model';
import { queryKeyOf } from './db-origin';
import { LinkedLogLine } from '../../core/models/call-logs.model';

/**
 * The database window's tree (mock: "transactions / repeated queries are parent rows, their statements hang under
 * them"). Input is a call's statements and supplier markers, which share one sequence counter; output is that
 * sequence with:
 *  - each transaction (from its first to its last seq, supplier calls in between included) as a group, and
 *  - each run of the same statement shape repeated at least `repeatThreshold` times in a row as a group, folded at
 *    first ("looks like N+1" / "could be cached"), and
 *  - with `groupByQuery`, the SQL statements one HQL/native query produced (join fetches, eager loads during it) under
 *    that query - only when it produced more than one.
 * Pure: the window re-runs it whenever a page of statements arrives.
 */

export type DbNode = DbStatementNode | DbSupplierNode | DbLogNode | DbGroupNode;

/** A log line the agent caught, at its place in the call's sequence (specs/009-agent-log-capture - the Together view). */
export interface DbLogNode {
  readonly type: 'log';
  readonly seq: number;
  readonly line: LinkedLogLine;
}

type Leaf = DbStatementNode | DbSupplierNode | DbLogNode;

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
  readonly type: 'tx' | 'repeat' | 'query';
  readonly key: string;
  readonly seq: number;
  readonly children: readonly DbNode[];
  /** Transactions only. */
  readonly tx?: StatementTransaction;
  /** Repeats only: the repeated SQL. */
  readonly sql?: string;
  /** Query groups only: the query the code wrote. */
  readonly origin?: StatementOrigin;
  readonly rolledBack: boolean;
}

export function buildStatementTree(
  statements: readonly CapturedStatement[],
  markers: readonly SupplierMarker[],
  transactions: readonly StatementTransaction[],
  repeatThreshold: number,
  groupByQuery = false,
  logs: readonly LinkedLogLine[] = [],
): DbNode[] {
  const group = (members: readonly Leaf[]) =>
    groupByQuery ? groupQueries(members, repeatThreshold) : groupRepeats(members, repeatThreshold);
  const rank = (n: Leaf) => (n.type === 'stmt' ? 0 : n.type === 'supplier' ? 1 : 2);
  const flat: Leaf[] = [
    ...statements.map((s) => ({ type: 'stmt' as const, seq: s.seq, statement: s })),
    ...markers.map((m) => ({ type: 'supplier' as const, seq: m.seq, marker: m })),
    ...logs.filter((l) => l.seq != null).map((l) => ({ type: 'log' as const, seq: l.seq!, line: l })),
  ].sort((a, b) => a.seq - b.seq || rank(a) - rank(b));

  // Every transaction that ran something is a group, in order; an overlapping one (another connection) stays flat.
  const txs = [...transactions].filter((t) => t.statementCount > 0).sort((a, b) => a.firstSeq - b.firstSeq);
  const out: DbNode[] = [];
  let i = 0;
  let t = 0;
  while (i < flat.length) {
    while (t < txs.length && txs[t].lastSeq < flat[i].seq) t++;
    const tx = txs[t];
    if (tx && flat[i].seq >= tx.firstSeq && flat[i].seq <= tx.lastSeq) {
      const members: Leaf[] = [];
      while (i < flat.length && flat[i].seq <= tx.lastSeq) members.push(flat[i++]);
      out.push({
        type: 'tx',
        key: `tx:${tx.txId}`,
        seq: members[0].seq,
        tx,
        children: group(members),
        rolledBack: tx.outcome === 'ROLLED_BACK',
      });
      t++;
    } else {
      const members: Leaf[] = [];
      while (i < flat.length && !(tx && flat[i].seq >= tx.firstSeq)) members.push(flat[i++]);
      out.push(...group(members));
    }
  }
  return out;
}

function shapeOf(node: Leaf): string | null {
  if (node.type !== 'stmt') return null;
  const s = node.statement;
  if (s.kind === 'COMMIT' || s.kind === 'ROLLBACK') return null;
  return s.fingerprint || s.sql;
}

/** Runs of statements made by one query execution become a group (when more than one); the rest is grouped by repeats. */
function groupQueries(nodes: readonly Leaf[], threshold: number): DbNode[] {
  const out: DbNode[] = [];
  let pending: Leaf[] = [];
  const flush = () => {
    out.push(...groupRepeats(pending, threshold));
    pending = [];
  };
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    const key = node.type === 'stmt' ? queryKeyOf(node.statement) : null;
    let j = i + 1;
    if (key) while (j < nodes.length && nodes[j].type === 'stmt' && queryKeyOf((nodes[j] as DbStatementNode).statement) === key) j++;
    if (key && j - i >= 2) {
      flush();
      const members = nodes.slice(i, j) as DbStatementNode[];
      const query = members.find((m) => m.statement.origin?.id === key)?.statement.origin;
      out.push({
        type: 'query',
        key: `q:${key}`,
        seq: members[0].seq,
        origin: query ?? members[0].statement.origin ?? undefined,
        children: groupRepeats(members, threshold),
        rolledBack: false,
      });
      i = j;
    } else {
      pending.push(node);
      i++;
    }
  }
  flush();
  return out;
}

function groupRepeats(nodes: readonly Leaf[], threshold: number): DbNode[] {
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
  if (node.type === 'supplier' || node.type === 'log') return [];
  return node.children.flatMap(statementsOf);
}

/** Every log line under a node, in order. */
export function logsOf(node: DbNode): LinkedLogLine[] {
  if (node.type === 'log') return [node.line];
  if (node.type === 'stmt' || node.type === 'supplier') return [];
  return node.children.flatMap(logsOf);
}

/** Group keys from the root down to the node holding `seq` - what must be unfolded to show it. */
export function pathTo(nodes: readonly DbNode[], seq: number): string[] {
  for (const node of nodes) {
    if (node.type === 'tx' || node.type === 'repeat' || node.type === 'query') {
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
      if (n.type === 'tx' || n.type === 'repeat' || n.type === 'query') walk(n.children);
    }
  };
  walk(nodes);
  return keys;
}
