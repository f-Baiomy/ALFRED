import { paramColumns } from './sql-param-columns';

describe('paramColumns', () => {
  it('maps an INSERT by position, literals in between included, every tuple', () => {
    expect(paramColumns("INSERT INTO payments (user_id, amount, kind, card_token) VALUES (?, ?, 'PAY', ?), (?, ?, 'PAY', ?)"))
      .toEqual(['user_id', 'amount', 'card_token', 'user_id', 'amount', 'card_token']);
  });

  it('maps SET and WHERE comparisons, qualified and quoted names included', () => {
    expect(paramColumns('UPDATE wallet w SET balance = ?, "Version" = ? WHERE w.user_id = ? AND version <> ? AND note LIKE ?'))
      .toEqual(['balance', 'version', 'user_id', 'version', 'note']);
  });

  it('maps every placeholder of an IN list, and >= / <=', () => {
    expect(paramColumns('SELECT * FROM t WHERE id IN (?, ?, ?) AND at >= ? AND at <= ?')).toEqual(['id', 'id', 'id', 'at', 'at']);
  });

  it('says unknown where it cannot tell', () => {
    expect(paramColumns('{call calc_fees(?, ?)}')).toEqual([null, null]);
    expect(paramColumns('SELECT ? + 1 FROM dual')).toEqual([null]);
    expect(paramColumns('INSERT INTO t VALUES (?)')).toEqual([null]);
  });
});
