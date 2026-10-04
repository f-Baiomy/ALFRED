/**
 * The "Try:" chips under a rows SQL box (mock: `kind = 'PAY'`, `amount > 500`, `count by kind`, `top 10 amount`),
 * built from the result's own columns and first rows so every example runs as written.
 */
export interface QueryExample {
  readonly label: string;
  readonly sql: string;
}

const isNumber = (v: string | null | undefined) => v != null && v !== '' && !Number.isNaN(Number(v));

export function rowQueryExamples(columns: readonly string[], sample: readonly (readonly (string | null)[])[]): QueryExample[] {
  if (!columns.length) return [];
  const rows = sample.slice(0, 5);
  const numeric = columns.find((c, i) => !/id$/i.test(c) && rows.length > 0 && rows.every((r) => isNumber(r[i]))) ?? null;
  const textIndex = columns.findIndex((_, i) => rows.some((r) => r[i] != null && !isNumber(r[i])));
  const text = textIndex >= 0 ? columns[textIndex] : null;
  const q = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
  const out: QueryExample[] = [];
  if (text) {
    const value = String(rows[0]?.[textIndex] ?? '').replace(/'/g, "''");
    out.push({ label: `${text} = '${value}'`, sql: `SELECT * FROM result WHERE ${q(text)} = '${value}'` });
  }
  if (numeric) {
    out.push({ label: `${numeric} > 500`, sql: `SELECT * FROM result WHERE ${q(numeric)} > 500 ORDER BY ${q(numeric)} DESC` });
  }
  if (text) {
    out.push({
      label: `count by ${text}`,
      sql: `SELECT ${q(text)}, COUNT(*)${numeric ? `, SUM(${q(numeric)})` : ''} FROM result GROUP BY ${q(text)} ORDER BY COUNT(*) DESC`,
    });
  }
  if (numeric) {
    out.push({ label: `top 10 ${numeric}`, sql: `SELECT * FROM result ORDER BY ${q(numeric)} DESC LIMIT 10` });
  }
  return out;
}

/** The statements box's "Try:" chips (mock), over the fixed `statements` table. */
export const STATEMENT_QUERY_COLUMNS = ['n', 'verb', 'table', 'sql', 'ms', 'rows', 'tx', 'write', 'failed', 'offset', 'code'] as const;

export function statementQueryExamples(firstWriteTable: string | null, firstTx: string | null, firstCodeClass: string | null): QueryExample[] {
  const out: QueryExample[] = [{ label: 'slowest', sql: 'SELECT * FROM statements WHERE ms > 5 ORDER BY ms DESC' }];
  if (firstWriteTable) {
    out.push({ label: `writes to ${firstWriteTable}`, sql: `SELECT * FROM statements WHERE write = 1 AND "table" = '${firstWriteTable.replace(/'/g, "''")}'` });
  }
  out.push(
    { label: 'time per table', sql: 'SELECT "table", COUNT(*), SUM(ms) AS time FROM statements GROUP BY "table" ORDER BY time DESC' },
    { label: 'failed or rolled back', sql: "SELECT * FROM statements WHERE failed = 1 OR verb = 'ROLLBACK'" },
    { label: 'deletes', sql: "SELECT * FROM statements WHERE verb = 'DELETE' ORDER BY rows DESC" },
  );
  if (firstTx) out.push({ label: `inside ${firstTx}`, sql: `SELECT * FROM statements WHERE tx = '${firstTx.replace(/'/g, "''")}'` });
  if (firstCodeClass) {
    out.push({ label: `from ${firstCodeClass} code`, sql: `SELECT n, verb, "table", ms FROM statements WHERE code LIKE '${firstCodeClass.replace(/'/g, "''")}%'` });
  }
  return out;
}
