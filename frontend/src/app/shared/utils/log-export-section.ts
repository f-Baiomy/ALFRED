import { CallRecord } from '../../core/models/call.model';
import { LinkedLogLine } from '../../core/models/call-logs.model';
import { mdCell } from './db-export-section';

/**
 * The "📜 Logs" section of a call in the .md and .html exports (specs/008-logs-call-link, contracts/export-format.md):
 * every application log line written during the call, oldest first - offset from the call's start, level, thread,
 * the whole message - each opening to the whole original line. Never cut, like everything else in an export.
 */

function matchedText(lines: readonly LinkedLogLine[]): string {
  if (lines.every((l) => l.matchedBy === 'CAUGHT')) return 'caught by the agent inside the application, in the call’s own order';
  const exact = lines.filter((l) => l.matchedBy === 'EXACT').length;
  if (exact === lines.length) return 'matched exactly by the call id';
  if (exact === 0) return 'matched by request thread and time';
  return `${exact} matched by the call id, ${lines.length - exact} by request thread and time`;
}

function offset(ms: number): string {
  const sign = ms < 0 ? '−' : '+';
  const a = Math.abs(ms);
  return sign + (a >= 1000 ? `${(a / 1000).toFixed(2)} s` : `${Math.round(a)} ms`);
}

function sources(lines: readonly LinkedLogLine[]): string {
  return [...new Set(lines.map((l) => l.sourceName))].join(', ');
}

/** A code fence longer than any run of backticks in the text, so a line holding ``` cannot end it early. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** One sentence for "About This Document" when calls carry log lines. */
export function logLinesSentence(calls: readonly CallRecord[]): string {
  const withLogs = calls.filter((c) => c.logLines?.length);
  if (!withLogs.length) return '';
  const total = withLogs.reduce((n, c) => n + c.logLines!.length, 0);
  const which = withLogs.length === 1 && calls.length === 1 ? 'It also carries' : `${withLogs.length} of the calls also carry`;
  return `${which} the application log lines written while handling ${withLogs.length === 1 ? 'it' : 'them'} (${total} in all), whole - see each call's Logs section.`;
}

export function logSectionMarkdown(call: CallRecord, level: number): string[] {
  const lines = call.logLines;
  if (!lines?.length) return [];
  const out: string[] = [
    `${'#'.repeat(level)} 📜 Logs`, '', '<details>',
    `<summary><b>${lines.length} log line${lines.length === 1 ? '' : 's'} from ${mdCell(sources(lines))}, ${matchedText(lines)}</b></summary>`, '',
    '| +ms | Level | Thread | Message |', '|---|---|---|---|',
  ];
  for (const l of lines) {
    out.push(`| ${offset(l.offsetMs)} | ${mdCell(l.level ?? '')} | ${mdCell(l.thread ?? '')} | ${mdCell(l.message)} |`);
  }
  out.push('', '<details>', '<summary>Each line as written</summary>', '');
  for (const l of lines) {
    const f = fence(l.raw);
    out.push(`**${offset(l.offsetMs)} ${mdCell(l.level ?? '')}** · ${mdCell(l.sourceName)}${l.kept ? ' · kept copy' : ''}`, '', `${f}json`, l.raw, f, '');
  }
  out.push('</details>', '', '</details>', '');
  return out;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function levelClass(level: string | null): string {
  const l = (level ?? '').toUpperCase();
  if (l === 'ERROR' || l === 'FATAL' || l === 'SEVERE') return ' x';
  if (l === 'WARN' || l === 'WARNING') return ' w';
  return '';
}

export function logSectionHtml(call: CallRecord): string {
  const lines = call.logLines;
  if (!lines?.length) return '';
  const errors = lines.filter((l) => levelClass(l.level) === ' x').length;
  const warnings = lines.filter((l) => levelClass(l.level) === ' w').length;
  const chips = `<span class="chip"><b>${lines.length}</b> lines</span>` +
    (errors ? `<span class="chip x"><b>${errors}</b> errors</span>` : '') + (warnings ? `<span class="chip w"><b>${warnings}</b> warnings</span>` : '');
  const rows = lines.map((l) =>
    `<details class="lgl${levelClass(l.level)}"><summary><span class="at">${esc(offset(l.offsetMs))}</span><span class="lv">${esc(l.level ?? '')}</span>` +
    `<span class="msg">${esc(l.message)}</span></summary><div class="raw-meta">${esc(l.sourceName)}${l.thread ? ` · thread ${esc(l.thread)}` : ''}` +
    `${l.logger ? ` · ${esc(l.logger)}` : ''} · ${l.matchedBy === 'CAUGHT' ? 'caught' : l.matchedBy === 'EXACT' ? 'exact' : 'same thread + time'}${l.kept ? ' · kept copy' : ''}</div>` +
    `<pre>${esc(l.raw)}</pre></details>`).join('');
  return `<details class="lgx"><summary><span class="t">📜 Logs</span>${chips}</summary><div class="inner">` +
    `<p class="lead">The application log lines written while handling this call, oldest first, from ${esc(sources(lines))} - ${esc(matchedText(lines))}. Open a line for the whole of it.</p>` +
    `${rows}</div></details>`;
}

export const LOG_SECTION_STYLE = `
.lgx{margin:.8rem 0;border:1px solid rgba(163,230,53,.35);border-radius:10px;background:rgba(163,230,53,.04)}
.lgx>summary{cursor:pointer;padding:.5rem .7rem;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.lgx>summary .t{font-weight:700;color:#4d7c0f}
.lgx .inner{padding:.2rem .7rem .7rem}
.lgx .lead{margin:.2rem 0 .5rem;font-size:.9em}
.lgl{border-top:1px dashed rgba(127,127,127,.3)}
.lgl>summary{cursor:pointer;display:grid;grid-template-columns:5.5rem 4.5rem minmax(0,1fr);gap:.5rem;padding:.2rem 0;font-size:.88em}
.lgl .at{font-family:monospace;opacity:.7}.lgl .lv{font-weight:700;font-size:.85em}
.lgl .msg{font-family:monospace;white-space:pre-wrap;word-break:break-word}
.lgl.x .lv,.lgl.x .msg{color:#dc2626}.lgl.w .lv{color:#d97706}
.lgl .raw-meta{font-size:.8em;opacity:.75;margin:.2rem 0}
.lgl pre{white-space:pre-wrap;word-break:break-word;font-size:.8em;margin:.2rem 0 .5rem}
`;
