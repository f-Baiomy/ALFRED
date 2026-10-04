import { stmt } from './db-capture.fixtures.spec-helper';
import { beforeAfter, setColumns } from './db-before-after';

describe('db-before-after', () => {
  it('finds the columns an UPDATE writes, bound or computed', () => {
    expect(setColumns('UPDATE wallet w SET balance = ?, "Version" = version + 1, note = ? WHERE w.user_id = ? AND version = ?')).toEqual([
      { column: 'balance', param: 0, expression: null },
      { column: 'version', param: null, expression: 'version + 1' },
      { column: 'note', param: 1, expression: null },
    ]);
    expect(setColumns("UPDATE t SET a = COALESCE(?, 'x'), b = ? WHERE id = ?").map((c) => [c.column, c.param])).toEqual([['a', null], ['b', 1]]);
  });

  it('lines the written values up against the row as it was', () => {
    const update = stmt(4, 'UPDATE', 'UPDATE wallet SET balance = ?, version = ? WHERE user_id = ? AND version = ?', {
      params: [[{ type: 'DECIMAL', value: '380.00' }, { type: 'INTEGER', value: '42' }, { type: 'BIGINT', value: '1042' }, { type: 'INTEGER', value: '41' }]],
    });
    const columns = [{ name: 'BALANCE', type: 'DECIMAL' }, { name: 'currency', type: 'VARCHAR' }, { name: 'version', type: 'INTEGER' }];
    const row = [{ type: 'DECIMAL', value: '500.00' }, { type: 'VARCHAR', value: 'AED' }, { type: 'INTEGER', value: '41' }];
    expect(beforeAfter(update, columns, row)).toEqual([
      { column: 'balance', before: '500.00', after: '380.00', changed: true },
      { column: 'version', before: '41', after: '42', changed: true },
    ]);
    expect(beforeAfter(update, null, null).every((r) => r.before === null)).toBeTrue();
  });
});
