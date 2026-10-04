import { CapturedStatement } from '../../core/models/db-capture.model';
import { errorLabel, isTxEnd, msText, resultText } from './db-statement-display';
import { sqlText } from './sql-render';

export interface SqlScriptHeader {
  readonly method?: string;
  readonly url?: string;
  readonly callId?: string;
  readonly project?: string | null;
  readonly at?: string;
}

/**
 * A call's statements as a runnable .sql script: values filled in, in the order they ran, every statement (no
 * truncation - a hard rule for every export). Transactions and results are comments; a statement that failed is kept
 * but commented out, so running the script reproduces what the call did and not what it tried. COMMIT/ROLLBACK are
 * written as the statements they were. Pass statements through redact.ts first when redaction applies.
 */
export function buildSqlScript(statements: readonly CapturedStatement[], header: SqlScriptHeader = {}): string {
  const lines: string[] = [];
  lines.push('-- Database statements captured by Alfred');
  if (header.method || header.url) lines.push(`-- Call: ${header.method ?? ''} ${header.url ?? ''}`.trimEnd());
  if (header.callId) lines.push(`-- Call id: ${header.callId}${header.project ? ` · project ${header.project}` : ''}`);
  if (header.at) lines.push(`-- Recorded: ${header.at}`);
  lines.push(`-- ${statements.length} statements, in the order they ran. Failed statements are commented out.`);
  lines.push('');
  let tx: string | null = null;
  for (const s of statements) {
    if (s.txId && s.txId !== tx) {
      lines.push(`-- transaction ${s.txId}${s.connectionId ? ` on ${s.connectionId}` : ''}`);
      tx = s.txId;
    }
    const meta = `-- #${s.seq} · ${resultText(s)} · ${msText(s.durationMicros)}${s.codeLocation ? ` · ${s.codeLocation}` : ''}`;
    lines.push(meta);
    const sets = s.params.length ? s.params : [[]];
    const text = isTxEnd(s) && !s.sql.trim() ? s.kind : sets.map((set) => withSemicolon(sqlText(s.sql, set, true))).join('\n');
    if (s.outcome.kind === 'FAILED') {
      lines.push(`-- FAILED ${errorLabel(s)}: ${(s.outcome.message ?? '').replace(/\s+/g, ' ')}`);
      lines.push(...text.split('\n').map((l) => `-- ${l}`));
    } else {
      lines.push(text);
    }
    if (isTxEnd(s)) tx = null;
    lines.push('');
  }
  return lines.join('\n');
}

function withSemicolon(sql: string): string {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(';') ? trimmed : `${trimmed};`;
}
