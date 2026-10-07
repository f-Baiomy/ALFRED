import { CallRecord } from '../../core/models/call.model';
import { ExportedStoreCommand } from '../../core/models/store-command.model';
import { mdCell } from './db-export-section';
import { msText } from './db-statement-display';

/**
 * The "⬢ Redis" section of a call in the .md and .html exports (specs/011-redis-capture, contracts/export-and-mcp.md):
 * a header line, then every command in the call's order - number, command, key, arguments, reply, time, offset, Spring
 * Cache origin and code line - and under it the command's value in full (decoded text with its format, or the raw bytes
 * as hex when Alfred cannot read them; a masked key as ‹masked · n B›). A MULTI/EXEC or pipeline is a heading with its
 * commands under it. Never cut, like everything else in an export.
 */

function redisOf(call: CallRecord): readonly ExportedStoreCommand[] {
  return call.dbCapture?.redis ?? [];
}

/** "22 commands · 5 miss · 1 failed · 25.4 ms" */
export function storeHeadline(cmds: readonly ExportedStoreCommand[]): string {
  const misses = cmds.filter((c) => c.outcome === 'MISS').length;
  const failed = cmds.filter((c) => c.outcome === 'FAILED').length;
  const micros = cmds.reduce((n, c) => n + c.micros, 0);
  return [`${cmds.length} command${cmds.length === 1 ? '' : 's'}`, misses ? `${misses} miss` : '', failed ? `${failed} failed` : '', msText(micros)]
    .filter((x) => !!x).join(' · ');
}

function offset(call: CallRecord, c: ExportedStoreCommand): string {
  if (!c.at) return '';
  const ms = Date.parse(c.at) - Date.parse(call.timestamp);
  return Number.isFinite(ms) ? `+${Math.max(0, Math.round(ms))} ms` : '';
}

function bytesOf(b64: string | null | undefined): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes as a hex dump, 32 per line - every byte, for a value Alfred could not decode. */
function hex(b64: string | null | undefined): string {
  const bytes = bytesOf(b64);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    lines.push(Array.from(bytes.subarray(i, i + 32), (b) => b.toString(16).padStart(2, '0')).join(' '));
  }
  return lines.join('\n');
}

function size(n: number): string {
  return `${n.toLocaleString('en-US')} B`;
}

function argsLine(c: ExportedStoreCommand): string {
  return (c.argsText ?? []).join(' ');
}

function replyLine(c: ExportedStoreCommand): string {
  if (c.outcome === 'FAILED') return c.error ?? 'failed';
  if (c.masked) return `‹masked · ${size(c.replyBytes)}›`;
  return c.replyText ?? '';
}

function originText(c: ExportedStoreCommand): string {
  const o = c.origin;
  if (!o) return '';
  return [o.cache ? `Spring Cache ${o.cache}` : '', o.operation ?? '', o.method ?? ''].filter((x) => !!x).join(' · ');
}

/** Each part of the command's value in full: what it wrote or read, what was there before. */
function valueParts(c: ExportedStoreCommand): { label: string; format: string; text: string }[] {
  const parts: { label: string; format: string; text: string }[] = [];
  if (c.masked) {
    parts.push({ label: 'Value', format: 'masked', text: `‹masked · ${size(Math.max(c.replyBytes, c.argsBytes))}›` });
    return parts;
  }
  if (c.valueText != null) parts.push({ label: 'Value', format: c.valueFormat ?? 'text', text: c.valueText });
  else if (c.replyText != null && c.replyText.length) parts.push({ label: 'Reply', format: c.replyFormat ?? 'text', text: c.replyText });
  else if (c.reply && c.replyBytes) parts.push({ label: 'Reply (raw bytes, hex)', format: 'hex', text: hex(c.reply) });
  if (c.beforeText != null) parts.push({ label: 'Value before the write', format: 'text', text: c.beforeText });
  else if (c.before && c.beforeBytes) parts.push({ label: 'Value before the write (raw bytes, hex)', format: 'hex', text: hex(c.before) });
  else if (c.beforeNote) parts.push({ label: 'Value before the write', format: 'note', text: c.beforeNote });
  return parts;
}

interface Run {
  readonly group: ExportedStoreCommand['group'];
  readonly commands: ExportedStoreCommand[];
}

/** Consecutive commands of one MULTI/EXEC or pipeline together, everything else alone. */
function runs(cmds: readonly ExportedStoreCommand[]): Run[] {
  const out: Run[] = [];
  for (const c of [...cmds].sort((a, b) => a.seq - b.seq)) {
    const last = out[out.length - 1];
    if (c.group && last?.group && last.group.id === c.group.id) last.commands.push(c);
    else out.push({ group: c.group ?? null, commands: [c] });
  }
  return out;
}

function groupTitle(run: Run): string {
  const g = run.group!;
  const kind = g.kind === 'tx' ? 'MULTI … EXEC' : 'pipeline';
  return `${kind} - ${run.commands.length} command${run.commands.length === 1 ? '' : 's'}`;
}

function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** One sentence for "About This Document" when calls carry Redis commands. */
export function storeCommandsSentence(calls: readonly CallRecord[]): string {
  const withRedis = calls.filter((c) => redisOf(c).length);
  if (!withRedis.length) return '';
  const total = withRedis.reduce((n, c) => n + redisOf(c).length, 0);
  const which = withRedis.length === 1 && calls.length === 1 ? 'It also carries' : `${withRedis.length} of the calls also carry`;
  return `${which} the Redis commands the application sent while handling ${withRedis.length === 1 ? 'it' : 'them'} (${total} in all), with every argument and reply whole - see each call's Redis section.`;
}

export function storeSectionMarkdown(call: CallRecord, level: number): string[] {
  const cmds = redisOf(call);
  if (!cmds.length) return [];
  const dropped = call.dbCapture?.redisSummary?.dropped ?? 0;
  const out: string[] = [
    `${'#'.repeat(level)} ⬢ Redis`, '', '<details>',
    `<summary><b>${mdCell(storeHeadline(cmds))}</b>${dropped ? ` · ${dropped} not kept (the agent's queue was full)` : ''}</summary>`, '',
    '| # | +ms | Command | Key | Arguments | Reply | Time | From |', '|---|---|---|---|---|---|---|---|',
  ];
  for (const run of runs(cmds)) {
    if (run.group) out.push(`| | | **${mdCell(groupTitle(run))}** | | | | | |`);
    for (const c of run.commands) {
      out.push(`| ${c.seq} | ${offset(call, c)} | \`${mdCell(c.command)}\` | ${mdCell(c.keys.join(' '))} | ${mdCell(argsLine(c))} | `
        + `${c.outcome === 'FAILED' ? '✖ ' : c.outcome === 'MISS' ? '(miss) ' : ''}${mdCell(replyLine(c))} | ${msText(c.micros)} | ${mdCell([originText(c), c.code ?? ''].filter((x) => !!x).join(' · '))} |`);
    }
  }
  out.push('', '<details>', '<summary>Each command\'s value in full</summary>', '');
  for (const c of [...cmds].sort((a, b) => a.seq - b.seq)) {
    const meta = [c.client, c.connection, c.server ? `${c.server} db ${c.db}` : '', c.thread ? `thread ${c.thread}` : '',
      c.poolWaitMicros != null ? `pool wait ${msText(c.poolWaitMicros)}` : ''].filter((x) => !!x).join(' · ');
    out.push(`**#${c.seq} ${mdCell(c.command)} ${mdCell(c.keys.join(' '))}** · ${size(c.argsBytes)} sent · ${size(c.replyBytes)} back${meta ? ` · ${mdCell(meta)}` : ''}`, '');
    if (c.argsText?.length) {
      const text = c.argsText.join('\n');
      const f = fence(text);
      out.push('Arguments:', '', f, text, f, '');
    }
    for (const p of valueParts(c)) {
      const f = fence(p.text);
      out.push(`${p.label} (${mdCell(p.format)}):`, '', `${f}${p.format === 'json' ? 'json' : ''}`, p.text, f, '');
    }
    if (c.callers?.length) out.push(`Code: ${c.callers.map((x) => `\`${mdCell(x)}\``).join(' ← ')}`, '');
  }
  out.push('</details>', '', '</details>', '');
  return out;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function commandHtml(call: CallRecord, c: ExportedStoreCommand): string {
  const cls = c.outcome === 'FAILED' ? ' x' : c.outcome === 'MISS' ? ' m' : '';
  const parts = valueParts(c).map((p) => `<div class="lbl">${esc(p.label)} · ${esc(p.format)}</div><pre>${esc(p.text)}</pre>`).join('');
  const args = c.argsText?.length ? `<div class="lbl">Arguments</div><pre>${esc(c.argsText.join('\n'))}</pre>` : '';
  const meta = [c.client, c.connection, c.server ? `${c.server} db ${c.db}` : '', c.thread ? `thread ${c.thread}` : '',
    c.poolWaitMicros != null ? `pool wait ${msText(c.poolWaitMicros)}` : '', originText(c), (c.callers?.length ? c.callers.join(' ← ') : c.code) ?? '']
    .filter((x) => !!x).join(' · ');
  return `<details class="rdc${cls}"><summary><span class="num">#${c.seq}</span><span class="at">${esc(offset(call, c))}</span>`
    + `<span class="cmd">${esc(c.command)}</span><span class="key">${esc(c.keys.join(' '))}</span><span class="rep">${esc(replyLine(c))}</span>`
    + `<span class="ms">${msText(c.micros)}</span></summary><div class="d"><div class="meta">${esc(meta)} · ${size(c.argsBytes)} sent · ${size(c.replyBytes)} back</div>${args}${parts}</div></details>`;
}

export function storeSectionHtml(call: CallRecord): string {
  const cmds = redisOf(call);
  if (!cmds.length) return '';
  const dropped = call.dbCapture?.redisSummary?.dropped ?? 0;
  const failed = cmds.filter((c) => c.outcome === 'FAILED').length;
  const misses = cmds.filter((c) => c.outcome === 'MISS').length;
  const chips = `<span class="chip"><b>${cmds.length}</b> commands</span><span class="chip"><b>${msText(cmds.reduce((n, c) => n + c.micros, 0))}</b></span>`
    + (misses ? `<span class="chip w"><b>${misses}</b> miss</span>` : '') + (failed ? `<span class="chip x"><b>${failed}</b> failed</span>` : '')
    + (dropped ? `<span class="chip w"><b>${dropped}</b> not kept</span>` : '');
  const body = runs(cmds).map((run) => run.group
    ? `<details class="rdg" open><summary>${esc(groupTitle(run))}</summary>${run.commands.map((c) => commandHtml(call, c)).join('')}</details>`
    : commandHtml(call, run.commands[0])).join('');
  return `<details class="rdx"><summary><span class="t">⬢ Redis</span>${chips}</summary><div class="inner">`
    + `<p class="lead">The Redis commands the application sent while handling this call, in the call's order. Open a command for its arguments and value in full.</p>`
    + `${body}</div></details>`;
}

export const STORE_SECTION_STYLE = `
.rdx{margin:.8rem 0;border:1px solid rgba(220,56,44,.35);border-radius:10px;background:rgba(220,56,44,.04)}
.rdx>summary{cursor:pointer;padding:.5rem .7rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.rdx>summary .t{font-weight:700;color:#b91c1c}
.rdx .inner{padding:.2rem .7rem .7rem}
.rdx .lead{margin:.2rem 0 .5rem;font-size:.9em}
.rdg{margin:.3rem 0;border-left:3px solid rgba(220,56,44,.4);padding-left:.5rem}
.rdg>summary{cursor:pointer;font-weight:700;font-size:.85em}
.rdc{border-top:1px dashed rgba(127,127,127,.3)}
.rdc>summary{cursor:pointer;display:grid;grid-template-columns:3rem 4.5rem 5.5rem minmax(0,1fr) minmax(0,1.2fr) 4.5rem;gap:.5rem;padding:.2rem 0;font-size:.86em}
.rdc .num,.rdc .at,.rdc .ms{font-family:monospace;opacity:.7}.rdc .cmd{font-weight:700;font-family:monospace}
.rdc .key,.rdc .rep{font-family:monospace;white-space:pre-wrap;word-break:break-all}
.rdc.x .cmd,.rdc.x .rep{color:#dc2626}.rdc.m .rep{color:#d97706}
.rdc .meta{font-size:.8em;opacity:.75;margin:.2rem 0}
.rdc .lbl{font-size:.78em;font-weight:700;opacity:.8;margin-top:.3rem}
.rdc pre{white-space:pre-wrap;word-break:break-all;font-size:.8em;margin:.2rem 0 .5rem}
`;
