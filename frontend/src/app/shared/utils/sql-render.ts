import { TypedValue } from '../../core/models/db-capture.model';

/**
 * Captured SQL for display (the database window) and for text (exports, Copy SQL, the .sql script).
 *
 * The application sends SQL with `?` placeholders and the values separately; the window shows them filled in (or not -
 * "Fill in values"). Placeholders are found by a small scanner, not a regex, so a `?` inside a string literal,
 * a quoted identifier or a comment is left alone, and values are formatted as the literal their JDBC type would be
 * written as (`'O''Brien'`, `TIMESTAMP '2026-10-04 18:02:43'`, `NULL`).
 */

export type SqlTokenKind = 'kw' | 'text' | 'val' | 'ph' | 'blob' | 'out' | 'null';

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly text: string;
  /** For a filled-in value: the raw value (what a click traces). */
  readonly value?: string | null;
  /** For a value or placeholder: which parameter (0-based). */
  readonly param?: number;
}

export interface SqlRenderOptions {
  /** Put the values in place of `?`. */
  readonly filled: boolean;
  /** Break before FROM / WHERE / SET / VALUES / ORDER BY ... (the expanded Statement tab). */
  readonly pretty?: boolean;
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'UPDATE', 'SET', 'INSERT', 'INTO', 'DELETE', 'VALUES',
  'ORDER', 'BY', 'GROUP', 'HAVING', 'DESC', 'ASC', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'AS',
  'FOR', 'LIMIT', 'OFFSET', 'FETCH', 'FIRST', 'NEXT', 'ROWS', 'ONLY', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'CALL', 'EXEC',
  'EXECUTE', 'MERGE', 'USING', 'WHEN', 'THEN', 'MATCHED', 'DISTINCT', 'UNION', 'ALL', 'LIKE', 'BETWEEN', 'EXISTS',
  'CASE', 'ELSE', 'END', 'RETURNING', 'WITH', 'NOWAIT', 'SKIP', 'LOCKED', 'BEGIN', 'DECLARE', 'TOP', 'CREATE', 'ALTER',
  'DROP', 'TABLE', 'INDEX', 'TRUNCATE', 'COUNT', 'SUM', 'MIN', 'MAX', 'AVG',
]);

/** A line break goes before these in pretty mode ("FOR" only when it starts FOR UPDATE). */
const BREAK_BEFORE = new Set(['FROM', 'WHERE', 'SET', 'VALUES', 'ORDER', 'GROUP', 'HAVING', 'LIMIT', 'UNION', 'RETURNING', 'JOIN', 'LEFT', 'INNER', 'RIGHT', 'FULL', 'CROSS']);

const TEXT_TYPES = /CHAR|TEXT|CLOB|STRING|UUID|JSON|XML|ROWID|ENUM|INTERVAL|NAME/i;
const BINARY_TYPES = /BLOB|BINARY|BYTEA|BYTES|IMAGE|RAW/i;

export function isBinary(value: TypedValue | null | undefined): boolean {
  return !!value && (BINARY_TYPES.test(value.type ?? '') || !!value.opaque && value.value == null);
}

export function isOutParam(value: TypedValue | null | undefined): boolean {
  return !!value && (value.direction === 'OUT' || /^OUT\b/i.test(value.type ?? ''));
}

/** How many bytes a base64 value holds - binary values travel base64-encoded. */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/\s+/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The short label a binary value shows as - `<blob 48.2 KB>`. */
export function blobLabel(value: TypedValue): string {
  const size = value.value != null ? formatBytes(base64Bytes(value.value)) : 'not read';
  return `<blob ${size}>`;
}

/** A value written as an SQL literal of its type. Binary becomes X'hex' so a .sql script can run it. */
export function sqlLiteral(value: TypedValue | null | undefined): string {
  if (!value || value.value == null) return 'NULL';
  const type = (value.type ?? '').toUpperCase();
  const raw = value.value;
  if (BINARY_TYPES.test(type)) return `X'${base64ToHex(raw)}'`;
  if (/^TIMESTAMP/.test(type) || type === 'DATETIME' || type === 'DATETIME2') return `TIMESTAMP '${raw.replace(/'/g, "''")}'`;
  if (type === 'DATE') return `DATE '${raw.replace(/'/g, "''")}'`;
  if (/^TIME/.test(type)) return `TIME '${raw.replace(/'/g, "''")}'`;
  if (TEXT_TYPES.test(type) || value.opaque || !looksLikeBareLiteral(raw)) return `'${raw.replace(/'/g, "''")}'`;
  return raw;
}

function looksLikeBareLiteral(raw: string): boolean {
  return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw) || /^(true|false)$/i.test(raw);
}

function base64ToHex(b64: string): string {
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    let hex = '';
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    return hex.toUpperCase();
  } catch {
    return '';
  }
}

export interface RawToken {
  readonly kind: 'word' | 'space' | 'ph' | 'string' | 'quoted' | 'comment' | 'other';
  readonly text: string;
}

/** Splits SQL into words, whitespace, placeholders, literals, quoted identifiers and comments. */
export function scanSql(sql: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") { j++; break; }
        else j++;
      }
      out.push({ kind: 'string', text: sql.slice(i, j) });
      i = j;
    } else if (c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      const j = sql.indexOf(close, i + 1);
      const end = j < 0 ? n : j + 1;
      out.push({ kind: 'quoted', text: sql.slice(i, end) });
      i = end;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? n : j;
      out.push({ kind: 'comment', text: sql.slice(i, end) });
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out.push({ kind: 'comment', text: sql.slice(i, end) });
      i = end;
    } else if (c === '?') {
      out.push({ kind: 'ph', text: '?' });
      i++;
    } else if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      out.push({ kind: 'space', text: sql.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$#.]/.test(sql[j])) j++;
      out.push({ kind: 'word', text: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: 'other', text: c });
      i++;
    }
  }
  return out;
}

/** SQL as tokens for the window. Adjacent plain text is merged. */
export function renderSql(sql: string, params: readonly TypedValue[] | null | undefined, options: SqlRenderOptions): SqlToken[] {
  const raw = scanSql(sql ?? '');
  const out: SqlToken[] = [];
  const push = (token: SqlToken) => {
    const last = out[out.length - 1];
    if (token.kind === 'text' && last && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + token.text };
    else out.push(token);
  };
  let param = 0;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t.kind === 'space') {
      if (options.pretty) {
        const next = nextWord(raw, i);
        if (next && breaksBefore(next, raw, i)) {
          push({ kind: 'text', text: '\n' });
          continue;
        }
        push({ kind: 'text', text: t.text.includes('\n') && !options.pretty ? t.text : ' ' });
      } else {
        push({ kind: 'text', text: t.text });
      }
    } else if (t.kind === 'word') {
      push(KEYWORDS.has(t.text.toUpperCase()) ? { kind: 'kw', text: t.text } : { kind: 'text', text: t.text });
    } else if (t.kind === 'ph') {
      const index = param++;
      const value = params?.[index];
      if (!options.filled || !value) {
        push({ kind: 'ph', text: '?', param: index });
      } else if (isOutParam(value) && value.value == null) {
        push({ kind: 'out', text: 'OUT', param: index });
      } else if (isBinary(value)) {
        push({ kind: 'blob', text: blobLabel(value), param: index, value: value.value });
      } else if (value.value == null) {
        push({ kind: 'null', text: 'NULL', param: index, value: null });
      } else {
        push({ kind: 'val', text: sqlLiteral(value), param: index, value: value.value });
      }
    } else {
      push({ kind: 'text', text: t.text });
    }
  }
  return out;
}

function nextWord(raw: readonly RawToken[], spaceIndex: number): string | null {
  const t = raw[spaceIndex + 1];
  return t && t.kind === 'word' ? t.text.toUpperCase() : null;
}

function breaksBefore(word: string, raw: readonly RawToken[], spaceIndex: number): boolean {
  if (word === 'FOR') {
    const after = raw[spaceIndex + 3];
    return !!after && after.kind === 'word' && after.text.toUpperCase() === 'UPDATE';
  }
  if (!BREAK_BEFORE.has(word)) return false;
  // "LEFT JOIN", "INNER JOIN": break once, before the first word; never between "LEFT" and "JOIN".
  const prev = raw[spaceIndex - 1];
  return !(word === 'JOIN' && prev && prev.kind === 'word' && /^(LEFT|RIGHT|INNER|OUTER|FULL|CROSS)$/i.test(prev.text));
}

/** The SQL as plain text - values filled in (exports, Copy SQL, the .sql script) or with `?` kept. */
export function sqlText(sql: string, params: readonly TypedValue[] | null | undefined, filled = true): string {
  return renderSql(sql, params, { filled }).map((t) => (t.kind === 'blob' && t.value != null ? sqlLiteral(params?.[t.param ?? 0]) : t.text)).join('');
}

/** A token of a query as the code wrote it - HQL/JPQL or native SQL with named (`:id`) or numbered (`?1`) parameters. */
export interface QueryTextToken {
  readonly kind: 'kw' | 'np' | 'text';
  readonly text: string;
}

const HQL_KEYWORDS = new Set([...KEYWORDS, 'FETCH', 'MEMBER', 'OF', 'NEW', 'TREAT', 'SIZE', 'INDEX', 'KEY', 'VALUE', 'ENTRY', 'ELEMENTS', 'OBJECT', 'TYPE']);

/** The code's query, keywords and parameters marked. `oneLine` collapses whitespace (a list row). */
export function renderQueryText(text: string, oneLine = false): QueryTextToken[] {
  const raw = scanSql(text ?? '');
  const out: QueryTextToken[] = [];
  const push = (token: QueryTextToken) => {
    const last = out[out.length - 1];
    if (token.kind === 'text' && last && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + token.text };
    else out.push(token);
  };
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const next = raw[i + 1];
    if (t.kind === 'space') {
      push({ kind: 'text', text: oneLine ? ' ' : t.text });
    } else if (t.kind === 'other' && t.text === ':' && next?.kind === 'word' && raw[i - 1]?.text !== ':') {
      push({ kind: 'np', text: ':' + next.text });
      i++;
    } else if (t.kind === 'ph') {
      let digits = '';
      while (raw[i + 1]?.kind === 'other' && /^\d$/.test(raw[i + 1].text)) digits += raw[++i].text;
      push({ kind: 'np', text: '?' + digits });
    } else if (t.kind === 'word') {
      push({ kind: HQL_KEYWORDS.has(t.text.toUpperCase()) ? 'kw' : 'text', text: t.text });
    } else {
      push({ kind: 'text', text: t.text });
    }
  }
  return out;
}
