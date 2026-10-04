import { TypedValue } from '../../core/models/db-capture.model';
import { renderSql, sqlLiteral, sqlText } from './sql-render';

const v = (type: string, value: string | null, extra: Partial<TypedValue> = {}): TypedValue => ({ type, value, ...extra });

describe('sql-render', () => {
  it('fills placeholders with literals of their type', () => {
    const text = sqlText('UPDATE wallet SET balance = ?, note = ?, at = ? WHERE user_id = ? AND gone = ?', [
      v('DECIMAL', '380.00'), v('VARCHAR', "O'Brien"), v('TIMESTAMP', '2026-10-04 18:02:43.456'), v('BIGINT', '1042'), v('BIGINT', null),
    ]);
    expect(text).toBe("UPDATE wallet SET balance = 380.00, note = 'O''Brien', at = TIMESTAMP '2026-10-04 18:02:43.456' WHERE user_id = 1042 AND gone = NULL");
  });

  it('leaves a ? inside a string literal, quoted identifier or comment alone', () => {
    const text = sqlText(`SELECT '?' AS q, "a?b" FROM t -- why?\nWHERE id = ? /* ? */`, [v('INTEGER', '7')]);
    expect(text).toBe(`SELECT '?' AS q, "a?b" FROM t -- why?\nWHERE id = 7 /* ? */`);
  });

  it('keeps placeholders when not filling, and marks keywords', () => {
    const tokens = renderSql('SELECT id FROM users WHERE id = ?', [v('BIGINT', '1')], { filled: false });
    expect(tokens.filter((t) => t.kind === 'kw').map((t) => t.text)).toEqual(['SELECT', 'FROM', 'WHERE']);
    expect(tokens.some((t) => t.kind === 'ph' && t.param === 0)).toBeTrue();
  });

  it('breaks before clauses in pretty mode, never between LEFT and JOIN', () => {
    const text = renderSql('SELECT a FROM t LEFT JOIN u ON u.id = t.id WHERE a = 1 ORDER BY a FOR UPDATE', [], { filled: true, pretty: true })
      .map((t) => t.text).join('');
    expect(text).toBe('SELECT a\nFROM t\nLEFT JOIN u ON u.id = t.id\nWHERE a = 1\nORDER BY a\nFOR UPDATE');
  });

  it('shows binary values as a blob label and writes them as hex', () => {
    const blob = v('BLOB', btoa('AB'));
    expect(renderSql('INSERT INTO r VALUES (?)', [blob], { filled: true }).find((t) => t.kind === 'blob')?.text).toBe('<blob 2 B>');
    expect(sqlLiteral(blob)).toBe("X'4142'");
  });

  it('shows an unanswered OUT parameter as OUT', () => {
    const tokens = renderSql('{call calc_fees(?, ?)}', [v('DECIMAL', '120.00'), v('DECIMAL', null, { direction: 'OUT' })], { filled: true });
    expect(tokens.some((t) => t.kind === 'out')).toBeTrue();
  });

  it('quotes a value that is not a plain number even when its type is unknown', () => {
    expect(sqlLiteral(v('OTHER', 'abc'))).toBe("'abc'");
    expect(sqlLiteral(v('OTHER', '12.5'))).toBe('12.5');
  });
});
