import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture, DbColumn, DbFlag, ExportedDbStatement, TypedValue } from '../../core/models/db-capture.model';
import { beforeAfter } from './db-before-after';
import { flagText } from './db-flags';
import { msText, resultText, valueText, verbOf } from './db-statement-display';
import { DbGroupNode, DbNode, buildStatementTree, statementsOf } from './db-statement-tree';
import { renderSql, sqlText } from './sql-render';

/**
 * The "Database" section of a call in the .md and .html exports (specs/006-db-capture/export-mock.html): ONE closed
 * block per call with a one-line headline; opened, the flags, then every statement in run order as a closed one-line
 * row - transactions and repeated queries as closed groups, supplier calls where they ran - each row opening to its
 * SQL, parameters, error, before → after, rows and code location. Never truncated: every statement and every stored
 * row is in the file, only folded. Present only when the user ticked "Include database statements" (the dialog leaves
 * `dbCapture` off the calls otherwise). Values are as captured, after redact.ts.
 */

const REPEAT_THRESHOLD = 5;

function stats(capture: CallDbCapture) {
  const s = capture.statements;
  return {
    statements: s.length,
    writes: s.filter((x) => ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DDL'].includes(x.kind)).length,
    failed: s.filter((x) => x.outcome.kind === 'FAILED').length,
    transactions: capture.transactions.length,
    rolledBack: capture.transactions.filter((t) => t.outcome === 'ROLLED_BACK').length,
    micros: s.reduce((a, x) => a + x.durationMicros, 0),
    flags: capture.summary?.flags ?? [],
  };
}

function treeOf(capture: CallDbCapture): DbNode[] {
  return capture.layout === 'flat'
    ? buildStatementTree(capture.statements, capture.supplierMarkers ?? [], [], Number.MAX_SAFE_INTEGER)
    : buildStatementTree(capture.statements, capture.supplierMarkers ?? [], capture.transactions, REPEAT_THRESHOLD);
}

function statementSql(s: ExportedDbStatement): string {
  return s.params.length > 1 ? s.params.map((set) => `${sqlText(s.sql, set)};`).join('\n') : sqlText(s.sql, s.params[0]);
}

function columnsOf(s: ExportedDbStatement, part: 'rows' | 'before'): readonly DbColumn[] {
  const cols = part === 'rows' ? s.outcome.columns : s.beforeImage?.columns;
  const width = (part === 'rows' ? s.rows : s.beforeImageRows)?.[0]?.length ?? 0;
  if (cols && cols.length) return cols;
  return Array.from({ length: width }, (_, i) => ({ name: `col${i + 1}`, type: '' }));
}

/** The rows an UPDATE's "before" values come from: its own before-image, or the earlier read it was linked to. */
function beforeSource(s: ExportedDbStatement, bySeq: ReadonlyMap<number, ExportedDbStatement>): { columns: readonly DbColumn[]; row: readonly TypedValue[] } | null {
  const b = s.beforeImage;
  if (b?.source === 'AGENT_READ' && s.beforeImageRows?.length) return { columns: columnsOf(s, 'before'), row: s.beforeImageRows[0] };
  if (b?.source === 'EARLIER_READ' && b.earlierSeq != null) {
    const earlier = bySeq.get(b.earlierSeq);
    if (earlier?.rows?.length) return { columns: columnsOf(earlier, 'rows'), row: earlier.rows[0] };
  }
  return null;
}

function groupLabel(g: DbGroupNode): string {
  const all = statementsOf(g);
  const range = `#${g.seq}–#${all[all.length - 1]?.seq ?? g.seq}`;
  if (g.type === 'repeat') return `${verbOf(all[0])} ${all[0].table ?? ''} ×${all.length} · ${range}`.replace(/\s+/g, ' ');
  const tx = g.tx!;
  const outcome = tx.outcome === 'ROLLED_BACK' ? 'rolled back - nothing in it was saved' : tx.outcome === 'OPEN' ? 'never ended' : 'committed';
  const writes = all.filter((x) => ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(x.kind)).length;
  return `Transaction ${tx.txId} · ${outcome} · ${all.length} statements · ${writes} writes · held ${msText(tx.heldMicros)} · ${range}`;
}

function headlineText(capture: CallDbCapture): string {
  const s = stats(capture);
  return `${s.statements} statements · ${s.writes} writes · ${s.failed} failed · ${s.transactions} transactions${s.rolledBack ? ` (${s.rolledBack} rolled back)` : ''} · ${msText(s.micros)} in DB${s.flags.length ? ` · ${s.flags.length} flags` : ''}`;
}

// ================================================================ html

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sqlHtml(sql: string, params: readonly TypedValue[] | undefined, pretty: boolean): string {
  return renderSql(sql, params, { filled: true, pretty })
    .map((t) => (t.kind === 'kw' ? `<span class="kw">${esc(t.text)}</span>` : t.kind === 'text' ? esc(t.text) : `<span class="val">${esc(t.text)}</span>`))
    .join('');
}

function tableHtml(columns: readonly DbColumn[], rows: readonly (readonly TypedValue[])[]): string {
  return `<table class="kv"><thead><tr>${columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(valueText(v))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function verbClass(s: ExportedDbStatement): string {
  if (s.outcome.kind === 'FAILED' || s.kind === 'ROLLBACK') return 'v-fail';
  if (s.kind === 'DELETE') return 'v-del';
  if (s.kind === 'COMMIT' || s.outcome.kind === 'TX_END') return 'v-tx';
  if (['INSERT', 'UPDATE', 'MERGE', 'DDL'].includes(s.kind)) return 'v-write';
  return 'v-read';
}

function statementHtml(s: ExportedDbStatement, id: string, bySeq: ReadonlyMap<number, ExportedDbStatement>): string {
  const failed = s.outcome.kind === 'FAILED';
  const noWhere = (s.kind === 'DELETE' || s.kind === 'UPDATE') && !/\bWHERE\b/i.test(s.sql.replace(/'(?:[^']|'')*'/g, "''"));
  const slow = s.durationMicros > 5000;
  const parts: string[] = [];
  parts.push(`<div class="lbl">Statement</div><pre class="sql">${sqlHtml(s.sql, s.params[0], true)}</pre>`);
  if (s.params.length > 1) {
    parts.push(`<div class="lbl">Sent with executeBatch - ${s.params.length} parameter sets</div><pre class="sql">${esc(statementSql(s))}</pre>`);
  }
  const first = s.params[0] ?? [];
  if (first.length) {
    parts.push(`<div class="lbl">Parameters</div><table class="kv"><thead><tr><th>#</th><th>type</th><th>value</th></tr></thead><tbody>${first
      .map((v, i) => `<tr><td>${i + 1}</td><td>${esc(v.type ?? '')}</td><td>${esc(valueText(v))}</td></tr>`).join('')}</tbody></table>`);
  }
  if (failed) {
    parts.push(`<div class="err">✕ ${esc(s.outcome.message ?? '')} · SQLState ${esc(s.outcome.sqlState ?? '-')} · code ${s.outcome.vendorCode ?? '-'}${
      s.outcome.swallowed ? '<br>Caught by the application - the call still answered normally.' : ''}</div>`);
  }
  if (noWhere && !failed) parts.push(`<div class="err">No WHERE - every row in ${esc(s.table ?? 'the table')} was ${s.kind === 'DELETE' ? 'removed' : 'changed'}.</div>`);
  if (s.kind === 'UPDATE' && !failed) {
    const before = beforeSource(s, bySeq);
    const rows = beforeAfter(s, before?.columns ?? null, before?.row ?? null);
    if (rows.length) {
      const label = s.beforeImage?.source === 'EARLIER_READ' ? `read in #${s.beforeImage.earlierSeq}` : before ? 'before-image' : 'not captured';
      parts.push(`<div class="lbl">Before → after (${esc(label)})</div><table class="kv"><thead><tr><th>column</th><th>before</th><th>after</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td>${esc(r.column)}</td><td>${r.before == null ? '<span class="dim">not captured</span>' : esc(r.before)}</td><td class="chg">${esc(r.after)}</td></tr>`).join('')}</tbody></table>`);
    }
  }
  if (s.rows?.length) {
    const read = s.outcome.rowsRead ?? s.rows.length;
    parts.push(`<div class="lbl">Rows (${s.rows.length.toLocaleString()} stored${read > s.rows.length ? ` of ${read.toLocaleString()} returned` : ''})</div><div class="rows">${tableHtml(columnsOf(s, 'rows'), s.rows)}</div>`);
  }
  if (s.beforeImageRows?.length) {
    parts.push(`<div class="lbl">${s.undone ? 'Rows it would have ' : 'Rows before this '}${esc(s.kind.toLowerCase())}${s.undone ? 'd' : ''} (${s.beforeImageRows.length.toLocaleString()})</div><div class="rows">${tableHtml(columnsOf(s, 'before'), s.beforeImageRows)}</div>`);
  } else if (s.beforeImage?.source === 'EARLIER_READ' && s.kind === 'DELETE') {
    parts.push(`<div class="where">Deleted rows: the ones read in <a href="#${id.replace(/-s\d+$/, '')}-s${s.beforeImage.earlierSeq}" data-db-jump>#${s.beforeImage.earlierSeq}</a>.</div>`);
  }
  for (const child of s.cascadesTo ?? []) parts.push(`<div class="where">⚠ ON DELETE CASCADE → ${esc(child)} - the database removed those rows itself; JDBC never reports them.</div>`);
  if (s.outcome.generatedKeys?.length) {
    parts.push(`<div class="lbl">Generated keys</div><table class="kv"><tbody>${s.outcome.generatedKeys.map((r) => `<tr>${r.map((v) => `<td>${esc(valueText(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  }
  if (s.codeLocation) parts.push(`<div class="where">Called from <code>${esc(s.codeLocation)}</code> · thread ${esc(s.thread)} · +${(s.offsetMicros / 1000).toFixed(0)} ms</div>`);

  const cls = ['st', failed || noWhere ? 'fail' : '', s.undone ? 'undone' : ''].filter(Boolean).join(' ');
  return `<details class="${cls}" id="${id}"><summary><span class="num">#${s.seq}</span><span class="verb ${verbClass(s)}">${esc(verbOf(s))}</span>` +
    `<span class="sql1">${sqlHtml(s.sql, s.params[0], false)}</span><span class="res">${esc(resultText(s))}</span>` +
    `<span class="ms${slow ? ' slow' : ''}">${msText(s.durationMicros)}</span></summary><div class="d">${parts.join('')}</div></details>`;
}

function nodesHtml(nodes: readonly DbNode[], prefix: string, bySeq: ReadonlyMap<number, ExportedDbStatement>): string {
  return nodes.map((n) => {
    if (n.type === 'stmt') return statementHtml(n.statement as ExportedDbStatement, `${prefix}-s${n.seq}`, bySeq);
    if (n.type === 'supplier') {
      return `<div class="sup" id="${prefix}-s${n.seq}"><span class="num">#${n.seq}</span>↗ ${esc(n.marker.method ?? 'HTTP')} ${esc(n.marker.url ?? '')}</div>`;
    }
    const cls = n.type === 'repeat' ? 'grp rep' : `grp${n.rolledBack ? ' rolled' : ''}`;
    const id = n.type === 'tx' ? `${prefix}-tx-${(n.tx?.txId ?? '').replace(/[^\w-]/g, '')}` : `${prefix}-rep${n.seq}`;
    return `<details class="${cls}" id="${id}"><summary>${esc(groupLabel(n))}</summary>${nodesHtml(n.children, prefix, bySeq)}</details>`;
  }).join('');
}

const FLAG_GROUP_LABELS: Record<string, string> = {
  SLOW: 'Slow statements', HUGE_RESULT: 'Huge results', REPEATED_QUERY: 'Repeated queries', FAILED: 'Failed statements',
  FAILED_SWALLOWED: 'Failed and swallowed', NO_WHERE: 'Without WHERE', LARGE_DELETE: 'Large deletes', ROLLED_BACK: 'Rolled back',
  LOCK_DURING_SUPPLIER_CALL: 'Locks held during supplier calls', CASCADE: 'Cascades not visible',
};

/** Flags in their order, same-type ones together (the first of each type keeps its place). */
function flagGroups(flags: readonly DbFlag[]): DbFlag[][] {
  const groups = new Map<string, DbFlag[]>();
  for (const f of flags) groups.set(f.type, [...(groups.get(f.type) ?? []), f]);
  return [...groups.values()];
}

function flagHref(prefix: string, f: { seqs: readonly number[]; group?: string | null; type: string }): string {
  if (f.type === 'ROLLED_BACK' && f.group) return `#${prefix}-tx-${f.group.replace(/[^\w-]/g, '')}`;
  return `#${prefix}-s${f.seqs[0] ?? ''}`;
}

export function dbSectionHtml(call: CallRecord): string {
  const capture = call.dbCapture;
  if (!capture) return '';
  const s = stats(capture);
  const prefix = `db-${call.id.replace(/[^\w-]/g, '')}`;
  const bySeq = new Map(capture.statements.map((x) => [x.seq, x]));
  const bad = s.flags.some((f) => f.severity === 'BAD');
  const chips = [
    `<span class="chip"><b>${s.statements}</b> statements</span>`,
    `<span class="chip w"><b>${s.writes}</b> writes</span>`,
    `<span class="chip${s.failed ? ' x' : ''}"><b>${s.failed}</b> failed</span>`,
    `<span class="chip"><b>${s.transactions}</b> transactions${s.rolledBack ? ` · ${s.rolledBack} rolled back` : ''}</span>`,
    `<span class="chip"><b>${msText(s.micros)}</b> in DB</span>`,
    s.flags.length ? `<span class="chip${bad ? ' x' : ''}"><b>${s.flags.length}</b> flags</span>` : '',
  ].join('');
  const flagLine = (f: DbFlag) => `<div class="flag${f.severity === 'BAD' ? ' bad' : ''}">${f.severity === 'BAD' ? '✕' : '⚠'} ${esc(flagText(f))} <a href="${flagHref(prefix, f)}" data-db-jump>${f.type === 'ROLLED_BACK' && f.group ? esc(f.group) : `#${f.seqs[0]}`} ↓</a></div>`;
  // Three or more of one kind (a busy call can have twenty "Slow") become one closed line, so the list stays short.
  const flags = s.flags.length
    ? `<div class="flags">${flagGroups(s.flags).map((g) => g.length < 3 ? g.map(flagLine).join('')
      : `<details class="flag-group${g[0].severity === 'BAD' ? ' bad' : ''}"><summary>${g[0].severity === 'BAD' ? '✕' : '⚠'} ${esc(FLAG_GROUP_LABELS[g[0].type] ?? g[0].type)} × ${g.length}</summary>${g.map(flagLine).join('')}</details>`).join('')}</div>`
    : '';
  return `<details class="dbx" id="${prefix}"><summary><span class="t">🗄 Database</span>${chips}</summary><div class="inner">` +
    `<p class="lead">Every statement the application ran while handling this call, <b>in the order it ran</b>, values filled in. Supplier calls are shown where they happened. ${
      capture.layout === 'flat' ? 'Listed one by one, not grouped by transaction' : 'Transactions and repeated queries start closed'} - open a row for its SQL, parameters and rows.</p>` +
    flags +
    `<div class="tools"><button type="button" data-db-all="open">Open all statements</button><button type="button" data-db-all="close">Close all</button></div>` +
    `<div class="stmts">${nodesHtml(treeOf(capture), prefix, bySeq)}</div></div></details>`;
}

/** The DB column of the export's summary table: "◆ 49" for a call that carries statements. */
export function dbSummaryCell(call: CallRecord): string {
  return call.dbCapture ? `◆ ${call.dbCapture.statements.length}` : '—';
}

export const DB_SECTION_STYLE = `
.dbx { border: 1px solid rgba(45, 212, 191, .35); border-radius: 12px; background: rgba(45, 212, 191, .04); margin: 1.2rem 0 0.6rem; }
.dbx summary::-webkit-details-marker { display: none; }
.dbx > summary { cursor: pointer; list-style: none; padding: .7rem .9rem; display: flex; flex-wrap: wrap; gap: .45rem .6rem; align-items: center; }
.dbx > summary .t { font-weight: 700; color: #2dd4bf; }
.dbx > summary::before { content: "▸"; color: #2dd4bf; }
.dbx[open] > summary::before { content: "▾"; }
.dbx[open] > summary { border-bottom: 1px solid rgba(45, 212, 191, .25); }
.dbx .chip { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-strong); color: var(--text-dim); white-space: nowrap; }
.dbx .chip b { color: var(--text); }
.dbx .chip.w b { color: var(--amber); } .dbx .chip.x { border-color: rgba(227,106,106,.5); } .dbx .chip.x b { color: var(--red); }
.dbx .inner { padding: .8rem .9rem 1rem; }
.dbx .lead { color: var(--text-dim); font-size: 13px; margin: 0 0 .7rem; }
.dbx .lead b { color: var(--text); }
.dbx .flags { display: flex; flex-direction: column; gap: 4px; margin-bottom: .9rem; }
.dbx .flag { font-size: 12.5px; padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(227,162,74,.4); background: rgba(227,162,74,.07); color: var(--amber); }
.dbx .flag.bad { color: var(--red); border-color: rgba(227,106,106,.45); background: rgba(227,106,106,.07); }
.dbx .flag a { margin-left: .4rem; font-size: 12px; }
.dbx .flag-group { border: 1px solid rgba(227,162,74,.4); background: rgba(227,162,74,.05); border-radius: 8px; color: var(--amber); font-size: 12.5px; }
.dbx .flag-group.bad { border-color: rgba(227,106,106,.45); color: var(--red); }
.dbx .flag-group > summary { cursor: pointer; list-style: none; padding: 4px 10px; }
.dbx .flag-group > summary::before { content: "▸ "; } .dbx .flag-group[open] > summary::before { content: "▾ "; }
.dbx .flag-group .flag { border: none; border-top: 1px solid rgba(255,255,255,.05); border-radius: 0; background: none; padding-left: 1.6rem; }
.dbx .tools { display: flex; gap: 6px; margin: 0 0 .6rem; }
.dbx .tools button { font: inherit; font-size: 12px; background: var(--card-inner); color: var(--text-dim); border: 1px solid var(--border); border-radius: 999px; padding: 2px 11px; cursor: pointer; }
.dbx .stmts { height: 560px; overflow: auto; padding: 6px 4px 6px 0; border-top: 1px solid rgba(45,212,191,.2); border-bottom: 1px solid rgba(45,212,191,.2); scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
.dbx .st { border: 1px solid var(--border); border-radius: 8px; background: var(--card); margin-bottom: 4px; min-width: 0; }
.dbx .st > summary { cursor: pointer; list-style: none; display: grid; grid-template-columns: 38px 76px minmax(0,1fr) auto 62px; gap: .6rem; align-items: center; padding: .35rem .6rem; font-size: 12.5px; }
.dbx .st > summary:hover { background: rgba(255,255,255,.03); }
.dbx .st[open] > summary { border-bottom: 1px solid var(--border); }
.dbx .num { color: var(--text-faint); font-family: "SFMono-Regular", Consolas, monospace; font-size: 11.5px; }
.dbx .verb { font-size: 10.5px; font-weight: 700; text-align: center; padding: 1px 4px; border-radius: 5px; border: 1px solid; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbx .v-read { color: #2dd4bf; border-color: rgba(45,212,191,.35); background: rgba(45,212,191,.08); }
.dbx .v-write { color: var(--amber); border-color: rgba(227,162,74,.4); background: rgba(227,162,74,.08); }
.dbx .v-del, .dbx .v-fail { color: var(--red); border-color: rgba(227,106,106,.45); background: rgba(227,106,106,.08); }
.dbx .v-tx { color: var(--green); border-color: rgba(126,227,160,.35); background: rgba(126,227,160,.07); }
.dbx .sql1 { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; color: #cfeee9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dbx .res { color: var(--text-dim); font-size: 12px; white-space: nowrap; }
.dbx .ms { color: var(--green); font-size: 12px; text-align: right; font-family: "SFMono-Regular", Consolas, monospace; }
.dbx .ms.slow { color: var(--amber); }
.dbx .st.fail > summary .res { color: var(--red); font-weight: 600; }
.dbx .st.undone .sql1 { text-decoration: line-through; opacity: .7; }
.dbx .st .d { padding: .7rem .8rem .8rem; min-width: 0; }
.dbx .lbl { color: var(--text-faint); font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; font-weight: 600; margin: .6rem 0 .3rem; }
.dbx .lbl:first-child { margin-top: 0; }
.dbx pre.sql { margin: 0; padding: .55rem .7rem; background: var(--card-inner); border: 1px solid var(--border); border-radius: 8px; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; color: #d7f7f2; }
.dbx .kw { color: #7dd3fc; } .dbx .val { color: var(--amber); }
.dbx table.kv { border-collapse: collapse; font-size: 12px; background: var(--card-inner); min-width: 100%; }
.dbx table.kv th { text-align: left; color: var(--text-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; padding: .3rem .6rem; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: #151517; white-space: nowrap; }
.dbx table.kv td { padding: .28rem .6rem; border-bottom: 1px solid rgba(255,255,255,.04); font-family: "SFMono-Regular", Consolas, monospace; white-space: nowrap; }
.dbx td.chg { color: var(--amber); } .dbx .dim { color: var(--text-faint); }
.dbx .d > table.kv { display: block; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
.dbx .rows { max-height: 280px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.dbx .where { color: var(--text-dim); font-size: 12px; margin-top: .6rem; }
.dbx .where code { color: var(--text); }
.dbx .err { color: var(--red); font-size: 12.5px; padding: .45rem .7rem; border: 1px solid rgba(227,106,106,.4); border-radius: 8px; background: rgba(227,106,106,.06); margin-top: .6rem; }
.dbx .grp { border-left: 2px solid rgba(126,227,160,.45); padding-left: .6rem; margin: .4rem 0 .5rem; }
.dbx .grp.rolled { border-left-color: rgba(227,106,106,.6); }
.dbx .grp.rep { border-left-color: rgba(227,162,74,.55); }
.dbx .grp > summary { cursor: pointer; list-style: none; font-size: 12.5px; padding: .3rem .2rem; color: var(--green); font-weight: 600; }
.dbx .grp.rolled > summary { color: var(--red); }
.dbx .grp.rep > summary { color: var(--amber); }
.dbx .grp > summary::before { content: "▸ "; } .dbx .grp[open] > summary::before { content: "▾ "; }
.dbx .sup { display: flex; gap: .6rem; align-items: center; font-size: 12px; padding: .3rem .6rem; margin: 4px 0; border-top: 1px dashed rgba(126,227,216,.35); border-bottom: 1px dashed rgba(126,227,216,.35); color: var(--cyan); font-family: "SFMono-Regular", Consolas, monospace; overflow-wrap: anywhere; }
@media (max-width: 640px) { .dbx .st > summary { grid-template-columns: 34px 66px minmax(0,1fr) 54px; } .dbx .st > summary .res { display: none; } }
`;

/** "Open all / Close all" and links to a statement inside closed blocks - plain DOM, no dependencies. */
export const DB_SECTION_SCRIPT = `
document.addEventListener('click', function (e) {
  var all = e.target.closest && e.target.closest('[data-db-all]');
  if (all) {
    var box = all.closest('.dbx');
    box.querySelectorAll('.stmts details').forEach(function (d) { d.open = all.getAttribute('data-db-all') === 'open'; });
    return;
  }
  var jump = e.target.closest && e.target.closest('a[data-db-jump]');
  if (jump) {
    var target = document.getElementById(decodeURIComponent(jump.getAttribute('href').slice(1)));
    if (!target) return;
    e.preventDefault();
    for (var p = target; p; p = p.parentElement) { if (p.tagName === 'DETAILS') p.open = true; }
    target.scrollIntoView({ block: 'center' });
  }
});
`;

// ================================================================ markdown

/** A fence longer than any backtick run inside, so captured text can never close it. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A markdown table cell (or summary text): pipes escaped, newlines kept as <br>, HTML neutralised. */
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

function overviewRows(nodes: readonly DbNode[], out: string[]): void {
  for (const n of nodes) {
    if (n.type === 'stmt') {
      const s = n.statement;
      out.push(`| ${s.seq} | \`${mdCell(verbOf(s))}\` ${mdCell(s.table ?? '')} | ${mdCell(resultText(s))} | ${(s.durationMicros / 1000).toFixed(1)} |`);
    } else if (n.type === 'supplier') {
      out.push(`| ${n.seq} | ↗ ${mdCell(n.marker.method ?? 'HTTP')} ${mdCell(n.marker.url ?? '')} | | |`);
    } else if (n.type === 'repeat') {
      const all = statementsOf(n);
      const micros = all.reduce((a, x) => a + x.durationMicros, 0);
      out.push(`| ${n.seq}–${all[all.length - 1].seq} | \`${mdCell(verbOf(all[0]))}\` ${mdCell(all[0].table ?? '')} ×${all.length} | ${mdCell(resultText(all[0]))} each | ${(micros / 1000).toFixed(1)} |`);
    } else {
      out.push(`| | **${mdCell(groupLabel(n))}** | | |`);
      overviewRows(n.children, out);
    }
  }
}

function statementMd(s: ExportedDbStatement, bySeq: ReadonlyMap<number, ExportedDbStatement>): string[] {
  const lines: string[] = ['<details>', `<summary>#${s.seq} ${mdCell(verbOf(s))} ${mdCell(s.table ?? '')} · ${mdCell(resultText(s))} · ${msText(s.durationMicros)}${s.undone ? ' · undone' : ''}</summary>`, ''];
  lines.push(fence(statementSql(s), 'sql'), '');
  const first = s.params[0] ?? [];
  if (first.length && s.params.length === 1) {
    lines.push('| # | type | value |', '|---|---|---|', ...first.map((v, i) => `| ${i + 1} | ${mdCell(v.type ?? '')} | ${mdCell(valueText(v))} |`), '');
  }
  if (s.outcome.kind === 'FAILED') {
    lines.push(`> ✕ ${mdCell(s.outcome.message ?? '')} (SQLState ${mdCell(s.outcome.sqlState ?? '-')}, code ${s.outcome.vendorCode ?? '-'})${s.outcome.swallowed ? ' - caught by the application; the call still answered normally' : ''}`, '');
  }
  if (s.kind === 'UPDATE' && s.outcome.kind !== 'FAILED') {
    const before = beforeSource(s, bySeq);
    const rows = beforeAfter(s, before?.columns ?? null, before?.row ?? null);
    if (rows.length) {
      const label = s.beforeImage?.source === 'EARLIER_READ' ? `before (#${s.beforeImage.earlierSeq})` : 'before';
      lines.push(`| column | ${label} | after |`, '|---|---|---|', ...rows.map((r) => `| ${mdCell(r.column)} | ${r.before == null ? '_not captured_' : mdCell(r.before)} | ${mdCell(r.after)} |`), '');
    }
  }
  if (s.rows?.length) lines.push(`Rows (${s.rows.length.toLocaleString()} stored):`, '', ...mdTable(columnsOf(s, 'rows'), s.rows));
  if (s.beforeImageRows?.length) lines.push(`Rows before this ${s.kind.toLowerCase()} (${s.beforeImageRows.length.toLocaleString()}):`, '', ...mdTable(columnsOf(s, 'before'), s.beforeImageRows));
  if (s.outcome.generatedKeys?.length) lines.push(`Generated keys: ${s.outcome.generatedKeys.map((r) => r.map((v) => `\`${mdCell(valueText(v))}\``).join(', ')).join('; ')}`, '');
  for (const child of s.cascadesTo ?? []) lines.push(`⚠ ON DELETE CASCADE → ${mdCell(child)} (not visible to JDBC)`, '');
  if (s.codeLocation) lines.push(mdCell(s.codeLocation), '');
  lines.push('</details>', '');
  return lines;
}

export function dbSectionMarkdown(call: CallRecord, level: number): string[] {
  const capture = call.dbCapture;
  if (!capture) return [];
  const s = stats(capture);
  const bySeq = new Map(capture.statements.map((x) => [x.seq, x]));
  const lines: string[] = [`${'#'.repeat(level)} 🗄 Database`, '', '<details>', `<summary><b>${mdCell(headlineText(capture))}</b></summary>`, ''];
  if (s.flags.length) {
    lines.push('**Flags**', '');
    for (const g of flagGroups(s.flags)) {
      const mark = g[0].severity === 'BAD' ? '✕' : '⚠';
      if (g.length < 3) lines.push(...g.map((f) => `- ${mark} ${mdCell(flagText(f))} (#${f.seqs.join(', #')})`));
      else lines.push(`- ${mark} ${mdCell(FLAG_GROUP_LABELS[g[0].type] ?? g[0].type)} × ${g.length}: ${g.map((f) => `#${f.seqs[0]}`).join(', ')}`);
    }
    lines.push('');
  }
  lines.push('| # | Statement | Result | ms |', '|---|---|---|---|');
  overviewRows(treeOf(capture), lines);
  lines.push('');
  for (const st of capture.statements) lines.push(...statementMd(st, bySeq));
  lines.push('</details>', '');
  return lines;
}
