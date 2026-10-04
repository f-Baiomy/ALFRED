import { CapturedStatement, DbColumn, TypedValue } from '../../core/models/db-capture.model';
import { valueText } from './db-statement-display';
import { scanSql } from './sql-render';

/**
 * "Before → after" for an UPDATE (mock: Column | Read in #n | Written here): which columns its SET writes and with
 * what, against the row as it was - from an earlier read of the same rows or the agent's before-image. Pure.
 */

export interface SetColumn {
  readonly column: string;
  /** The `?` it is bound to (0-based), or null when SET writes a literal / expression. */
  readonly param: number | null;
  /** The SQL text written when it is not a parameter (e.g. `version + 1`). */
  readonly expression: string | null;
}

export interface BeforeAfterRow {
  readonly column: string;
  /** null = not captured. */
  readonly before: string | null;
  readonly after: string;
  readonly changed: boolean;
}

/** The `col = <value>` pairs of an UPDATE's SET clause, in order. */
export function setColumns(sql: string): SetColumn[] {
  const tokens = scanSql(sql ?? '').filter((t) => t.kind !== 'comment');
  const out: SetColumn[] = [];
  let param = 0;
  let inSet = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const word = t.kind === 'word' ? t.text.toUpperCase() : '';
    if (word === 'SET') {
      inSet = true;
      i++;
      continue;
    }
    if (inSet && (word === 'WHERE' || word === 'FROM' || word === 'RETURNING')) break;
    if (t.kind === 'ph') {
      param++;
      i++;
      continue;
    }
    if (inSet && (t.kind === 'word' || t.kind === 'quoted')) {
      // col = <expression up to the next top-level comma>
      let j = i + 1;
      while (j < tokens.length && tokens[j].kind === 'space') j++;
      if (tokens[j]?.text === '=') {
        const column = t.text.replace(/^["`[]|["`\]]$/g, '').split('.').pop()!.toLowerCase();
        let k = j + 1;
        let depth = 0;
        const parts: string[] = [];
        let firstParam: number | null = null;
        let onlyParam = true;
        for (; k < tokens.length; k++) {
          const x = tokens[k];
          const xw = x.kind === 'word' ? x.text.toUpperCase() : '';
          if (depth === 0 && (x.text === ',' || xw === 'WHERE' || xw === 'FROM' || xw === 'RETURNING')) break;
          if (x.text === '(') depth++;
          if (x.text === ')') depth--;
          if (x.kind === 'ph') {
            if (firstParam == null) firstParam = param;
            param++;
          } else if (x.kind !== 'space') {
            onlyParam = false;
          }
          parts.push(x.text);
        }
        const expression = parts.join('').trim();
        out.push(onlyParam && firstParam != null ? { column, param: firstParam, expression: null } : { column, param: null, expression });
        i = k;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** The rows of the table: each written column, its value before (first matching row) and what was written. */
export function beforeAfter(
  statement: CapturedStatement,
  beforeColumns: readonly DbColumn[] | null,
  beforeRow: readonly TypedValue[] | null,
): BeforeAfterRow[] {
  const params = statement.params[0] ?? [];
  return setColumns(statement.sql).map((c) => {
    const after = c.param != null ? valueText(params[c.param]) : c.expression ?? '';
    const index = beforeColumns?.findIndex((col) => col.name.toLowerCase() === c.column) ?? -1;
    const before = beforeRow && index >= 0 ? valueText(beforeRow[index]) : null;
    return { column: c.column, before, after, changed: before != null && c.param != null && before !== after };
  });
}
