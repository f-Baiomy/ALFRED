/**
 * The Relive exports (.html / .md / .json) of a run and of a comparison of two runs, rendered from
 * the models in `relive-run-report.ts` (design: specs/003-relive-cycle/export-mock.html).
 *
 * Every document opens with an answer (the verdict), then "About this document" - plain prose that
 * tells a reader who was not there, or an AI agent, what this is, what happened and how to read it -
 * then the steps, each with what was sent, what came back and what it was compared with.
 *
 * Hard rule, as for every ALFRED export: call data is never truncated or summarized - every request
 * and response body is included in full (folded in .html/.md, never shortened). .md and .html mask
 * secrets with `maskRelive`; .json keeps them (it is the data format).
 */
import { diffLines } from './interception-diff';
import { maskRelive } from './relive-mask';
import { FieldChange, HttpShape, StepSide } from './relive-run-compare';
import { CompareReport, CompareSideInfo, GlossaryEntry, ReportOutcome, ReportStep, ReportVerdict, RunReport, VERDICT_WORDS, formatMs, formatWhen } from './relive-run-report';

// ---------------------------------------------------------------- shared helpers

type Mask = (text: string) => string;

function maskerOf(secretNames: readonly string[], values: Readonly<Record<string, string>>): Mask {
  return (text) => maskRelive(text, secretNames, values);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A body as a reader wants it: JSON pretty-printed, anything else as it came. Never shortened. */
export function prettyBody(body: string | null | undefined): string {
  const text = body ?? '';
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // Not JSON after all.
    }
  }
  return text;
}

function bodyLanguage(body: string | null | undefined): string {
  const trimmed = (body ?? '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('<')) return 'xml';
  return '';
}

/** A JSON body as a value for the .json export (parsed when it parses, the text otherwise). */
function bodyValue(body: string | null | undefined): unknown {
  const trimmed = (body ?? '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep the text.
    }
  }
  return body ?? null;
}

/** Past this a value is folded in .html and written below the table in .md. */
const LONG_VALUE = 120;

function isLongValue(text: string): boolean {
  return text.length > LONG_VALUE || text.includes('\n');
}

function sizeOf(text: string | null | undefined): string {
  const bytes = new TextEncoder().encode(text ?? '').length;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function headerCount(http: HttpShape): number {
  return Object.keys(http.headers ?? {}).length;
}

function httpLine(http: HttpShape, kind: 'request' | 'response'): string {
  const head = kind === 'request' ? `${http.method ?? ''} ${http.url ?? ''}`.trim() : `${http.status ?? 'no status'}`;
  return `${head} · ${headerCount(http)} header${headerCount(http) === 1 ? '' : 's'} · ${sizeOf(http.body)}`;
}

function percent(a: number | null, b: number | null): string {
  if (a == null || b == null || a <= 0) return '';
  const pct = Math.round(((b - a) / a) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

const OUTCOME_ICON: Readonly<Record<ReportOutcome, string>> = { passed: '✓', differences: '≠', failed: '✗', 'not run': '–', 'in progress': '●' };
const OUTCOME_CLASS: Readonly<Record<ReportOutcome, string>> = { passed: 'ok', differences: 'diff', failed: 'fail', 'not run': 'skip', 'in progress': 'skip' };
const SIDE_ICON: Readonly<Record<StepSide['outcome'], string>> = { ok: '✓', diff: '≠', fail: '✗', skip: '–' };
const SIDE_CLASS: Readonly<Record<StepSide['outcome'], string>> = { ok: 'ok', diff: 'diff', fail: 'fail', skip: 'skip' };
const VERDICT_CLASS: Readonly<Record<string, string>> = { NEW_FAILURE: 'fail', FIXED: 'fixed', CHANGED: 'diff', NOT_RUN: 'skip', SLOWER: 'diff', FASTER: 'ok', SAME: 'skip' };
const VERDICT_ICON: Readonly<Record<string, string>> = { NEW_FAILURE: '✗', FIXED: '✓', CHANGED: '≠', NOT_RUN: '–', SLOWER: '▲', FASTER: '▼', SAME: '' };

function anchor(number: string): string {
  return `step-${number.replace(/\./g, '-')}`;
}

function valueText(v: string | null): string {
  if (v == null) return '(not present)';
  if (v === '') return '(empty)';
  return v;
}

/** Markdown table cell: one line, pipes escaped. Long values stay whole. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${lang}\n${text}\n${ticks}`;
}

// ---------------------------------------------------------------- .html shell

const STYLE = `
:root { --bg: #141416; --card: #1b1b1d; --card-inner: #0e0e10; --border: rgba(255,255,255,.09); --border-strong: rgba(255,255,255,.18);
  --blue: #5b8def; --blue-light: #8fb2f7; --violet: #a78bfa; --violet-light: #c4b5fd; --cyan: #7ee3d8; --orange: #fb923c;
  --text: #f2f2f5; --dim: #8b8b93; --faint: #5b5b63; --green: #7ee3a0; --amber: #e3a24a; --red: #e36a6a;
  --mono: "SFMono-Regular", Consolas, "Cascadia Mono", monospace; }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
a { color: var(--blue-light); text-decoration: none; } a:visited { color: var(--blue-light); } a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 12px; }
.doc { display: grid; grid-template-columns: 230px minmax(0, 1fr); max-width: 1320px; margin: 0 auto; }
.toc { position: sticky; top: 0; align-self: start; height: 100vh; overflow: auto; padding: 26px 14px 26px 18px; border-right: 1px solid var(--border); font-size: 12.5px; }
.toc b { display: block; color: var(--faint); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; margin: 16px 0 6px; }
.toc a { display: flex; gap: 7px; align-items: center; padding: 3px 6px; border-radius: 6px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toc a:hover { background: var(--card); color: var(--text); text-decoration: none; }
.toc a.child { padding-left: 20px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); }
.dot.ok { background: var(--green); } .dot.diff { background: var(--amber); } .dot.fail { background: var(--red); } .dot.fixed { background: var(--cyan); }
main { padding: 30px 34px 50px; min-width: 0; }
.kicker { color: var(--faint); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
h1 { font-size: 25px; margin: 2px 0 8px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--dim); font-size: 13px; }
.meta b { color: var(--text); font-weight: 600; }
.verdict { margin: 18px 0 0; padding: 14px 16px; border-radius: 10px; background: var(--card); border: 1px solid var(--border); border-left-width: 4px; font-size: 15.5px; }
.verdict .lead { font-weight: 700; }
.verdict.bad { border-left-color: var(--red); } .verdict.bad .lead { color: var(--red); }
.verdict.mid { border-left-color: var(--amber); } .verdict.mid .lead { color: var(--amber); }
.verdict.good { border-left-color: var(--green); } .verdict.good .lead { color: var(--green); }
.verdict.neutral { border-left-color: var(--blue); } .verdict.neutral .lead { color: var(--blue-light); }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px; margin: 12px 0 4px; }
.tile { background: var(--card-inner); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; }
.tile b { display: block; font-size: 22px; } .tile span { color: var(--dim); font-size: 12px; }
section { margin-top: 32px; scroll-margin-top: 12px; }
section > h2 { font-size: 17px; margin: 0 0 10px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
section > h2 small { color: var(--faint); font-weight: 400; font-size: 12.5px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 18px; }
.about p { margin: 0 0 10px; } .about p:last-of-type { margin-bottom: 0; }
dl.facts-list { display: grid; grid-template-columns: 160px 1fr; gap: 4px 14px; margin: 12px 0 0; font-size: 13px; }
dl.facts-list dt { color: var(--dim); } dl.facts-list dd { margin: 0; overflow-wrap: anywhere; }
table.t { width: 100%; border-collapse: collapse; font-size: 13px; }
table.t th { text-align: left; color: var(--faint); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border-strong); }
table.t td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; overflow-wrap: break-word; }
table.t tr.child td.name { padding-left: 26px; }
table.t tr.quiet td { color: var(--dim); }
.dim { color: var(--dim); } .faint { color: var(--faint); }
.pill { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 700; padding: 1px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
.ok { color: var(--green); border-color: rgba(126,227,160,.45); background: rgba(126,227,160,.08); }
.diff { color: var(--amber); border-color: rgba(227,162,74,.5); background: rgba(227,162,74,.08); }
.fail { color: var(--red); border-color: rgba(227,106,106,.5); background: rgba(227,106,106,.08); }
.fixed { color: var(--cyan); border-color: rgba(126,227,216,.45); background: rgba(126,227,216,.08); }
.skip { color: var(--dim); border-color: var(--border-strong); }
.live { color: var(--orange); border-color: rgba(251,146,60,.5); } .replay { color: var(--cyan); border-color: rgba(126,227,216,.45); }
.up { color: var(--red); } .down { color: var(--green); }
.attn { display: grid; gap: 8px; }
.attn .item { display: grid; grid-template-columns: 34px 1fr auto; gap: 10px; align-items: start; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.attn .why { color: var(--dim); font-size: 13px; overflow-wrap: anywhere; }
.filters { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 10px; }
.filters button { font: inherit; font-size: 12px; background: var(--card-inner); color: var(--dim); border: 1px solid var(--border); border-radius: 999px; padding: 2px 11px; cursor: pointer; }
.filters button.on { border-color: var(--blue); color: var(--text); }
.step { background: var(--card); border: 1px solid var(--border); border-radius: 12px; margin: 14px 0; overflow: hidden; scroll-margin-top: 12px; }
.step.child { margin-left: 28px; }
.step-head { display: flex; gap: 10px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.step-head .num { color: var(--faint); font-family: var(--mono); font-size: 12px; }
.step-head h3 { margin: 0; font-size: 15px; }
.url-line { flex-basis: 100%; color: var(--dim); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.url-sm { display: block; margin-top: 2px; color: var(--faint); font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; font-weight: 400; }
details.fold { margin: 8px 0; }
details.fold > table { border-top: 1px solid var(--border); }
table.fields { table-layout: fixed; }
table.fields col.c-field { width: 28%; } table.fields col.c-val { width: 29%; } table.fields col.c-last { width: 14%; }
table.fields td.field { font-family: var(--mono); font-size: 12px; color: var(--text); overflow-wrap: break-word; word-break: normal; }
.val-note { display: block; margin-top: 3px; color: var(--faint); font-size: 11px; }
tr.has-long td { border-bottom: 0; }
tr.long td { padding: 0 8px 10px; }
details.long-fold { margin: 0; }
details.long-fold > summary { font-size: 12px; }
.long-box { padding: 0 10px 10px; display: grid; gap: 10px; }
.views { display: flex; gap: 6px; flex-wrap: wrap; }
.views button { font: inherit; font-size: 12px; background: var(--card-inner); color: var(--dim); border: 1px solid var(--border); border-radius: 999px; padding: 2px 11px; cursor: pointer; }
.views button.on { border-color: var(--blue); color: var(--text); }
.long-side { min-width: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.long-box[data-view="both"] [data-side="diff"], .long-box[data-view="a"] [data-side]:not([data-side="a"]),
.long-box[data-view="b"] [data-side]:not([data-side="b"]), .long-box[data-view="diff"] [data-side]:not([data-side="diff"]) { display: none; }
pre.code.diff { white-space: pre-wrap; }
.dl { display: block; } .dl.removed { background: rgba(227,106,106,.12); color: #f2b8b8; } .dl.added { background: rgba(126,227,160,.10); color: #b9f0cc; }
.long-head .dl { display: inline; padding: 0 4px; border-radius: 4px; }
.long-head { padding: 5px 12px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); background: var(--card); }
.step-body { padding: 12px 16px 14px; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; margin-bottom: 10px; }
.fact { background: var(--card-inner); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; overflow-wrap: anywhere; }
.fact span { display: block; color: var(--faint); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; }
.why-box { border-left: 3px solid var(--red); background: rgba(227,106,106,.06); padding: 8px 12px; border-radius: 0 8px 8px 0; margin: 0 0 10px; font-size: 13.5px; overflow-wrap: anywhere; }
.why-box.mid { border-color: var(--amber); background: rgba(227,162,74,.06); }
.why-box.skip { border-color: var(--faint); background: rgba(255,255,255,.03); }
h4 { margin: 14px 0 6px; font-size: 11.5px; color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
.val { font-family: var(--mono); font-size: 12px; border-radius: 5px; padding: 1px 6px; white-space: pre-wrap; overflow-wrap: anywhere; display: inline-block; max-width: 100%; }
.val.rec { background: rgba(255,255,255,.05); color: var(--dim); } .val.act, .val.a { background: rgba(91,141,239,.12); color: var(--blue-light); } .val.b { background: rgba(167,139,250,.14); color: var(--violet-light); }
tr.noise td { opacity: .55; }
details { border: 1px solid var(--border); border-radius: 8px; margin: 6px 0; background: var(--card-inner); }
summary { cursor: pointer; padding: 7px 12px; font-size: 13px; color: var(--dim); display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
summary b { color: var(--text); font-weight: 600; }
summary .sp { flex: 1; }
.copy { font: inherit; font-size: 11.5px; background: none; border: 1px solid var(--border-strong); color: var(--dim); border-radius: 6px; padding: 1px 8px; cursor: pointer; }
.hdrs { border-top: 1px solid var(--border); padding: 6px 14px; font-size: 12px; max-height: 220px; overflow: auto; }
.hdrs div { font-family: var(--mono); overflow-wrap: anywhere; } .hdrs span { color: var(--blue-light); }
/* Bodies and headers keep a fixed, medium height and scroll inside - a page of steps stays a page. */
pre.code { margin: 0; padding: 10px 14px; border-top: 1px solid var(--border); font: 12px/1.6 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; color: #dcdce2; max-height: 420px; overflow: auto; resize: vertical; }
pre.code.empty { max-height: none; }
pre.code.empty { color: var(--faint); }
.tk { color: #8fb2f7; } .ts { color: #7ee3a0; } .tn { color: #e3a24a; } .tb { color: #e37ec4; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.side { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
.side.a { border-color: rgba(91,141,239,.55); } .side.b { border-color: rgba(167,139,250,.6); }
.slot { display: inline-flex; width: 20px; height: 20px; border-radius: 5px; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; color: #fff; margin-right: 4px; }
.slot.a { background: var(--blue); } .slot.b { background: var(--violet); }
.bar { position: relative; height: 8px; background: var(--card-inner); border-radius: 4px; margin-top: 3px; max-width: 140px; }
.bar i { position: absolute; left: 0; height: 4px; border-radius: 2px; } .bar i.a { top: 0; background: var(--blue); } .bar i.b { top: 4px; background: var(--violet); }
.warn { color: var(--amber); }
dl.gloss dt { font-weight: 600; margin-top: 8px; } dl.gloss dt:first-child { margin-top: 0; } dl.gloss dd { margin: 0; color: var(--dim); }
.foot { margin-top: 36px; color: var(--faint); font-size: 12px; border-top: 1px solid var(--border); padding-top: 12px; }
.hidden { display: none !important; }
@media (max-width: 900px) { .doc { display: block; } .toc { display: none; } main { padding: 20px 16px; } .two { grid-template-columns: 1fr; } }
@media print { .toc, .filters, .copy, .views { display: none; } .doc { display: block; } body { background: #fff; color: #000; } details { break-inside: avoid; } pre.code, .hdrs { height: auto; max-height: none; overflow: visible; } }
`;

/** Filter chips and copy buttons. The document reads fine without it (print, no-JS viewers). */
const SCRIPT = `
document.querySelectorAll('[data-filter]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var want = btn.getAttribute('data-filter');
    document.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('on', b === btn); });
    document.querySelectorAll('[data-outcome]').forEach(function (el) {
      el.classList.toggle('hidden', want !== 'all' && el.getAttribute('data-outcome') !== want);
    });
  });
});
document.querySelectorAll('[data-view-btn]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var box = btn.closest('.long-box');
    box.setAttribute('data-view', btn.getAttribute('data-view-btn'));
    box.querySelectorAll('[data-view-btn]').forEach(function (b) { b.classList.toggle('on', b === btn); });
  });
});
document.querySelectorAll('.copy').forEach(function (btn) {
  btn.addEventListener('click', function (ev) {
    ev.preventDefault();
    var pre = btn.closest('details').querySelector('pre');
    navigator.clipboard.writeText(pre ? pre.textContent : '').then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); });
  });
});
`;

function page(title: string, toc: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="doc">
<nav class="toc">${toc}</nav>
<main>
${body}
</main>
</div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** Escaped JSON with its keys, strings, numbers and booleans coloured. */
function highlightJson(escaped: string): string {
  return escaped
    .replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?/g, (_m, s: string, colon: string | undefined) => (colon ? `<span class="tk">${s}</span>${colon}` : `<span class="ts">${s}</span>`))
    .replace(/(^|[\s[:,])(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[\s,\]}]|$)/gm, '$1<span class="tn">$2</span>')
    .replace(/(^|[\s[:,])(true|false|null)(?=[\s,\]}]|$)/gm, '$1<span class="tb">$2</span>');
}

function codeHtml(body: string | null | undefined, mask: Mask): string {
  const text = mask(prettyBody(body));
  if (!text.trim()) return '<pre class="code empty">(empty body)</pre>';
  const escaped = escapeHtml(text);
  return `<pre class="code">${bodyLanguage(body) === 'json' ? highlightJson(escaped) : escaped}</pre>`;
}

function httpHtml(title: string, http: HttpShape | null, kind: 'request' | 'response', mask: Mask, open = false, note = ''): string {
  if (!http) return '';
  const headers = Object.entries(http.headers ?? {});
  const headerRows = headers.length
    ? `<div class="hdrs">${headers.map(([k, v]) => `<div><span>${escapeHtml(k)}</span>: ${escapeHtml(mask(String(v)))}</div>`).join('')}</div>`
    : '';
  return `<details${open ? ' open' : ''}><summary><b>${escapeHtml(title)}</b> ${escapeHtml(mask(httpLine(http, kind)))}${note ? ` <span class="faint">${escapeHtml(note)}</span>` : ''}<span class="sp"></span><button class="copy" type="button">Copy</button></summary>${headerRows}${codeHtml(http.body, mask)}</details>`;
}

function verdictHtml(v: ReportVerdict, mask: Mask): string {
  return `<div class="verdict ${v.tone}"><span class="lead">${escapeHtml(v.lead)}</span> ${escapeHtml(mask(v.text))}</div>`;
}

function glossaryHtml(glossary: readonly GlossaryEntry[]): string {
  return `<section id="glossary"><h2>Glossary</h2><div class="card"><dl class="gloss">${glossary.map((g) => `<dt>${escapeHtml(g.term)}</dt><dd>${escapeHtml(g.meaning)}</dd>`).join('')}</dl></div></section>`;
}

function modePill(mode: string | null): string {
  if (!mode) return '<span class="faint">-</span>';
  return `<span class="pill ${mode === 'LIVE' ? 'live' : 'replay'}">${mode}</span>`;
}

function outcomePill(outcome: ReportOutcome): string {
  return `<span class="pill ${OUTCOME_CLASS[outcome]}">${OUTCOME_ICON[outcome]} ${outcome}</span>`;
}

// ---------------------------------------------------------------- run report: .html

/** A short value whole; a long one as a preview - its whole value is in the full-width row below. */
function valueHtml(value: string | null, cls: string, mask: Mask): string {
  const text = mask(valueText(value));
  if (!isLongValue(text)) return `<span class="val ${cls}">${escapeHtml(text)}</span>`;
  return `<span class="val ${cls}">${escapeHtml(text.slice(0, 60))}…</span><span class="val-note">${text.length.toLocaleString('en-US')} characters - full value below</span>`;
}

/** Both sides of one long difference, full width and side by side, folded until asked for. */
/** The two values as one line diff (the interception panel's own `diffLines`): - removed, + added. */
function diffHtml(a: string | null, b: string | null, mask: Mask): string {
  const lines = diffLines(mask(prettyBody(a ?? '')), mask(prettyBody(b ?? '')), undefined, false);
  if (!lines.some((l) => l.kind !== 'same')) return '<pre class="code empty">The two values are the same text.</pre>';
  return `<pre class="code diff">${lines.map((l) => `<span class="dl ${l.kind}">${l.kind === 'removed' ? '-' : l.kind === 'added' ? '+' : ' '} ${escapeHtml(l.text)}</span>`).join('')}</pre>`;
}

/**
 * Both values of one long difference, full width, folded until asked for. A switch shows them one
 * under the other (the default, and what prints), one side only, or as a line diff.
 */
function longValuesRow(d: FieldChange, heads: readonly [string, string, string, string], mask: Mask): string {
  const side = (which: 'a' | 'b', label: string, value: string | null) => `<div class="long-side" data-side="${which}"><div class="long-head">${escapeHtml(label)}</div>${value == null ? '<pre class="code empty">(not present)</pre>' : codeHtml(value, mask)}</div>`;
  const views: readonly [string, string][] = [['both', 'Both'], ['a', `${heads[1]} only`], ['b', `${heads[2]} only`], ['diff', 'Diff']];
  return `<tr class="long${d.noise ? ' noise' : ''}"><td colspan="4"><details class="long-fold"><summary>Show the full values of <b>${escapeHtml(d.path)}</b></summary>
  <div class="long-box" data-view="both"><div class="views">${views.map(([v, label]) => `<button type="button" data-view-btn="${v}"${v === 'both' ? ' class="on"' : ''}>${escapeHtml(label)}</button>`).join('')}</div>
  ${side('a', heads[1], d.a)}${side('b', heads[2], d.b)}<div class="long-side" data-side="diff"><div class="long-head">Diff - <span class="dl removed">- ${escapeHtml(heads[1])}</span> <span class="dl added">+ ${escapeHtml(heads[2])}</span></div>${diffHtml(d.a, d.b, mask)}</div></div></details></td></tr>`;
}

/** A folded table of field differences: closed by default, field names on one readable column. */
function fieldsHtml(title: string, diffs: readonly FieldChange[], heads: readonly [string, string, string, string], classes: readonly [string, string], mask: Mask, last: (d: FieldChange) => string): string {
  if (!diffs.length) return '';
  const real = diffs.filter((d) => !d.noise).length;
  const rows = diffs.map((d) => {
    const long = isLongValue(mask(valueText(d.a))) || isLongValue(mask(valueText(d.b)));
    return `<tr class="${d.noise ? 'noise' : ''}${long ? ' has-long' : ''}"><td class="field">${escapeHtml(d.path).replace(/\./g, '.<wbr>')}</td><td>${valueHtml(d.a, classes[0], mask)}</td><td>${valueHtml(d.b, classes[1], mask)}</td><td>${last(d)}</td></tr>${long ? longValuesRow(d, heads, mask) : ''}`;
  }).join('');
  return `<details class="fold"><summary><b>${escapeHtml(title)}</b> ${real}${diffs.length > real ? ` + ${diffs.length - real} noise` : ''}</summary>
  <table class="t fields"><colgroup><col class="c-field"><col class="c-val"><col class="c-val"><col class="c-last"></colgroup><tr><th>${heads[0]}</th><th>${heads[1]}</th><th>${heads[2]}</th><th>${heads[3]}</th></tr>${rows}</table></details>`;
}

function differencesHtml(diffs: readonly FieldChange[], mask: Mask): string {
  return fieldsHtml('Differences from the recording', diffs, ['Field', 'Recorded', 'This run', 'Counts?'], ['rec', 'act'], mask,
    (d) => (d.noise ? `<span class="pill skip">no - noise${d.cause ? ` · ${escapeHtml(d.cause)}` : ''}</span>` : '<span class="pill fail">yes</span>'));
}

/** The full method + URL of a step, small, under its name. */
function urlOf(report: RunReport, number: string, mask: Mask): string {
  const step = report.steps.find((s) => s.number === number);
  return step ? `<span class="url-sm">${escapeHtml(`${step.method} ${mask(step.url)}`)}</span>` : '';
}

function stepCardHtml(s: ReportStep, mask: Mask): string {
  const cls = OUTCOME_CLASS[s.outcome];
  const why = s.reasons.length
    ? `<div class="why-box ${s.outcome === 'failed' ? '' : s.outcome === 'differences' ? 'mid' : 'skip'}"><b>${s.outcome === 'failed' ? 'Why it failed' : s.outcome === 'differences' ? 'What differs' : 'Why it did not run'}:</b> ${s.reasons.map((r) => escapeHtml(mask(r))).join('<br>')}</div>`
    : '';
  const ran = s.outcome !== 'not run';
  const facts = [
    ['Status', ran ? `${s.status.recorded} recorded → ${s.status.run ?? 'no answer'} this run` : `${s.status.recorded} when recorded`],
    ['Time', ran ? `${formatMs(s.durationMs.recorded)} recorded → ${formatMs(s.durationMs.run)} this run ${percent(s.durationMs.recorded, s.durationMs.run)}` : `${formatMs(s.durationMs.recorded)} when recorded`],
    ['Sent to', ran ? `${s.mode === 'REPLAY' ? 'answered by ALFRED from the recording (REPLAY)' : 'the real system (LIVE)'}${s.attribution ? ` · attribution: ${s.attribution}` : ''}` : 'not sent'],
    ['Rules applied', s.rulesApplied.length ? s.rulesApplied.map((r) => `${r.name} (${r.tier})`).join(', ') : 'none'],
    ['Variables used', s.variablesUsed.length ? s.variablesUsed.map((v) => `{{${v.name}}} = ${v.value}`).join(', ') : 'none'],
    ['Values saved', s.variablesSaved.length ? s.variablesSaved.map((v) => `{{${v.name}}} = ${v.value}`).join(', ') : 'none'],
  ];
  const bodies = ran
    ? `${httpHtml('Request sent', s.request, 'request', mask)}${httpHtml('Response received', s.response, 'response', mask)}${httpHtml('Recorded response', s.recorded.response, 'response', mask, false, '- what this run was compared with')}${httpHtml('Recorded request', s.recorded.request, 'request', mask)}`
    : `${httpHtml('Recorded request', s.recorded.request, 'request', mask)}${httpHtml('Recorded response', s.recorded.response, 'response', mask)}`;
  return `<div class="step${s.isChild ? ' child' : ''}" id="${anchor(s.number)}" data-outcome="${s.outcome}">
  <div class="step-head"><span class="num">${s.number}</span><h3>${s.isChild ? '↗ ' : ''}${escapeHtml(s.label)}</h3>${modePill(s.mode)}<span class="pill ${cls}">${OUTCOME_ICON[s.outcome]} ${s.outcome}</span><div class="url-line">${escapeHtml(`${s.method} ${mask(s.url)}`)}</div></div>
  <div class="step-body">${why}
  <div class="facts">${facts.map(([k, v]) => `<div class="fact"><span>${k}</span>${escapeHtml(mask(v))}</div>`).join('')}</div>
  ${differencesHtml(s.differences, mask)}
  <h4>Request and response, in full</h4>${bodies}
  </div></div>`;
}

export function buildHtmlRunReport(report: RunReport): string {
  const mask = maskerOf(report.secretNames, report.values);
  const r = report.run;
  const c = report.counts;
  const toc = `<b>This report</b>
  <a href="#summary">Summary</a><a href="#about">About this document</a>${report.needsAttention.length ? `<a href="#attention">Needs attention (${report.needsAttention.length})</a>` : ''}<a href="#all-steps">All steps</a>${report.variables.length ? '<a href="#values">Values captured</a>' : ''}${report.log.length ? '<a href="#log">Run log</a>' : ''}<a href="#glossary">Glossary</a>
  <b>Steps</b>${report.steps.map((s) => `<a href="#${anchor(s.number)}"${s.isChild ? ' class="child"' : ''} title="${escapeHtml(s.label)}"><i class="dot ${OUTCOME_CLASS[s.outcome]}"></i>${s.number} ${escapeHtml(s.label)}</a>`).join('')}`;

  const tile = (n: number, label: string, color: string) => `<div class="tile"><b style="color:${color}">${n}</b><span>${label}</span></div>`;
  const body = `<div id="summary"><div class="kicker">ALFRED · Relive run report</div>
  <h1>${escapeHtml(report.cycle.name)}</h1>
  <div class="meta"><span>Run started <b>${escapeHtml(formatWhen(r.startedAt))}</b></span><span>took <b>${escapeHtml(formatMs(r.durationMs))}</b></span><span>driver <b>${escapeHtml(r.driver.split(' (')[0])}</b></span><span>result <span class="pill ${report.verdict.tone === 'bad' ? 'fail' : report.verdict.tone === 'mid' ? 'diff' : report.verdict.tone === 'good' ? 'ok' : 'skip'}">${escapeHtml(r.statusText)}</span></span><span>exported ${escapeHtml(formatWhen(report.exportedAt))}</span></div>
  ${verdictHtml(report.verdict, mask)}
  <div class="tiles">${tile(c.steps, 'steps', 'var(--text)')}${tile(c.passed, 'passed', 'var(--green)')}${tile(c.differences, 'with differences', 'var(--amber)')}${tile(c.failed, 'failed', 'var(--red)')}${tile(c.notRun, 'not run', 'var(--dim)')}${tile(c.live, 'reached a real system (LIVE)', 'var(--orange)')}${tile(c.replayed, 'answered by ALFRED (REPLAY)', 'var(--cyan)')}</div></div>

  <section id="about"><h2>About this document</h2><div class="card about">
    <p><b>What this is.</b> ${escapeHtml(mask(report.about.whatThisIs))}</p>
    <p><b>What happened.</b> ${escapeHtml(mask(report.about.whatHappened))}</p>
    <p><b>How to read it.</b> ${escapeHtml(report.about.howToRead)}</p>
    <dl class="facts-list"><dt>Cycle</dt><dd>${escapeHtml(report.cycle.name)}${report.cycle.versionSavedAt ? ` · version saved ${escapeHtml(formatWhen(report.cycle.versionSavedAt))}` : ''}</dd><dt>Cycle id</dt><dd class="mono">${escapeHtml(report.cycle.id)}</dd><dt>Run id</dt><dd class="mono">${escapeHtml(r.id)}</dd><dt>Driver</dt><dd>${escapeHtml(r.driver)}</dd><dt>Started from</dt><dd>${escapeHtml(r.startedFrom ?? 'the first step')}</dd><dt>Finished</dt><dd>${escapeHtml(formatWhen(r.finishedAt))}</dd></dl>
  </div></section>

  ${report.needsAttention.length ? `<section id="attention"><h2>Needs attention <small>${c.failed} failed · ${c.differences} with differences</small></h2><div class="attn">${report.needsAttention.map((n) => `<div class="item"><span class="pill ${OUTCOME_CLASS[n.outcome]}">${OUTCOME_ICON[n.outcome]}</span><div><b>${n.number} · ${escapeHtml(n.label)}</b>${n.mode ? ` <span class="faint mono">${n.mode}</span>` : ''}${urlOf(report, n.number, mask)}<div class="why">${escapeHtml(mask(n.reason))}</div></div><a href="#${anchor(n.number)}">step ${n.number} ↓</a></div>`).join('')}</div></section>` : ''}

  <section id="all-steps"><h2>All steps <small>status and time as recorded → in this run</small></h2>
  <div class="filters"><button type="button" class="on" data-filter="all">All ${c.steps}</button>${c.failed ? `<button type="button" data-filter="failed">Failed ${c.failed}</button>` : ''}${c.differences ? `<button type="button" data-filter="differences">Differences ${c.differences}</button>` : ''}${c.passed ? `<button type="button" data-filter="passed">Passed ${c.passed}</button>` : ''}${c.notRun ? `<button type="button" data-filter="not run">Not run ${c.notRun}</button>` : ''}</div>
  <table class="t"><tr><th>#</th><th>Step</th><th>Mode</th><th>Outcome</th><th>Status</th><th>Time</th><th>Differences</th></tr>
  ${report.steps.map((s) => {
    const real = s.differences.filter((d) => !d.noise).length;
    const noise = s.differences.length - real;
    return `<tr class="${s.isChild ? 'child' : ''}" data-outcome="${s.outcome}"><td>${s.number}</td><td class="name"><a href="#${anchor(s.number)}">${s.isChild ? '↗ ' : ''}${escapeHtml(s.label)}</a><span class="url-sm">${escapeHtml(`${s.method} ${mask(s.url)}`)}</span></td><td>${modePill(s.mode)}</td><td>${outcomePill(s.outcome)}</td><td class="mono">${s.status.recorded} → ${s.outcome === 'not run' ? '-' : s.status.run ?? 'none'}</td><td class="mono">${formatMs(s.durationMs.recorded)} → ${formatMs(s.durationMs.run)} <span class="${(s.durationMs.run ?? 0) > s.durationMs.recorded ? 'up' : 'down'}">${percent(s.durationMs.recorded, s.durationMs.run)}</span></td><td>${real || '<span class="faint">-</span>'}${noise ? ` <span class="faint">+${noise} noise</span>` : ''}</td></tr>`;
  }).join('')}</table></section>

  <section id="steps"><h2>Steps <small>what was sent, what came back, and the recording it was compared with</small></h2>
  ${report.steps.map((s) => stepCardHtml(s, mask)).join('\n')}</section>

  ${report.variables.length ? `<section id="values"><h2>Values captured <small>saved by steps and sent by later ones</small></h2><table class="t"><tr><th>Variable</th><th>Value</th><th>Saved by</th><th>Used by steps</th></tr>${report.variables.map((v) => `<tr><td class="mono">{{${escapeHtml(v.name)}}}</td><td class="mono">${escapeHtml(mask(v.value))}</td><td>${escapeHtml(v.savedBy ?? 'set before the run')}</td><td>${v.usedBy.length ? v.usedBy.join(', ') : '<span class="faint">-</span>'}</td></tr>`).join('')}</table></section>` : ''}

  ${report.log.length ? `<section id="log"><h2>Run log <small>${report.log.length} entries, in order</small></h2><table class="t"><tr><th>Time</th><th>Step</th><th>What happened</th></tr>${report.log.map((l) => `<tr><td class="mono">${escapeHtml(timeOf(l.at))}</td><td>${l.step ?? '<span class="faint">-</span>'}</td><td>${escapeHtml(mask(l.message))}</td></tr>`).join('')}</table></section>` : ''}

  ${glossaryHtml(report.glossary)}
  <div class="foot">Generated by ALFRED Relive on ${escapeHtml(formatWhen(report.exportedAt))} · every request and response body is included in full, never shortened · secret values are masked as •••; the .json export keeps them.</div>`;
  return page(report.title, toc, body);
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.toLocaleTimeString('en-GB', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ---------------------------------------------------------------- run report: .md

function mdHttp(title: string, http: HttpShape | null, kind: 'request' | 'response', mask: Mask, open = false, note = ''): string[] {
  if (!http) return [];
  const headers = Object.entries(http.headers ?? {});
  const body = mask(prettyBody(http.body));
  return [
    `<details${open ? ' open' : ''}><summary>${title} - ${mask(httpLine(http, kind)).replace(/</g, '&lt;')}${note ? ` ${note}` : ''}</summary>`,
    '',
    ...(headers.length ? [fence(headers.map(([k, v]) => `${k}: ${mask(String(v))}`).join('\n'), 'http'), ''] : []),
    body.trim() ? fence(body, bodyLanguage(http.body)) : '*(empty body)*',
    '',
    '</details>',
    '',
  ];
}

/**
 * A folded table of field differences. A value too long for a table cell is named in the cell and
 * written out in full under the table - a table row stays one readable line, nothing is cut.
 */
function mdFields(title: string, diffs: readonly FieldChange[], heads: readonly [string, string, string, string], mask: Mask, last: (d: FieldChange) => string): string[] {
  if (!diffs.length) return [];
  const real = diffs.filter((d) => !d.noise).length;
  const long: string[] = [];
  const shown = (d: FieldChange, side: 'a' | 'b', label: string) => {
    const value = d[side];
    const text = mask(valueText(value));
    if (!isLongValue(text)) return cell(text);
    long.push(`<details><summary>${cell(d.path)} - ${label} (${text.length.toLocaleString('en-US')} characters)</summary>`, '', fence(mask(prettyBody(value)), bodyLanguage(value)), '', '</details>', '');
    return `*long value - see "${cell(d.path)} - ${label}" below*`;
  };
  const rows = diffs.map((d) => `| \`${cell(d.path)}\` | ${shown(d, 'a', heads[1])} | ${shown(d, 'b', heads[2])} | ${last(d)} |`);
  return [
    `<details><summary>${title} (${real}${diffs.length > real ? ` + ${diffs.length - real} noise` : ''})</summary>`,
    '',
    `| ${heads[0]} | ${heads[1]} | ${heads[2]} | ${heads[3]} |`,
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    ...long,
    '</details>',
    '',
  ];
}

function mdDifferences(diffs: readonly FieldChange[], mask: Mask): string[] {
  return mdFields('Differences from the recording', diffs, ['Field', 'Recorded', 'This run', 'Counts?'], mask, (d) => (d.noise ? `no - noise${d.cause ? ` (${cell(d.cause)})` : ''}` : '**yes**'));
}

/** GitHub's heading anchor: lower case, punctuation dropped, each space a hyphen. */
function mdHeadingAnchor(heading: string): string {
  return heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
}

export function buildMarkdownRunReport(report: RunReport): string {
  const mask = maskerOf(report.secretNames, report.values);
  const r = report.run;
  const c = report.counts;
  const heading = (s: ReportStep) => `${s.number} · ${s.label} - ${OUTCOME_ICON[s.outcome]} ${s.outcome}`;
  const lines: string[] = [
    `# ${report.title}`,
    '',
    `> **${report.verdict.lead}** ${mask(report.verdict.text)}`,
    '',
    '| Run started | Took | Driver | Result | Steps | Exported |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${formatWhen(r.startedAt)} | ${formatMs(r.durationMs)} | ${r.driver.split(' (')[0]} | ${r.statusText} | ${c.passed} passed · ${c.differences} differences · ${c.failed} failed · ${c.notRun} not run | ${formatWhen(report.exportedAt)} |`,
    '',
    '## About this document',
    '',
    `**What this is.** ${mask(report.about.whatThisIs)}`,
    '',
    `**What happened.** ${mask(report.about.whatHappened)}`,
    '',
    `**How to read it.** ${report.about.howToRead}`,
    '',
    `- **Cycle:** ${report.cycle.name}${report.cycle.versionSavedAt ? ` (version saved ${formatWhen(report.cycle.versionSavedAt)})` : ''} - id \`${report.cycle.id}\``,
    `- **Run id:** \`${r.id}\``,
    `- **Driver:** ${r.driver}`,
    `- **Started from:** ${r.startedFrom ?? 'the first step'}`,
    `- **Calls:** ${c.live} reached a real system (LIVE), ${c.replayed} answered by ALFRED (REPLAY)`,
    '',
  ];
  if (report.needsAttention.length) {
    lines.push('## Needs attention', '');
    for (const n of report.needsAttention) {
      const step = report.steps.find((s) => s.number === n.number)!;
      lines.push(`- ${OUTCOME_ICON[n.outcome]} **[${n.number} · ${n.label}](#${mdHeadingAnchor(heading(step))})**${n.mode ? ` (${n.mode})` : ''} - ${n.outcome}: ${mask(n.reason)}`);
    }
    lines.push('');
  }
  lines.push(
    '## All steps',
    '',
    '| # | Step | Mode | Outcome | Status (recorded → run) | Time (recorded → run) | Differences |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.steps.map((s) => {
      const real = s.differences.filter((d) => !d.noise).length;
      const noise = s.differences.length - real;
      return `| ${s.number} | ${s.isChild ? '↳ ' : ''}${cell(s.label)}<br>${cell(`${s.method} ${mask(s.url)}`)} | ${s.mode ?? '-'} | ${OUTCOME_ICON[s.outcome]} ${s.outcome} | ${s.status.recorded} → ${s.outcome === 'not run' ? '-' : s.status.run ?? 'none'} | ${formatMs(s.durationMs.recorded)} → ${formatMs(s.durationMs.run)} ${percent(s.durationMs.recorded, s.durationMs.run)} | ${real || '-'}${noise ? ` (+${noise} noise)` : ''} |`;
    }),
    '',
    '## Steps',
    '',
  );
  for (const s of report.steps) {
    const ran = s.outcome !== 'not run';
    lines.push(`### ${heading(s)}`, '', `\`${s.method} ${mask(s.url)}\`${s.mode ? ` · ${s.mode}` : ''}${s.attribution ? ` · attribution: ${s.attribution}` : ''}${s.isChild && s.parentNumber ? ` · supplier call made by step ${s.parentNumber}` : ''}`, '');
    if (s.reasons.length) {
      const label = s.outcome === 'failed' ? 'Why it failed' : s.outcome === 'differences' ? 'What differs' : 'Why it did not run';
      lines.push(`**${label}:** ${s.reasons.map(mask).join(' ')}`, '');
    }
    lines.push(
      '| | Recorded | This run |',
      '| --- | --- | --- |',
      `| Status | ${s.status.recorded} | ${ran ? `**${s.status.run ?? 'no answer'}**` : 'not run'} |`,
      `| Time | ${formatMs(s.durationMs.recorded)} | ${ran ? `${formatMs(s.durationMs.run)} ${percent(s.durationMs.recorded, s.durationMs.run)}` : '-'} |`,
      `| Rules applied | | ${s.rulesApplied.length ? cell(s.rulesApplied.map((x) => `${x.name} (${x.tier})`).join(', ')) : 'none'} |`,
      `| Variables used | | ${s.variablesUsed.length ? cell(mask(s.variablesUsed.map((v) => `{{${v.name}}} = ${v.value}`).join(', '))) : 'none'} |`,
      `| Values saved | | ${s.variablesSaved.length ? cell(mask(s.variablesSaved.map((v) => `{{${v.name}}} = ${v.value}`).join(', '))) : 'none'} |`,
      '',
      ...mdDifferences(s.differences, mask),
    );
    if (ran) {
      lines.push(
        ...mdHttp('Request sent', s.request, 'request', mask),
        ...mdHttp('Response received', s.response, 'response', mask),
        ...mdHttp('Recorded response', s.recorded.response, 'response', mask, false, '(what this run was compared with)'),
        ...mdHttp('Recorded request', s.recorded.request, 'request', mask),
      );
    } else {
      lines.push(...mdHttp('Recorded request', s.recorded.request, 'request', mask), ...mdHttp('Recorded response', s.recorded.response, 'response', mask));
    }
  }
  if (report.variables.length) {
    lines.push('## Values captured', '', '| Variable | Value | Saved by | Used by steps |', '| --- | --- | --- | --- |');
    for (const v of report.variables) lines.push(`| \`{{${cell(v.name)}}}\` | ${cell(mask(v.value))} | ${cell(v.savedBy ?? 'set before the run')} | ${v.usedBy.join(', ') || '-'} |`);
    lines.push('');
  }
  if (report.log.length) {
    lines.push('## Run log', '', '| Time | Step | What happened |', '| --- | --- | --- |');
    for (const l of report.log) lines.push(`| ${timeOf(l.at)} | ${l.step ?? '-'} | ${cell(mask(l.message))} |`);
    lines.push('');
  }
  lines.push('## Glossary', '', ...report.glossary.map((g) => `- **${g.term}** - ${g.meaning}`), '', '---', '', `*Generated by ALFRED Relive on ${formatWhen(report.exportedAt)}. Every request and response body is included in full, never shortened. Secret values are masked as •••; the .json export keeps them.*`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- run report: .json

function httpJson(http: HttpShape | null): unknown {
  if (!http) return null;
  return {
    ...(http.method ? { method: http.method } : {}),
    ...(http.url ? { url: http.url } : {}),
    ...(http.status != null ? { status: http.status } : {}),
    headers: http.headers ?? {},
    body: bodyValue(http.body),
  };
}

function aboutJson(title: string, verdict: ReportVerdict, about: RunReport['about'], glossary: readonly GlossaryEntry[], howToReadJson: string): unknown {
  return {
    title,
    verdict: `${verdict.lead} ${verdict.text}`,
    description: `${about.whatThisIs} ${about.whatHappened}`,
    whatThisIs: about.whatThisIs,
    whatHappened: about.whatHappened,
    howToRead: howToReadJson,
    glossary: Object.fromEntries(glossary.map((g) => [g.term, g.meaning])),
  };
}

/** Readable and complete, unmasked: `format` and `about` first, so an agent reads what this is
 *  before any data. Bodies that are JSON are embedded as JSON; others stay text. */
export function buildJsonRunReport(report: RunReport, raw: { readonly results: Readonly<Record<string, unknown>> } = { results: {} }): string {
  const r = report.run;
  return JSON.stringify({
    format: 'alfred.relive.run-report/v1',
    about: aboutJson(report.title, report.verdict, report.about, report.glossary,
      'steps[] is in run order; a step with parentStep is a supplier call made while handling that step. outcome is passed | differences | failed | not run | in progress, and reasons[] says why in full sentences. Each step has the request sent and the response received in this run, and the recorded request and response it was compared with - all in full. differences[] are the answer fields that differ from the recording: recorded vs run, counts=false means noise (expected to change every time). checks, requestChanged, pauses and unexpectedCalls are kept exactly as ALFRED stored them. Secrets are NOT masked in this file.'),
    exportedAt: report.exportedAt,
    cycle: report.cycle,
    run: { id: r.id, status: r.statusText, driver: r.driver, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, startedFrom: r.startedFrom },
    summary: report.counts,
    needsAttention: report.needsAttention.map((n) => ({ step: n.number, label: n.label, outcome: n.outcome, mode: n.mode, reason: n.reason })),
    steps: report.steps.map((s) => {
      const stored = raw.results[s.key] as Record<string, unknown> | undefined;
      return {
        step: s.number,
        key: s.key,
        label: s.label,
        direction: s.direction,
        parentStep: s.parentNumber,
        method: s.method,
        url: s.url,
        mode: s.mode,
        outcome: s.outcome,
        reasons: s.reasons,
        status: s.status,
        durationMs: s.durationMs,
        attribution: s.attribution,
        rulesApplied: s.rulesApplied,
        variablesUsed: s.variablesUsed,
        variablesSaved: s.variablesSaved,
        differences: s.differences.map((d) => ({ part: d.part, field: d.path, recorded: d.a, run: d.b, counts: !d.noise, ...(d.noise && d.cause ? { why: d.cause } : {}) })),
        error: s.error,
        request: httpJson(s.request),
        response: httpJson(s.response),
        recorded: { request: httpJson(s.recorded.request), response: httpJson(s.recorded.response), durationMs: s.durationMs.recorded },
        ...(stored ? {
          checks: stored['assertions'] ?? null,
          requestChanged: stored['requestChanged'] ?? null,
          pauses: stored['pauses'] ?? [],
          unexpectedCalls: stored['unexpectedCalls'] ?? [],
          attempt: stored['attempt'] ?? null,
          startedAt: stored['startedAt'] ?? null,
          finishedAt: stored['finishedAt'] ?? null,
        } : {}),
      };
    }),
    variables: report.variables.map((v) => ({ name: v.name, value: v.value, secret: v.secret, savedBy: v.savedBy, usedBySteps: v.usedBy })),
    log: report.log,
  }, null, 2);
}

// ---------------------------------------------------------------- comparison: shared

type CompareRow = CompareReport['rows'][number];

function sideSummary(side: CompareSideInfo): string {
  const parts = [side.steps];
  if (side.durationMs != null) parts.push(formatMs(side.durationMs));
  if (side.driver) parts.push(side.driver);
  if (side.cycleVersionSavedAt) parts.push(`cycle version ${formatWhen(side.cycleVersionSavedAt)}`);
  return parts.join(' · ');
}

function sideCell(s: StepSide): string {
  if (s.outcome === 'skip' && s.mode !== 'RECORDED') return '– not run';
  return `${SIDE_ICON[s.outcome]} ${s.status ?? 'no answer'}`;
}

// ---------------------------------------------------------------- comparison: .html

function sentHtml(row: CompareRow, mask: Mask): string {
  if (!row.sent.length) return '<div class="dim">Sent the same request in both.</div>';
  return fieldsHtml('What it sent differently', row.sent, ['What', 'A', 'B', ''], ['a', 'b'], mask, (f) => `<span class="faint">${escapeHtml(f.cause ?? '')}</span>`);
}

function compareCardHtml(row: CompareRow, report: CompareReport, mask: Mask): string {
  const side = (slot: 'a' | 'b', s: StepSide) => `<div class="side ${slot}"><span class="slot ${slot}">${slot.toUpperCase()}</span> ${escapeHtml(sideCell(s))} · ${formatMs(s.durationMs)}${s.mode ? ` · ${s.mode}` : ''}${s.result?.rulesApplied?.length ? ` · rules: ${escapeHtml(s.result.rulesApplied.map((x) => x.name).join(', '))}` : ''}${s.error ? `<div class="up">${escapeHtml(mask(s.error))}</div>` : ''}</div>`;
  const fields = row.fields.length
    ? fieldsHtml('Response fields that changed', row.fields, ['Field', 'A', 'B', ''], ['a', 'b'], mask, (d) => (d.noise ? `<span class="pill skip">noise${d.cause ? ` · ${escapeHtml(d.cause)}` : ''}</span>` : ''))
    : '<div class="dim">No field of the answer changed.</div>';
  return `<div class="step${row.isChild ? ' child' : ''}" id="${anchor(row.number)}">
  <div class="step-head"><span class="num">${row.number}</span><h3>${row.isChild ? '↗ ' : ''}${escapeHtml(row.label)}</h3><span class="pill ${VERDICT_CLASS[row.verdict]}">${VERDICT_ICON[row.verdict]} ${VERDICT_WORDS[row.verdict]}</span><div class="url-line">${escapeHtml(mask(`${row.step.recording.method} ${row.step.recording.url}`))}</div></div>
  <div class="step-body">
  <div class="two">${side('a', row.a)}${side('b', row.b)}</div>
  <h4>Differences</h4>${fields}
  ${sentHtml(row, mask)}
  <h4>Request and response of both, in full</h4>
  ${httpHtml(`Response A (${report.a.label})`, row.a.response, 'response', mask, false)}${httpHtml(`Response B (${report.b.label})`, row.b.response, 'response', mask)}${httpHtml('Request A', row.a.request, 'request', mask)}${httpHtml('Request B', row.b.request, 'request', mask)}
  </div></div>`;
}

export function buildHtmlCompareReport(report: CompareReport): string {
  const mask = maskerOf(report.secretNames, report.values);
  const cmp = report.comparison;
  const changed = report.rows.filter((r) => r.verdict !== 'SAME');
  const same = report.rows.filter((r) => r.verdict === 'SAME');
  const toc = `<b>This report</b><a href="#summary">Verdict</a><a href="#about">About this document</a><a href="#all-steps">Steps</a>${changed.length ? `<a href="#changed">What changed (${changed.length})</a>` : ''}${same.length ? `<a href="#same">Unchanged (${same.length})</a>` : ''}${cmp.variables.length ? '<a href="#values">Values captured</a>' : ''}<a href="#glossary">Glossary</a>
  ${changed.length ? `<b>Changed steps</b>${changed.map((r) => `<a href="#${anchor(r.number)}"${r.isChild ? ' class="child"' : ''} title="${escapeHtml(r.label)}"><i class="dot ${VERDICT_CLASS[r.verdict]}"></i>${r.number} ${escapeHtml(r.label)}</a>`).join('')}` : ''}`;

  const sideBox = (s: CompareSideInfo) => `<div class="side ${s.slot.toLowerCase()}"><span class="slot ${s.slot.toLowerCase()}">${s.slot}</span> <b>${escapeHtml(s.isRecording ? 'The recording' : formatWhen(s.startedAt))}</b> <span class="dim">(${s.role})</span>${s.status ? ` · ${escapeHtml(s.status)}` : ''}<div class="dim">${escapeHtml(sideSummary(s))}${s.slot === 'B' && report.cycleEditedBetween ? ' <span class="warn">· the cycle was edited between A and B</span>' : ''}</div>${s.runId ? `<div class="faint mono">run ${escapeHtml(s.runId)}</div>` : ''}</div>`;
  const c = cmp.counts;
  const tile = (n: number, label: string, color: string) => `<div class="tile"><b style="color:${color}">${n}</b><span>${label}</span></div>`;
  const maxMs = (r: CompareRow) => Math.max(r.a.durationMs ?? 0, r.b.durationMs ?? 0) || 1;

  const body = `<div id="summary"><div class="kicker">ALFRED · Relive run comparison</div>
  <h1>${escapeHtml(report.cycleName)} - A vs B</h1>
  <div class="two">${sideBox(report.a)}${sideBox(report.b)}</div>
  ${verdictHtml(report.verdict, mask)}
  <div class="tiles">${tile(cmp.changedCount, 'changed', 'var(--amber)')}${tile(c.NEW_FAILURE, 'new failures', 'var(--red)')}${tile(c.FIXED, 'fixed', 'var(--cyan)')}${tile(c.CHANGED, 'answers changed', 'var(--amber)')}${c.NOT_RUN ? tile(c.NOT_RUN, 'ran in one only', 'var(--dim)') : ''}${tile(c.SLOWER, 'slower', 'var(--amber)')}${tile(c.FASTER, 'faster', 'var(--green)')}${tile(c.SAME, 'same', 'var(--dim)')}</div></div>

  <section id="about"><h2>About this document</h2><div class="card about">
    <p><b>What this is.</b> ${escapeHtml(mask(report.about.whatThisIs))}</p>
    <p><b>What changed.</b> ${escapeHtml(mask(report.about.whatHappened))}</p>
    <p><b>How to read it.</b> ${escapeHtml(report.about.howToRead)}</p>
  </div></section>

  <section id="all-steps"><h2>Steps <small>${changed.length} changed · ${same.length} the same</small></h2>
  <table class="t"><tr><th>#</th><th>Step</th><th>A → B</th><th>Fields</th><th>Time A → B</th><th>Verdict</th></tr>
  ${report.rows.map((r) => {
    const real = r.fields.filter((f) => !f.noise).length;
    const link = r.verdict === 'SAME' ? escapeHtml(r.label) : `<a href="#${anchor(r.number)}">${escapeHtml(r.label)}</a>`;
    return `<tr class="${r.isChild ? 'child' : ''}${r.verdict === 'SAME' ? ' quiet' : ''}"><td>${r.number}</td><td class="name">${r.isChild ? '↗ ' : ''}${link}<span class="url-sm">${escapeHtml(mask(`${r.step.recording.method} ${r.step.recording.url}`))}</span></td><td><span class="pill ${SIDE_CLASS[r.a.outcome]}">${escapeHtml(sideCell(r.a))}</span> → <span class="pill ${SIDE_CLASS[r.b.outcome]}">${escapeHtml(sideCell(r.b))}</span></td><td>${real || '<span class="faint">-</span>'}</td><td class="mono">${formatMs(r.a.durationMs)} → ${formatMs(r.b.durationMs)} <span class="${(r.timeChangePct ?? 0) > 0 ? 'up' : 'down'}">${r.timeChangePct != null ? `${r.timeChangePct > 0 ? '+' : ''}${r.timeChangePct}%` : ''}</span><div class="bar"><i class="a" style="width:${((r.a.durationMs ?? 0) / maxMs(r)) * 100}%"></i><i class="b" style="width:${((r.b.durationMs ?? 0) / maxMs(r)) * 100}%"></i></div></td><td><span class="pill ${VERDICT_CLASS[r.verdict]}">${VERDICT_ICON[r.verdict]} ${VERDICT_WORDS[r.verdict]}</span></td></tr>`;
  }).join('')}</table></section>

  ${changed.length ? `<section id="changed"><h2>What changed <small>each changed step, with both answers in full</small></h2>${changed.map((r) => compareCardHtml(r, report, mask)).join('\n')}</section>` : ''}
  ${same.length ? `<section id="same"><h2>Unchanged steps <small>same outcome, answer and time - both answers in full</small></h2>${same.map((r) => compareCardHtml(r, report, mask)).join('\n')}</section>` : ''}

  ${cmp.variables.length ? `<section id="values"><h2>Values captured <small>often why a later step differs</small></h2><table class="t"><tr><th>Variable</th><th>Saved by</th><th>A</th><th>B</th><th></th></tr>${cmp.variables.map((v) => `<tr><td class="mono">{{${escapeHtml(v.name)}}}</td><td>${escapeHtml(v.savedBy ?? '')}</td><td class="mono">${v.a == null ? '<span class="faint">not set</span>' : escapeHtml(mask(v.a))}</td><td class="mono">${v.b == null ? '<span class="faint">not set</span>' : escapeHtml(mask(v.b))}</td><td>${v.change === 'same' ? '<span class="pill skip">same</span>' : v.change === 'changed' ? '<span class="pill diff">changed</span>' : `<span class="pill fail">missing in ${v.change === 'missing-a' ? 'A' : 'B'}</span>`}</td></tr>`).join('')}</table></section>` : ''}

  ${glossaryHtml(report.glossary)}
  <div class="foot">Generated by ALFRED Relive on ${escapeHtml(formatWhen(report.exportedAt))} · both responses of every step are included in full, never shortened · secret values are masked as •••; the .json export keeps them.</div>`;
  return page(report.title, toc, body);
}

// ---------------------------------------------------------------- comparison: .md

export function buildMarkdownCompareReport(report: CompareReport): string {
  const mask = maskerOf(report.secretNames, report.values);
  const cmp = report.comparison;
  const c = cmp.counts;
  const changed = report.rows.filter((r) => r.verdict !== 'SAME');
  const same = report.rows.filter((r) => r.verdict === 'SAME');
  const sideRow = (s: CompareSideInfo) => `| **${s.slot}** (${s.role}) | ${s.isRecording ? 'the recording' : formatWhen(s.startedAt)} | ${s.status ?? '-'} | ${s.steps} | ${formatMs(s.durationMs)} | ${s.driver ?? '-'} | ${s.cycleVersionSavedAt ? formatWhen(s.cycleVersionSavedAt) : '-'}${s.slot === 'B' && report.cycleEditedBetween ? ' *(edited between A and B)*' : ''} |`;
  const lines: string[] = [
    `# ${report.title}`,
    '',
    `> **${report.verdict.lead}** ${mask(report.verdict.text)}`,
    '',
    '| | Run | Result | Steps | Took | Driver | Cycle version |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    sideRow(report.a),
    sideRow(report.b),
    '',
    '## About this document',
    '',
    `**What this is.** ${mask(report.about.whatThisIs)}`,
    '',
    `**What changed.** ${mask(report.about.whatHappened)}`,
    '',
    `**How to read it.** ${report.about.howToRead}`,
    '',
    '| New failures | Fixed | Answers changed | Ran in one only | Slower | Faster | Same |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${c.NEW_FAILURE} | ${c.FIXED} | ${c.CHANGED} | ${c.NOT_RUN} | ${c.SLOWER} | ${c.FASTER} | ${c.SAME} |`,
    '',
    '## Steps',
    '',
    '| # | Step | A → B | Fields | Time A → B | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.rows.map((r) => `| ${r.number} | ${r.isChild ? '↳ ' : ''}${cell(r.label)}<br>${cell(mask(`${r.step.recording.method} ${r.step.recording.url}`))} | ${sideCell(r.a)} → ${sideCell(r.b)} | ${r.fields.filter((f) => !f.noise).length || '-'} | ${formatMs(r.a.durationMs)} → ${formatMs(r.b.durationMs)}${r.timeChangePct != null ? ` (${r.timeChangePct > 0 ? '+' : ''}${r.timeChangePct}%)` : ''} | ${VERDICT_ICON[r.verdict]} ${VERDICT_WORDS[r.verdict]} |`),
    '',
  ];
  const card = (r: CompareRow) => {
    const out = [
      `### ${r.number} · ${r.label} - ${VERDICT_WORDS[r.verdict]}`,
      '',
      `\`${r.step.recording.method} ${mask(r.step.recording.url)}\``,
      '',
      '| | A | B |',
      '| --- | --- | --- |',
      `| Outcome | ${sideCell(r.a)} | ${sideCell(r.b)} |`,
      `| Time | ${formatMs(r.a.durationMs)} | ${formatMs(r.b.durationMs)}${r.timeChangePct != null ? ` (${r.timeChangePct > 0 ? '+' : ''}${r.timeChangePct}%)` : ''} |`,
      `| Mode | ${r.a.mode ?? '-'} | ${r.b.mode ?? '-'} |`,
      ...(r.a.error || r.b.error ? [`| Error | ${cell(mask(r.a.error ?? '-'))} | ${cell(mask(r.b.error ?? '-'))} |`] : []),
      '',
    ];
    if (r.fields.length) {
      out.push(...mdFields('Response fields that changed', r.fields, ['Field', 'A', 'B', ''], mask, (f) => (f.noise ? `noise${f.cause ? ` (${cell(f.cause)})` : ''}` : '')));
    }
    if (r.sent.length) {
      out.push(...mdFields('What it sent differently', r.sent, ['What', 'A', 'B', ''], mask, (f) => f.cause ?? ''));
    }
    out.push(
      ...mdHttp(`Response A (${report.a.label})`, r.a.response, 'response', mask),
      ...mdHttp(`Response B (${report.b.label})`, r.b.response, 'response', mask),
      ...mdHttp('Request A', r.a.request, 'request', mask),
      ...mdHttp('Request B', r.b.request, 'request', mask),
    );
    return out;
  };
  if (changed.length) lines.push('## What changed', '', ...changed.flatMap(card));
  if (same.length) lines.push('## Unchanged steps', '', ...same.flatMap(card));
  if (cmp.variables.length) {
    lines.push('## Values captured', '', '| Variable | Saved by | A | B | |', '| --- | --- | --- | --- | --- |');
    for (const v of cmp.variables) lines.push(`| \`{{${cell(v.name)}}}\` | ${cell(v.savedBy ?? '')} | ${v.a == null ? '*not set*' : cell(mask(v.a))} | ${v.b == null ? '*not set*' : cell(mask(v.b))} | ${v.change === 'missing-a' ? 'missing in A' : v.change === 'missing-b' ? 'missing in B' : v.change} |`);
    lines.push('');
  }
  lines.push('## Glossary', '', ...report.glossary.map((g) => `- **${g.term}** - ${g.meaning}`), '', '---', '', `*Generated by ALFRED Relive on ${formatWhen(report.exportedAt)}. Both responses of every step are included in full, never shortened. Secret values are masked as •••; the .json export keeps them.*`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- comparison: .json

function sideJson(s: StepSide): unknown {
  return {
    outcome: s.outcome === 'ok' ? 'passed' : s.outcome === 'diff' ? 'differences' : s.outcome === 'fail' ? 'failed' : s.mode === 'RECORDED' ? 'recorded' : 'not run',
    status: s.status,
    durationMs: s.durationMs,
    mode: s.mode,
    error: s.error,
    rulesApplied: (s.result?.rulesApplied ?? []).map((r) => ({ name: r.name, tier: r.tier.toLowerCase() })),
    variablesUsed: s.result?.variablesUsed ?? [],
    variablesSaved: s.result?.variablesProduced ?? [],
    request: httpJson(s.request),
    response: httpJson(s.response),
  };
}

export function buildJsonCompareReport(report: CompareReport): string {
  const cmp = report.comparison;
  const sideInfo = (s: CompareSideInfo) => ({ label: `${s.slot} (${s.role})`, isRecording: s.isRecording, runId: s.runId, startedAt: s.startedAt, result: s.status, steps: s.steps, durationMs: s.durationMs, driver: s.driver, cycleVersionSavedAt: s.cycleVersionSavedAt });
  return JSON.stringify({
    format: 'alfred.relive.run-comparison/v1',
    about: aboutJson(report.title, report.verdict, report.about, report.glossary,
      'steps[] is in run order; a step with parentStep is a supplier call made while handling that step. verdict is new failure | fixed | answer changed | ran in one only | slower | faster | same. fields[] are the answer fields that differ between A and B (noise=true: expected to change every run, never makes a step changed); sentDifferently[] is what the step sent differently. a and b hold each side\'s outcome, request and response in full. Secrets are NOT masked in this file.'),
    exportedAt: report.exportedAt,
    cycleName: report.cycleName,
    a: sideInfo(report.a),
    b: sideInfo(report.b),
    cycleEditedBetween: report.cycleEditedBetween,
    counts: {
      changed: cmp.changedCount,
      newFailures: cmp.counts.NEW_FAILURE,
      fixed: cmp.counts.FIXED,
      answersChanged: cmp.counts.CHANGED,
      ranInOneOnly: cmp.counts.NOT_RUN,
      slower: cmp.counts.SLOWER,
      faster: cmp.counts.FASTER,
      same: cmp.counts.SAME,
    },
    steps: report.rows.map((r) => ({
      step: r.number,
      key: r.key,
      label: r.label,
      parentStep: r.isChild ? r.number.split('.')[0] : null,
      method: r.step.recording.method,
      url: r.step.recording.url,
      verdict: VERDICT_WORDS[r.verdict],
      timeChangePct: r.timeChangePct,
      fields: r.fields.map((f) => ({ part: f.part, field: f.path, a: f.a, b: f.b, noise: f.noise, ...(f.noise && f.cause ? { why: f.cause } : {}) })),
      sentDifferently: r.sent.map((f) => ({ what: f.path, a: f.a, b: f.b, kind: f.cause })),
      a: sideJson(r.a),
      b: sideJson(r.b),
    })),
    variables: cmp.variables,
  }, null, 2);
}
