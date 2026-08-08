import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment, CommentBlock, COMMENT_BLOCK_LABELS } from '../../core/models/comment.model';
import { tryParseJson } from './json-tokenizer';
import { callKey, supplierOf } from './call-utils';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function metadataValue(value: string): string {
  return value && value.trim().length > 0 ? escapeHtml(value) : '<em>(none provided)</em>';
}

function metadataTableHtml(form: ExportFormData): string {
  return [
    '<table class="metadata">',
    `<tr><td>Supplier Name</td><td>${metadataValue(form.supplierName)}</td></tr>`,
    `<tr><td>Supplier Credentials Used</td><td>${metadataValue(form.credentialsUsed)}</td></tr>`,
    `<tr><td>Environment</td><td><span class="badge">${escapeHtml(form.environment)}</span></td></tr>`,
    `<tr><td>URL</td><td>${metadataValue(form.url)}</td></tr>`,
    `<tr><td>API Key</td><td>${metadataValue(form.apiKey)}</td></tr>`,
    `<tr><td>Description</td><td>${metadataValue(form.description)}</td></tr>`,
    '</table>',
  ].join('');
}

function formatMs(ms: number): string {
  const hasFraction = Math.abs(ms % 1) > 1e-9;
  return `${ms.toLocaleString('en-US', { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })} ms`;
}

function commentsForBlock(comments: readonly Comment[], block: CommentBlock): Comment[] {
  return comments.filter((c) => c.block === block).sort((a, b) => a.lineIndex - b.lineIndex);
}

const BLOCK_ORDER: readonly CommentBlock[] = ['request-headers', 'request-body', 'response-headers', 'response-body'];

/** Same grouping/order as markdown-builder's flaggedIssuesSection, rendered as HTML instead of Markdown headings. */
function flaggedIssuesHtml(comments: readonly Comment[]): string {
  if (comments.length === 0) return '';

  const notes: string[] = [];
  for (const block of BLOCK_ORDER) {
    const blockComments = commentsForBlock(comments, block);
    for (const c of blockComments) {
      notes.push(
        `<div class="note"><b>${escapeHtml(COMMENT_BLOCK_LABELS[block])}</b> — Line ${c.lineIndex + 1}: <code>${escapeHtml(
          c.lineText
        )}</code><blockquote>${escapeHtml(c.comment)}</blockquote></div>`
      );
    }
  }

  return `<div class="flagged"><h3>🚩 Flagged Issues (${comments.length})</h3>${notes.join('')}</div>`;
}

/** Pretty-prints if valid JSON, otherwise the raw text verbatim - same never-truncate rule every other export format follows. */
function prettyText(text: string | undefined): string {
  if (!text) return '(empty)';
  const parsed = tryParseJson(text);
  return parsed.ok ? JSON.stringify(parsed.value, null, 2) : text;
}

interface JsonBlockConfig {
  readonly id: string;
  readonly text: string;
  readonly comments: Readonly<Record<number, string>>;
}

/** One config entry per Headers/Body block - the exported document's shared script turns this into the interactive syntax-highlighted/searchable/copyable block, rather than each block carrying its own markup and script. */
function jsonBlockConfig(id: string, text: string | undefined, lineComments: readonly Comment[]): JsonBlockConfig {
  const pretty = prettyText(text);
  const commentsByLine: Record<number, string> = {};
  for (const c of lineComments) {
    commentsByLine[c.lineIndex] = commentsByLine[c.lineIndex] ? `${commentsByLine[c.lineIndex]} | ${c.comment}` : c.comment;
  }
  return { id, text: pretty, comments: commentsByLine };
}

function jsonBlockHtml(config: JsonBlockConfig, label: string, open: boolean): string {
  return `<details class="json-block" data-block-id="${config.id}"${open ? ' open' : ''}><summary>${escapeHtml(label)}</summary></details>`;
}

const STYLE = `
:root {
  --bg: #0a0e2a; --card: #141a45; --card-inner: #070a24;
  --border: rgba(139, 92, 246, 0.22); --border-strong: rgba(139, 92, 246, 0.45);
  --purple-light: #c4b5fd; --text: #e5e9f5; --text-dim: #93a0c2; --text-faint: #5c6690;
  --green: #34d399; --amber: #fbbf24; --red: #f87171;
  --tok-key: #c4b5fd; --tok-string: #6ee7d8; --tok-number: #fb923c; --tok-bool: #f472b6; --tok-null: #6b7394;
}
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2.5rem 1.5rem; line-height: 1.55; }
.doc { max-width: 880px; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
.exported-line { color: var(--text-dim); font-size: 0.85rem; margin-bottom: 1.75rem; }
h2 { font-size: 1.05rem; color: var(--purple-light); border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; margin: 2.25rem 0 0.9rem; }
h2:first-of-type { margin-top: 0; }
table.metadata { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 1.25rem; }
table.metadata td { padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
table.metadata tr:last-child td { border-bottom: none; }
table.metadata td:first-child { color: var(--text-dim); width: 220px; font-weight: 600; }
.badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; background: rgba(34, 211, 238, 0.15); color: #22d3ee; }
.field-list { list-style: none; margin: 0 0 1.25rem; padding: 0; font-size: 0.92rem; }
.field-list li { margin-bottom: 0.5rem; }
.field-list b { color: var(--text-dim); font-weight: 600; }
.status-ok { color: var(--green); font-weight: 600; }
.status-err { color: var(--red); font-weight: 600; }
.flagged { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 10px; padding: 1.1rem 1.25rem; margin: 1rem 0 1.5rem; }
.flagged h3 { margin: 0 0 0.7rem; font-size: 0.92rem; color: var(--amber); }
.flagged .note { font-size: 0.85rem; margin: 0.7rem 0; }
.flagged .note code { background: rgba(255,255,255,0.06); padding: 0.1rem 0.35rem; border-radius: 4px; }
.flagged .note blockquote { margin: 0.35rem 0 0; padding-left: 0.75rem; border-left: 2px solid var(--amber); color: var(--text-dim); }
hr { border: none; border-top: 1px solid var(--border); margin: 1.75rem 0; }
footer { text-align: center; color: var(--text-faint); font-size: 0.8rem; margin-top: 2rem; }
summary.call-summary { cursor: pointer; font-weight: 600; color: var(--purple-light); list-style: none; padding: 0.9rem 1.1rem; }
summary.call-summary::-webkit-details-marker { display: none; }
.call-summary-body { padding: 0 1.1rem 1.1rem; }
.json-block { background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 1.1rem; overflow: hidden; }
.json-block summary { cursor: pointer; padding: 0.55rem 0.9rem; font-weight: 600; font-size: 0.85rem; color: var(--purple-light); list-style: none; user-select: none; }
.json-block summary::-webkit-details-marker { display: none; }
.json-block summary::before { content: "▸ "; }
.json-block[open] summary::before { content: "▾ "; }
.json-toolbar { display: flex; gap: 6px; align-items: center; padding: 0 0.9rem 0.6rem; }
.json-toolbar input[type="text"] { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 6px; font-size: 12px; outline: none; }
.json-toolbar input[type="text"]:focus { border-color: var(--border-strong); }
.json-match-count { font-size: 11px; color: var(--text-faint); white-space: nowrap; min-width: 3em; text-align: right; }
.json-toolbar button { background: rgba(139, 92, 246, 0.12); border: 1px solid var(--border); color: var(--purple-light); font-size: 12px; padding: 3px 9px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.json-toolbar button:hover { border-color: var(--border-strong); background: rgba(139, 92, 246, 0.22); }
.json-toolbar .copy-btn { background: rgba(139, 92, 246, 0.18); border-color: var(--border-strong); }
.json-lines { background: var(--card-inner); margin: 0 0.9rem 0.9rem; border-radius: 8px; padding: 8px 4px; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12.5px; line-height: 1.7; overflow-x: auto; }
.json-line { display: flex; align-items: flex-start; gap: 6px; padding: 0 6px; border-radius: 4px; }
.json-line.has-comment { background: rgba(251, 191, 36, 0.07); border-left: 2px solid rgba(251, 191, 36, 0.5); }
.json-line-num { min-width: 1.8em; text-align: right; color: var(--text-faint); user-select: none; }
.json-line-flag { min-width: 1.3em; height: 1.3em; line-height: 1.1em; text-align: center; border-radius: 4px; border: 1px solid var(--border); background: rgba(139, 92, 246, 0.15); color: var(--purple-light); font-size: 11px; }
.json-line-flag.hidden { visibility: hidden; }
.json-line-content { white-space: pre; }
.json-comment-card { margin: 4px 0.9rem 8px 3.4em; background: rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 8px; padding: 6px 9px; font-size: 12px; color: var(--text); }
mark.json-hl { background: var(--amber); color: #1a1400; border-radius: 2px; padding: 0 1px; }
.copy-toast { position: fixed; bottom: 20px; right: 20px; background: var(--card); border: 1px solid var(--border-strong); color: var(--text); padding: 8px 14px; border-radius: 8px; font-size: 12px; opacity: 0; pointer-events: none; transition: opacity 0.2s; z-index: 10; }
.copy-toast.show { opacity: 1; }
`;

/**
 * One shared script for every JSON block on the page, driven by a `JSON_BLOCKS` config array
 * (one entry per Headers/Body block, single or bulk export alike) - so a bulk export with N calls
 * doesn't duplicate the tokenizer/search/copy logic N times. The tokenizer is ported line-for-line
 * from shared/utils/json-tokenizer.ts (tokenizeJsonText/classify) so highlighting matches the live
 * app exactly; copyText() falls back to document.execCommand('copy') for contexts where the
 * Clipboard API is unavailable or denied (e.g. some non-HTTPS/file:// origins), since this file is
 * meant to be opened by double-clicking it, not served over HTTP.
 */
const SCRIPT = `
function makeTokenRegex() {
  return new RegExp('("(\\\\\\\\u[a-zA-Z0-9]{4}|\\\\\\\\[^u]|[^\\\\\\\\"])*"(\\\\s*:)?|\\\\b(true|false)\\\\b|\\\\bnull\\\\b|-?\\\\d+(?:\\\\.\\\\d*)?(?:[eE][+-]?\\\\d+)?)', 'g');
}
var TOKEN_COLORS = { k: 'var(--tok-key)', s: 'var(--tok-string)', n: 'var(--tok-number)', b: 'var(--tok-bool)', z: 'var(--tok-null)' };
function classifyToken(m) {
  if (m.charAt(0) === '"') return m.charAt(m.length - 1) === ':' ? 'k' : 's';
  if (m === 'true' || m === 'false') return 'b';
  if (m === 'null') return 'z';
  return 'n';
}
function tokenizeLine(text) {
  var out = [], last = 0, m, re = makeTokenRegex();
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), c: '' });
    out.push({ t: m[0], c: classifyToken(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), c: '' });
  return out;
}
function escapeHtml(t) { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function styleFor(cls) { return cls ? ('color:' + TOKEN_COLORS[cls] + (cls === 'b' ? ';font-weight:600;' : ';')) : 'color:var(--text-faint);'; }
function tokensToHtml(tokens, query) {
  return tokens.map(function (tok) {
    var style = styleFor(tok.c);
    if (!query) return '<span style="' + style + '">' + escapeHtml(tok.t) + '</span>';
    var lower = tok.t.toLowerCase(), q = query.toLowerCase();
    if (lower.indexOf(q) === -1) return '<span style="' + style + '">' + escapeHtml(tok.t) + '</span>';
    var pieces = '', cursor = 0, idx;
    while ((idx = lower.indexOf(q, cursor)) !== -1) {
      if (idx > cursor) pieces += '<span style="' + style + '">' + escapeHtml(tok.t.slice(cursor, idx)) + '</span>';
      pieces += '<mark class="json-hl">' + escapeHtml(tok.t.slice(idx, idx + query.length)) + '</mark>';
      cursor = idx + query.length;
    }
    if (cursor < tok.t.length) pieces += '<span style="' + style + '">' + escapeHtml(tok.t.slice(cursor)) + '</span>';
    return pieces;
  }).join('');
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return fallbackCopy(text); });
  }
  return fallbackCopy(text);
}
function fallbackCopy(text) {
  return new Promise(function (resolve, reject) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (err) {
      document.body.removeChild(ta);
      reject(err);
    }
  });
}
function showToast(message) {
  var toast = document.getElementById('copy-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(function () { toast.classList.remove('show'); }, 1500);
}
function initJsonBlock(config) {
  var block = document.querySelector('[data-block-id="' + config.id + '"]');
  if (!block) return;
  var lines = config.text.split('\\n');
  var matches = [], active = 0;

  var toolbar = document.createElement('div');
  toolbar.className = 'json-toolbar';
  toolbar.innerHTML =
    '<input type="text" placeholder="Find in block..." class="json-search" />' +
    '<span class="json-match-count"></span>' +
    '<button type="button" class="json-prev">&lsaquo;</button>' +
    '<button type="button" class="json-next">&rsaquo;</button>' +
    '<button type="button" class="copy-btn json-copy">Copy</button>';
  block.appendChild(toolbar);

  var linesEl = document.createElement('div');
  linesEl.className = 'json-lines';
  block.appendChild(linesEl);

  var searchEl = toolbar.querySelector('.json-search');
  var countEl = toolbar.querySelector('.json-match-count');

  function render(query) {
    linesEl.innerHTML = '';
    matches = [];
    lines.forEach(function (text, i) {
      if (query && text.toLowerCase().indexOf(query.toLowerCase()) > -1) matches.push(i);
      var row = document.createElement('div');
      row.className = 'json-line' + (config.comments[i] ? ' has-comment' : '');

      var num = document.createElement('span');
      num.className = 'json-line-num';
      num.textContent = i + 1;

      var flag = document.createElement('span');
      flag.className = 'json-line-flag' + (config.comments[i] ? '' : ' hidden');
      flag.textContent = '+';

      var content = document.createElement('span');
      content.className = 'json-line-content';
      content.innerHTML = tokensToHtml(tokenizeLine(text), query);

      row.appendChild(num);
      row.appendChild(flag);
      row.appendChild(content);
      linesEl.appendChild(row);

      if (config.comments[i]) {
        var card = document.createElement('div');
        card.className = 'json-comment-card';
        card.textContent = config.comments[i];
        linesEl.appendChild(card);
      }
    });
    countEl.textContent = query ? (matches.length ? (active + 1) + '/' + matches.length : '0/0') : '';
  }

  searchEl.addEventListener('input', function () { active = 0; render(searchEl.value); });
  toolbar.querySelector('.json-next').addEventListener('click', function () {
    if (matches.length) { active = (active + 1) % matches.length; render(searchEl.value); }
  });
  toolbar.querySelector('.json-prev').addEventListener('click', function () {
    if (matches.length) { active = (active - 1 + matches.length) % matches.length; render(searchEl.value); }
  });
  toolbar.querySelector('.json-copy').addEventListener('click', function (e) {
    var annotated = lines.map(function (line, i) {
      return config.comments[i] ? (line + '  // FLAGGED: ' + config.comments[i]) : line;
    });
    var btn = e.target;
    copyText(annotated.join('\\n')).then(function () {
      btn.textContent = 'Copied!';
      showToast('Copied to clipboard');
      setTimeout(function () { btn.textContent = 'Copy'; }, 1200);
    }).catch(function (err) {
      btn.textContent = 'Failed';
      showToast('Copy failed: ' + err.message);
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    });
  });

  render('');
}
JSON_BLOCKS.forEach(initJsonBlock);
`;

function documentShell(title: string, bodyHtml: string, blocks: readonly JsonBlockConfig[]): string {
  // "</" inside the JSON payload (e.g. a URL in a header value) would otherwise prematurely close the <script> tag.
  const blocksJson = JSON.stringify(blocks).replace(/<\//g, '<\\/');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="doc">
${bodyHtml}
  </div>
  <div class="copy-toast" id="copy-toast"></div>
<script>
var JSON_BLOCKS = ${blocksJson};
${SCRIPT}
</script>
</body>
</html>
`;
}

/** Bare last-two-segments path, matching markdown-builder's pathOnly() - the call heading reads as "Call N METHOD path" so the full URL would be redundant with the field-list below it. */
function pathOnly(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/');
  } catch {
    return url;
  }
}

function statusHtml(call: CallRecord): string {
  if (call.error) return `<span class="status-err">⚠️ ${escapeHtml(call.error)}</span>`;
  if (!call.response) return '<span class="status-err">?</span>';
  return call.response.status < 400
    ? `<span class="status-ok">${call.response.status}</span>`
    : `<span class="status-err">${call.response.status}</span>`;
}

function callSectionHtml(call: CallRecord, comments: readonly Comment[], idPrefix: string): { html: string; blocks: JsonBlockConfig[] } {
  const reqHeaders = jsonBlockConfig(`${idPrefix}-req-headers`, JSON.stringify(call.request?.headers ?? {}), commentsForBlock(comments, 'request-headers'));
  const reqBody = jsonBlockConfig(`${idPrefix}-req-body`, call.request?.body, commentsForBlock(comments, 'request-body'));
  const resHeaders = jsonBlockConfig(`${idPrefix}-res-headers`, JSON.stringify(call.response?.headers ?? {}), commentsForBlock(comments, 'response-headers'));
  const resBody = jsonBlockConfig(`${idPrefix}-res-body`, call.response?.body, commentsForBlock(comments, 'response-body'));

  const parts: string[] = [];
  parts.push('<h2>📤 Request</h2>');
  parts.push('<ul class="field-list">');
  parts.push(`<li><b>Method:</b> ${escapeHtml(call.method)}</li>`);
  parts.push(`<li><b>URL:</b> ${escapeHtml(call.url)}</li>`);
  parts.push(`<li><b>Timestamp:</b> ${escapeHtml(call.timestamp)}</li>`);
  if (call.duration_ms != null) parts.push(`<li><b>Duration:</b> ${formatMs(call.duration_ms)}</li>`);
  parts.push('</ul>');
  parts.push(jsonBlockHtml(reqHeaders, 'Headers', false));
  parts.push(jsonBlockHtml(reqBody, 'Body', true));

  parts.push('<hr />');
  parts.push('<h2>📥 Response</h2>');
  if (call.error) {
    const suffix = call.response ? '' : ' No response was received for this call.';
    parts.push(`<p>⚠️ <b>Error:</b> ${escapeHtml(call.error)}${suffix}</p>`);
  }
  if (call.response) {
    parts.push(`<ul class="field-list"><li><b>Status:</b> ${statusHtml(call)}</li></ul>`);
    parts.push(jsonBlockHtml(resHeaders, 'Headers', true));
    parts.push(jsonBlockHtml(resBody, 'Body', true));
  }

  return { html: parts.join(''), blocks: [reqHeaders, reqBody, resHeaders, resBody] };
}

export function buildExportHtml(call: CallRecord, form: ExportFormData, comments: readonly Comment[] = []): string {
  const { html: sectionHtml, blocks } = callSectionHtml(call, comments, 'call');

  const body = [
    '<h1>📄 API Call Export</h1>',
    `<div class="exported-line">Exported from Alfred/Manor</div>`,
    '<h2>🧾 Metadata</h2>',
    metadataTableHtml(form),
    flaggedIssuesHtml(comments),
    sectionHtml,
    '<hr />',
    '<footer>Exported from Alfred/Manor</footer>',
  ].join('');

  return documentShell('API Call Export', body, blocks);
}

export function buildBulkExportHtml(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  exportedAt: string
): string {
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;
  const failed = calls.length - succeeded;
  const totalDurationMs = calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0);
  const totalFlagged = [...commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0);
  const callWord = calls.length === 1 ? 'Call' : 'Calls';

  const allBlocks: JsonBlockConfig[] = [];
  const summaryRows: string[] = [];
  const callSections: string[] = [];

  calls.forEach((call, i) => {
    const n = i + 1;
    const comments = commentsByCallId.get(callKey(call)) ?? [];
    const flaggedCount = comments.length;
    const duration = call.duration_ms != null ? formatMs(call.duration_ms) : '—';
    summaryRows.push(
      `<tr><td><a href="#call-${n}">${n}</a></td><td>${escapeHtml(call.method)}</td><td>${escapeHtml(
        call.url
      )}</td><td>${statusHtml(call)}</td><td>${duration}</td><td>${flaggedCount > 0 ? `🚩 ${flaggedCount}` : '—'}</td></tr>`
    );

    const { html: sectionHtml, blocks } = callSectionHtml(call, comments, `call-${n}`);
    allBlocks.push(...blocks);
    callSections.push(
      `<a id="call-${n}"></a><details class="json-block" open><summary class="call-summary"><b>Call ${n}</b> &nbsp; <code>${escapeHtml(
        call.method
      )} ${escapeHtml(pathOnly(call.url))}</code> &nbsp; ${statusHtml(call)}</summary><div class="call-summary-body">${flaggedIssuesHtml(comments)}${sectionHtml}</div></details>`
    );
  });

  const body = [
    `<h1>📋 API Calls Export — ${calls.length} ${callWord}</h1>`,
    `<div class="exported-line">Exported: ${escapeHtml(exportedAt)} &nbsp;•&nbsp; Succeeded: ${succeeded} ✅ &nbsp;•&nbsp; Failed: ${failed} ❌ &nbsp;•&nbsp; Total duration: ${formatMs(totalDurationMs)}</div>`,
    '<h2>🧾 Metadata</h2>',
    metadataTableHtml(form),
    '<h2>📊 Summary</h2>',
    `<table class="metadata"><tr><td>#</td><td>Method</td><td>URL</td><td>Status</td><td>Duration</td><td>Flagged</td></tr>${summaryRows.join('')}</table>`,
    '<h2>🔗 Calls</h2>',
    callSections.join(''),
    '<hr />',
    `<footer>Exported from Alfred/Manor — ${calls.length} call${calls.length === 1 ? '' : 's'}, ${totalFlagged} flagged issue${totalFlagged === 1 ? '' : 's'} total</footer>`,
  ].join('');

  return documentShell(`API Calls Export - ${calls.length} ${callWord}`, body, allBlocks);
}

export function exportHtmlFilename(call: CallRecord): string {
  const supplier = supplierOf(call).replace(/[^a-zA-Z0-9.-]/g, '_');
  return `${supplier}-${callKey(call)}.html`;
}

export function bulkExportHtmlFilename(calls: readonly CallRecord[]): string {
  return `alfred-export-${calls.length}-calls.html`;
}
