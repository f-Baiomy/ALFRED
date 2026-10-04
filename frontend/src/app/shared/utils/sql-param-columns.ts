import { RawToken, scanSql } from './sql-render';

/**
 * Which column each `?` of a statement is bound to - so a `db-column` redaction ("hide card_token in exports") also
 * hides the value the application WROTE into that column, not only the value it read back. Recognised shapes:
 *  - `INSERT INTO t (a, b, c) VALUES (?, 'x', ?)` - by position in the column list, every VALUES tuple;
 *  - `col = ?`, `col <> ?`, `col >= ?`, `col LIKE ?` ... - the column right before the operator (`t.col` -> `col`);
 *  - `col IN (?, ?, ?)` - every placeholder in the list.
 * Anything else is `null` (unknown): such a parameter is masked only by the secret-value rules.
 * Column names come back lower-case, unquoted.
 */
export function paramColumns(sql: string): (string | null)[] {
  const tokens = scanSql(sql ?? '').filter((t) => t.kind !== 'space' && t.kind !== 'comment');
  const out: (string | null)[] = [];
  const insert = insertColumns(tokens);
  let tupleDepth = 0;
  let valuesIndex = -1;
  let inValues = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (insert && t.kind === 'word' && t.text.toUpperCase() === 'VALUES') {
      inValues = true;
      continue;
    }
    if (inValues) {
      if (t.text === '(') {
        tupleDepth++;
        if (tupleDepth === 1) valuesIndex = 0;
      } else if (t.text === ')') {
        tupleDepth--;
      } else if (t.text === ',' && tupleDepth === 1) {
        valuesIndex++;
      } else if (tupleDepth === 0 && t.kind === 'word') {
        inValues = false; // e.g. ON CONFLICT / RETURNING after the tuples
      }
    }
    if (t.kind !== 'ph') continue;
    if (inValues && tupleDepth >= 1 && insert) {
      out.push(insert[valuesIndex] ?? null);
    } else {
      out.push(columnBefore(tokens, i));
    }
  }
  return out;
}

const OPERATORS = new Set(['=', '<>', '!=', '<', '>', '<=', '>=']);

function clean(name: string): string {
  const last = name.split('.').pop() ?? name;
  return last.replace(/^["`[]|["`\]]$/g, '').toLowerCase();
}

/** The `(a, b, c)` column list of an INSERT, or null when the statement is not one (or names no columns). */
function insertColumns(tokens: readonly RawToken[]): string[] | null {
  const first = tokens[0]?.text.toUpperCase();
  if (first !== 'INSERT' && first !== 'MERGE') return null;
  const into = tokens.findIndex((t) => t.kind === 'word' && t.text.toUpperCase() === 'INTO');
  if (into < 0) return null;
  let i = into + 2; // past INTO and the table name
  if (tokens[i]?.text !== '(') return null;
  const cols: string[] = [];
  for (i++; i < tokens.length && tokens[i].text !== ')'; i++) {
    if (tokens[i].kind === 'word' || tokens[i].kind === 'quoted') cols.push(clean(tokens[i].text));
  }
  return cols;
}

function columnBefore(tokens: readonly RawToken[], ph: number): string | null {
  let i = ph - 1;
  // col IN (?, ?, ?): walk back to the opening parenthesis
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const t = tokens[j];
    if (t.text === ')') depth++;
    else if (t.text === '(') {
      if (depth === 0) {
        const before = tokens[j - 1];
        if (before && before.kind === 'word' && before.text.toUpperCase() === 'IN') {
          const col = tokens[j - 2];
          return col && (col.kind === 'word' || col.kind === 'quoted') ? clean(col.text) : null;
        }
        break;
      }
      depth--;
    } else if (depth === 0 && t.text !== ',' && t.kind !== 'ph') {
      break;
    }
  }
  // col <op> ?   (operators arrive as one or two 'other' tokens: '<', '>', '=', '!')
  let op = '';
  while (i >= 0 && tokens[i].kind === 'other' && /^[<>=!]$/.test(tokens[i].text)) {
    op = tokens[i].text + op;
    i--;
  }
  if (!op) {
    const word = tokens[i];
    if (word && word.kind === 'word' && /^(LIKE|ILIKE)$/i.test(word.text)) {
      i--;
      if (tokens[i]?.kind === 'word' && tokens[i].text.toUpperCase() === 'NOT') i--;
      op = 'LIKE';
    }
  }
  if (!op || (op !== 'LIKE' && !OPERATORS.has(op))) return null;
  const col = tokens[i];
  return col && (col.kind === 'word' || col.kind === 'quoted') ? clean(col.text) : null;
}
