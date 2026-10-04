import { StatementTransaction } from '../../core/models/db-capture.model';
import { stmt } from './db-capture.fixtures.spec-helper';
import { buildStatementTree, initiallyFolded, pathTo, statementsOf } from './db-statement-tree';

const tx = (txId: string, firstSeq: number, lastSeq: number, outcome: StatementTransaction['outcome'] = 'COMMITTED'): StatementTransaction => ({
  callId: 'c1', txId, firstSeq, lastSeq, outcome, heldMicros: 5000, statementCount: lastSeq - firstSeq + 1, writeCount: 1,
});

describe('buildStatementTree', () => {
  it('merges supplier markers into the sequence and groups a transaction, markers inside it included', () => {
    const statements = [
      stmt(1, 'SELECT', 'SELECT 1 FROM a'),
      stmt(2, 'SELECT', 'SELECT b FROM w FOR UPDATE', { txId: 'tx-1' }),
      stmt(4, 'UPDATE', 'UPDATE w SET b = ?', { txId: 'tx-1' }),
      stmt(5, 'COMMIT', 'COMMIT'),
      stmt(6, 'SELECT', 'SELECT 2 FROM a'),
    ];
    const tree = buildStatementTree(statements, [{ seq: 3, method: 'POST', url: 'https://pay' }], [tx('tx-1', 2, 5)], 5);
    expect(tree.map((n) => n.type)).toEqual(['stmt', 'tx', 'stmt']);
    const group = tree[1];
    expect(group.type === 'tx' && group.children.map((c) => c.seq)).toEqual([2, 3, 4, 5]);
    expect(statementsOf(group).length).toBe(3); // the supplier marker is not a statement
  });

  it('folds a run of the same statement at the threshold, not below it', () => {
    const run = (from: number, count: number) => Array.from({ length: count }, (_, i) => stmt(from + i, 'SELECT', 'SELECT rule FROM fare WHERE route = ?'));
    const tree = buildStatementTree([...run(1, 5), stmt(6, 'SELECT', 'SELECT x FROM y'), ...run(7, 4)], [], [], 5);
    expect(tree[0].type).toBe('repeat');
    expect(tree.length).toBe(1 + 1 + 4);
    expect([...initiallyFolded(tree)]).toEqual(['rep:1']);
    expect([...initiallyFolded(buildStatementTree([stmt(1, 'SELECT', 'SELECT 1', { txId: 'tx-1' })], [], [tx('tx-1', 1, 1)], 5))]).toEqual(['tx:tx-1']);
  });

  it('keeps a read-only transaction that never ended flat - one group per read would bury the statements', () => {
    const open = (txId: string, seq: number): StatementTransaction => ({ ...tx(txId, seq, seq, 'OPEN'), writeCount: 0, statementCount: 1 });
    const tree = buildStatementTree([stmt(1, 'SELECT', 'SELECT a', { txId: 'r1' }), stmt(2, 'SELECT', 'SELECT b', { txId: 'r2' })], [],
      [open('r1', 1), open('r2', 2)], 5);
    expect(tree.map((n) => n.type)).toEqual(['stmt', 'stmt']);
  });

  it('finds the groups to unfold for a statement inside a repeat inside a transaction', () => {
    const inner = Array.from({ length: 5 }, (_, i) => stmt(2 + i, 'SELECT', 'SELECT i FROM m WHERE k = ?', { txId: 'tx-9' }));
    const tree = buildStatementTree([stmt(1, 'SELECT', 'SELECT 1', { txId: 'tx-9' }), ...inner, stmt(7, 'ROLLBACK', 'ROLLBACK')], [], [tx('tx-9', 1, 7, 'ROLLED_BACK')], 5);
    expect(pathTo(tree, 4)).toEqual(['tx:tx-9', 'rep:2']);
    expect(tree[0].type === 'tx' && tree[0].rolledBack).toBeTrue();
  });
});
