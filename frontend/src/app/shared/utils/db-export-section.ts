import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture, DbColumn, ExportedDbStatement, TypedValue } from '../../core/models/db-capture.model';
import { flagText, msText, resultText, valueText, verbOf } from './db-statement-display';
import { sqlText } from './sql-render';

/**
 * The "Database" section of a call in the .md and .html exports (contracts/export-format.md): flags first, then
 * every statement in run order with its values filled in, transactions as headed groups, supplier calls where they
 * ran, and every stored result row and before-image row as a table. Never truncated - the same rule as bodies.
 * Values are the CAPTURED values (redaction, when on, has already been applied by redact.ts).
 */

interface Item {
  readonly seq: number;
  readonly statement?: ExportedDbStatement;
  readonly supplier?: { readonly method?: string | null; readonly url?: string | null };
}

function itemsOf(capture: CallDbCapture): Item[] {
  return [
    ...capture.statements.map((s) => ({ seq: s.seq, statement: s })),
    ...(capture.supplierMarkers ?? []).map((m) => ({ seq: m.seq, supplier: m })),
  ].sort((a, b) => a.seq - b.seq);
}

function headline(capture: CallDbCapture): string {
  const s = capture.statements;
  const writes = s.filter((x) => ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DDL'].includes(x.kind)).length;
  const failed = s.filter((x) => x.outcome.kind === 'FAILED').length;
  const txs = capture.transactions.length;
  const rolled = capture.transactions.filter((t) => t.outcome === 'ROLLED_BACK').length;
  const micros = s.reduce((a, x) => a + x.durationMicros, 0);
  return `${s.length} statements · ${writes} writes · ${failed} failed · ${txs} transactions${rolled ? `, ${rolled} rolled back` : ''} · ${msText(micros)} in the database`;
}

function statementSql(s: ExportedDbStatement): string {
  return s.params.length > 1 ? s.params.map((set) => `${sqlText(s.sql, set)};`).join('\n') : sqlText(s.sql, s.params[0]);
}

function txHeading(capture: CallDbCapture, txId: string): string {
  const tx = capture.transactions.find((t) => t.txId === txId);
  const outcome = tx?.outcome === 'ROLLED_BACK' ? 'rolled back - nothing in it persisted' : tx?.outcome === 'OPEN' ? 'never ended' : 'committed';
  return `Transaction ${txId}${tx?.connectionId ? ` on ${tx.connectionId}` : ''} - ${outcome}${tx ? `, held ${msText(tx.heldMicros)}` : ''}`;
}

function columnsOf(s: ExportedDbStatement, part: 'rows' | 'before'): readonly DbColumn[] {
  const cols = part === 'rows' ? s.outcome.columns : s.beforeImage?.columns;
  const width = (part === 'rows' ? s.rows : s.beforeImageRows)?.[0]?.length ?? 0;
  if (cols && cols.length) return cols;
  return Array.from({ length: width }, (_, i) => ({ name: `col${i + 1}`, type: '' }));
}

// ---------------------------------------------------------------- markdown

/** A fence longer than any backtick run inside, so captured text can never close it. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A markdown table cell: pipes escaped, newlines kept as <br>, HTML neutralised. */
export function mdCell(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function mdTable(columns: readonly DbColumn[], rows: readonly (readonly TypedValue[])[]): string[] {
  if (!rows.length) return ['_(no rows)_', ''];
  return [
    `| ${columns.map((c) => mdCell(c.name)).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map((v) => mdCell(valueText(v))).join(' | ')} |`),
    '',
  ];
}

export function dbSectionMarkdown(call: CallRecord, level: number): string[] {
  const capture = call.dbCapture;
  if (!capture) return [];
  const h = '#'.repeat(level);
  const lines: string[] = [`${h} 🗄 Database`, '', `_${headline(capture)}_`, ''];
  const flags = capture.summary?.flags ?? [];
  if (flags.length) {
    lines.push('**Flags:**', '', ...flags.map((f) => `- ${f.severity === 'BAD' ? '✕' : '⚠'} ${mdCell(flagText(f))} (#${f.seqs.join(', #')})`), '');
  }
  let tx: string | null = null;
  for (const item of itemsOf(capture)) {
    if (item.supplier) {
      lines.push(`**#${item.seq}** ↗ supplier call \`${mdCell(item.supplier.method ?? 'HTTP')}\` ${mdCell(item.supplier.url ?? '')}`, '');
      continue;
    }
    const s = item.statement!;
    if (s.txId && s.txId !== tx) {
      tx = s.txId;
      lines.push(`${h}# ${mdCell(txHeading(capture, s.txId))}`, '');
    }
    const where = s.codeLocation ? ` · ${mdCell(s.codeLocation)}` : '';
    lines.push(`**#${s.seq}** \`${verbOf(s)}\` · ${mdCell(resultText(s))} · ${msText(s.durationMicros)} · +${(s.offsetMicros / 1000).toFixed(0)} ms${where}${s.undone ? ' · ~~undone~~' : ''}`, '');
    lines.push(fence(statementSql(s), 'sql'), '');
    if (s.outcome.kind === 'FAILED') {
      lines.push(`> ✕ ${mdCell(s.outcome.message ?? '')} (SQLState ${mdCell(s.outcome.sqlState ?? '-')}, vendor code ${s.outcome.vendorCode ?? '-'})${s.outcome.swallowed ? ' - caught by the application; the call still answered normally' : ''}`, '');
    }
    if (s.rows?.length) {
      lines.push(`<details>\n<summary>Rows (${s.rows.length.toLocaleString()} stored${s.outcome.rowsRead != null && s.outcome.rowsRead > s.rows.length ? ` of ${s.outcome.rowsRead.toLocaleString()} returned` : ''})</summary>`, '');
      lines.push(...mdTable(columnsOf(s, 'rows'), s.rows), '</details>', '');
    }
    if (s.beforeImageRows?.length) {
      lines.push(`<details>\n<summary>Rows before this ${s.kind} (${s.beforeImageRows.length.toLocaleString()})</summary>`, '');
      lines.push(...mdTable(columnsOf(s, 'before'), s.beforeImageRows), '</details>', '');
    }
    if (s.outcome.generatedKeys?.length) {
      lines.push(`Generated keys: ${s.outcome.generatedKeys.map((r) => r.map((v) => `\`${mdCell(valueText(v))}\``).join(', ')).join('; ')}`, '');
    }
  }
  return lines;
}

// ---------------------------------------------------------------- html

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlTable(columns: readonly DbColumn[], rows: readonly (readonly TypedValue[])[]): string {
  return `<div class="db-rows"><table><thead><tr>${columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(valueText(v))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

export const DB_SECTION_STYLE = `
.db-section .db-stmt { margin: .6rem 0; }
.db-section .db-head { font-size: .85rem; }
.db-section .db-head code { font-weight: 700; }
.db-section pre.db-sql { white-space: pre-wrap; word-break: break-word; padding: .5rem .7rem; border-radius: 6px; background: rgba(127,127,127,.12); }
.db-section .db-tx { margin: .9rem 0 .3rem; font-weight: 600; }
.db-section .db-sup { color: #0891b2; margin: .4rem 0; }
.db-section .db-err { color: #dc2626; }
.db-section .db-rows { max-height: 360px; overflow: auto; border: 1px solid rgba(127,127,127,.3); border-radius: 6px; }
.db-section .db-rows table { border-collapse: collapse; font-size: .8rem; width: 100%; }
.db-section .db-rows th, .db-section .db-rows td { padding: .2rem .5rem; border-bottom: 1px solid rgba(127,127,127,.2); text-align: left; font-family: Consolas, monospace; }
.db-section .db-rows th { position: sticky; top: 0; background: rgba(127,127,127,.15); }
`;

export function dbSectionHtml(call: CallRecord): string {
  const capture = call.dbCapture;
  if (!capture) return '';
  const parts: string[] = ['<section class="db-section">', '<h3>🗄 Database</h3>', `<p><em>${esc(headline(capture))}</em></p>`];
  const flags = capture.summary?.flags ?? [];
  if (flags.length) {
    parts.push(`<ul>${flags.map((f) => `<li>${f.severity === 'BAD' ? '✕' : '⚠'} ${esc(flagText(f))} (#${f.seqs.join(', #')})</li>`).join('')}</ul>`);
  }
  let tx: string | null = null;
  for (const item of itemsOf(capture)) {
    if (item.supplier) {
      parts.push(`<p class="db-sup"><b>#${item.seq}</b> ↗ supplier call <code>${esc(item.supplier.method ?? 'HTTP')}</code> ${esc(item.supplier.url ?? '')}</p>`);
      continue;
    }
    const s = item.statement!;
    if (s.txId && s.txId !== tx) {
      tx = s.txId;
      parts.push(`<p class="db-tx">${esc(txHeading(capture, s.txId))}</p>`);
    }
    parts.push('<div class="db-stmt">');
    parts.push(`<div class="db-head"><b>#${s.seq}</b> <code>${esc(verbOf(s))}</code> · ${esc(resultText(s))} · ${msText(s.durationMicros)} · +${(s.offsetMicros / 1000).toFixed(0)} ms${s.codeLocation ? ` · ${esc(s.codeLocation)}` : ''}${s.undone ? ' · <s>undone</s>' : ''}</div>`);
    parts.push(`<pre class="db-sql">${esc(statementSql(s))}</pre>`);
    if (s.outcome.kind === 'FAILED') {
      parts.push(`<p class="db-err">✕ ${esc(s.outcome.message ?? '')} (SQLState ${esc(s.outcome.sqlState ?? '-')}, vendor code ${s.outcome.vendorCode ?? '-'})${s.outcome.swallowed ? ' - caught by the application; the call still answered normally' : ''}</p>`);
    }
    if (s.rows?.length) {
      parts.push(`<details><summary>Rows (${s.rows.length.toLocaleString()} stored)</summary>${htmlTable(columnsOf(s, 'rows'), s.rows)}</details>`);
    }
    if (s.beforeImageRows?.length) {
      parts.push(`<details><summary>Rows before this ${esc(s.kind)} (${s.beforeImageRows.length.toLocaleString()})</summary>${htmlTable(columnsOf(s, 'before'), s.beforeImageRows)}</details>`);
    }
    if (s.outcome.generatedKeys?.length) {
      parts.push(`<p>Generated keys: ${s.outcome.generatedKeys.map((r) => r.map((v) => `<code>${esc(valueText(v))}</code>`).join(', ')).join('; ')}</p>`);
    }
    parts.push('</div>');
  }
  parts.push('</section>');
  return parts.join('');
}
