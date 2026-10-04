import { buildSqlScript } from './sql-export-builder';
import { stmt } from './db-capture.fixtures.spec-helper';

describe('buildSqlScript', () => {
  it('writes every statement with its values, batches as one statement per set, failures commented out', () => {
    const statements = [
      stmt(1, 'UPDATE', 'UPDATE wallet SET balance = ? WHERE user_id = ?', {
        txId: 'tx-7', params: [[{ type: 'DECIMAL', value: '380.00' }, { type: 'BIGINT', value: '1042' }]], outcome: { kind: 'UPDATED', affected: 1 },
      }),
      stmt(2, 'INSERT', 'INSERT INTO ledger (side) VALUES (?)', {
        txId: 'tx-7', params: [[{ type: 'VARCHAR', value: 'DEBIT' }], [{ type: 'VARCHAR', value: 'CREDIT' }]], outcome: { kind: 'UPDATED', affected: 2 },
      }),
      stmt(3, 'INSERT', 'INSERT INTO loyalty (p) VALUES (?)', {
        params: [[{ type: 'INTEGER', value: '12' }]], outcome: { kind: 'FAILED', sqlState: '23000', message: 'ORA-00001: unique constraint violated' },
      }),
      stmt(4, 'COMMIT', 'COMMIT'),
    ];
    const script = buildSqlScript(statements, { method: 'POST', url: '/pay', callId: 'c1' });
    expect(script).toContain('-- transaction tx-7');
    expect(script).toContain('UPDATE wallet SET balance = 380.00 WHERE user_id = 1042;');
    expect(script).toContain("INSERT INTO ledger (side) VALUES ('DEBIT');\nINSERT INTO ledger (side) VALUES ('CREDIT');");
    expect(script).toContain('-- FAILED ORA-00001');
    expect(script).toContain('-- INSERT INTO loyalty (p) VALUES (12);');
    expect(script).toContain('\nCOMMIT;');
  });

  it('never cuts anything off - a long value is written whole', () => {
    const long = 'x'.repeat(100_000);
    const script = buildSqlScript([stmt(1, 'INSERT', 'INSERT INTO t VALUES (?)', { params: [[{ type: 'CLOB', value: long }]], outcome: { kind: 'UPDATED', affected: 1 } })]);
    expect(script).toContain(`'${long}'`);
  });
});
