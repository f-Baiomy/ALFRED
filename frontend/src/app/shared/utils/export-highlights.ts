import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { ExportedSpacer } from '../../core/models/export-metadata.model';
import { uriPath } from './call-utils';
import { emptyResultOf, softFailureOf } from './soft-failure';
import { layoutSpacers } from './spacer-gap-controller';

/**
 * What a reader needs before the raw calls: the steps of the story (the cycle's spacers), what
 * failed, what failed inside a 200, which results came back empty, and the notes already written
 * about it (whole-call notes, and Claude's). Shared by the .md and .html exports so both open with
 * the same facts - the .html as a story (steps on a rail, each note a card under its call), the .md as
 * a table (one row per note, steps as band rows; specs/006-db-capture/glance-options-mock.html B and C).
 * Numbers are the exports' own chronological call numbers (1 = earliest).
 */
export interface ExportHighlights {
  readonly callCount: number;
  readonly steps: readonly { readonly label: string; readonly from: number; readonly to: number }[];
  readonly failures: readonly HighlightCall[];
  readonly softFailures: readonly (HighlightCall & { readonly code: string | null; readonly message: string })[];
  readonly emptyResults: readonly (HighlightCall & { readonly keys: readonly string[] })[];
  readonly notes: readonly HighlightNote[];
  /** The note that explains the whole cycle (one starting "CYCLE OVERVIEW"), shown above the steps. */
  readonly overview: HighlightNote | null;
}

export interface HighlightCall {
  readonly n: number;
  readonly label: string;
  readonly method: string;
  readonly path: string;
  /** "200", "error: …" or "no response". */
  readonly outcome: string;
  readonly failed: boolean;
}

export interface HighlightNote extends HighlightCall {
  /** The note as written (kept whole - exports never cut call data). */
  readonly text: string;
  /** The note without its "🤖 Claude:" prefix. */
  readonly body: string;
  /** 'Claude' for Claude's notes (mcp-server's add_comment), null for a person's whole-call note. */
  readonly by: string | null;
}

/** Claude's comments start with this (mcp-server's add_comment) - shown here like whole-call notes. */
const CLAUDE_PREFIX = '🤖';
const OVERVIEW = /^cycle overview\b[\s:–-]*/i;

function outcomeOf(call: CallRecord): string {
  return call.error ? `error: ${call.error}` : call.response ? String(call.response.status) : 'no response';
}

function noteOf(at: HighlightCall, text: string): HighlightNote {
  const claude = text.startsWith(CLAUDE_PREFIX);
  const body = claude ? text.slice(CLAUDE_PREFIX.length).replace(/^\s*Claude\s*:\s*/i, '').trim() : text.trim();
  return { ...at, text, body, by: claude ? 'Claude' : null };
}

export function buildExportHighlights(
  calls: readonly CallRecord[],
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  spacers: readonly ExportedSpacer[],
): ExportHighlights {
  const sorted = [...calls].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const at = (call: CallRecord, i: number): HighlightCall => {
    const outcome = outcomeOf(call);
    return {
      n: i + 1, label: `${call.method} ${uriPath(call.url)} → ${outcome}`, method: call.method, path: uriPath(call.url), outcome,
      failed: !!call.error || !call.response || call.response.status >= 400,
    };
  };

  // Placed by the one spacer layout every view uses; a step runs from its spacer to the next.
  const steps: { label: string; from: number; to: number }[] = [];
  if (spacers.length) {
    let index = 0;
    for (const entry of layoutSpacers(sorted, (c) => c, spacers, { descending: false, byTime: true }).merged) {
      if (entry.kind === 'spacer') {
        steps.push({ label: entry.spacer.label, from: index + 1, to: index });
      } else {
        index++;
        if (steps.length) steps[steps.length - 1].to = index;
      }
    }
  }

  const allNotes = sorted.flatMap((c, i) => (commentsByCallId.get(c.id) ?? [])
    .filter((comment) => comment.block === 'call' || comment.comment.startsWith(CLAUDE_PREFIX))
    .map((comment) => noteOf(at(c, i), comment.comment)));
  const overview = allNotes.find((note) => OVERVIEW.test(note.body)) ?? null;

  return {
    callCount: sorted.length,
    steps: steps.filter((s) => s.to >= s.from),
    failures: sorted.flatMap((c, i) => (c.error || (c.response?.status ?? 0) >= 400 ? [at(c, i)] : [])),
    softFailures: sorted.flatMap((c, i) => {
      const soft = softFailureOf(c);
      return soft ? [{ ...at(c, i), code: soft.code, message: soft.message }] : [];
    }),
    emptyResults: sorted.flatMap((c, i) => {
      const empty = c.source === 'internal' ? emptyResultOf(c) : null;
      return empty ? [{ ...at(c, i), keys: empty.emptyKeys }] : [];
    }),
    notes: allNotes.filter((note) => note !== overview),
    overview,
  };
}

export function hasHighlights(h: ExportHighlights): boolean {
  return h.steps.length + h.failures.length + h.softFailures.length + h.emptyResults.length + h.notes.length > 0 || !!h.overview;
}

/** The notes under each step, in order; notes on calls before the first step (or with no steps) go to "Other calls". */
function notesBySection(h: ExportHighlights): { label: string | null; n: number | null; from: number; to: number; notes: HighlightNote[] }[] {
  const sections = h.steps.map((s, i) => ({ label: s.label, n: i, from: s.from, to: s.to, notes: [] as HighlightNote[] }));
  const other = { label: null, n: null, from: 0, to: 0, notes: [] as HighlightNote[] };
  for (const note of h.notes) {
    (sections.find((s) => note.n >= s.from && note.n <= s.to) ?? other).notes.push(note);
  }
  return other.notes.length ? [...sections, other] : sections;
}

const range = (from: number, to: number) => (to > from ? `calls ${from}–${to}` : `call ${from}`);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function countsLine(h: ExportHighlights): string {
  return [plural(h.callCount, 'call'), h.steps.length ? plural(h.steps.length, 'step') : '', plural(h.notes.length + (h.overview ? 1 : 0), 'note'),
    `${h.failures.length} failed`, h.softFailures.length ? `${plural(h.softFailures.length, 'error')} inside a 200` : '',
    h.emptyResults.length ? plural(h.emptyResults.length, 'empty result') : ''].filter(Boolean).join(' · ');
}

/** "Needs a look": failures, errors inside successful responses and empty results, one row each. */
function issuesOf(h: ExportHighlights): { call: HighlightCall; why: string }[] {
  return [
    ...h.failures.map((c) => ({ call: c, why: c.outcome.startsWith('error') ? c.outcome : `failed with ${c.outcome}` })),
    ...h.softFailures.map((c) => ({ call: c, why: `✖ ${c.code ? `${c.code}: ` : ''}${c.message}` })),
    ...h.emptyResults.map((c) => ({ call: c, why: `empty: ${c.keys.map((k) => `\`${k}\``).join(', ')}` })),
  ].sort((a, b) => a.call.n - b.call.n);
}

/** Markdown: a table - one row per note, the steps as band rows; then "Needs a look" as a second table. */
export function highlightsMarkdown(h: ExportHighlights, md: (text: string) => string): string[] {
  if (!hasHighlights(h)) return [];
  const link = (c: HighlightCall) => `[${c.n}](#call-${c.n})`;
  const request = (c: HighlightCall) => `\`${c.method}\` ${md(c.path)} → ${c.failed ? `**${md(c.outcome)}**` : md(c.outcome)}`;
  const note = (n: HighlightNote) => `${n.by ? '🤖 ' : ''}${md(n.body)}`;
  const lines = ['## 🔎 At a Glance', '', `**${countsLine(h)}**`, ''];
  if (h.overview) {
    lines.push(`> **🤖 ${h.overview.by ?? 'Note'} · cycle overview** (on ${link(h.overview).replace(/^\[(\d+)\]/, '[call $1]')})`, '>');
    for (const para of h.overview.body.replace(OVERVIEW, '').split(/\n\s*\n/)) lines.push(`> ${para.replace(/\s*\n\s*/g, ' ')}`, '>');
    lines.pop();
    lines.push('');
  }
  const sections = notesBySection(h);
  if (sections.length) {
    lines.push('### Steps and notes', '', '| Call | Request | Note |', '|---|---|---|');
    for (const s of sections) {
      const title = s.label == null ? '**Other calls**' : `**${s.n} · ${md(s.label)}** · ${range(s.from, s.to)}${s.notes.length ? '' : ' · _no notes_'}`;
      lines.push(`| ${title} | | |`);
      for (const n of s.notes) lines.push(`| ${link(n)} | ${request(n)} | ${note(n)} |`);
    }
    lines.push('');
  }
  const issues = issuesOf(h);
  if (issues.length) {
    lines.push('### Needs a look', '', '| Call | Request | Why |', '|---|---|---|');
    for (const i of issues) lines.push(`| ${link(i.call)} | ${request(i.call)} | ${md(i.why)} |`);
    lines.push('');
  }
  lines.push('---', '');
  return lines;
}

/**
 * HTML: a story - numbered step markers on a rail, each note a card under its step showing its call; steps without
 * notes are one quiet line. `esc` is the builder's own escaping, so call data can never become markup.
 */
export function highlightsHtml(h: ExportHighlights, esc: (text: string) => string): string {
  if (!hasHighlights(h)) return '';
  const callHead = (c: HighlightCall) => `<a class="gl-cl" href="#call-${c.n}">call ${c.n}</a><span class="gl-m">${esc(c.method)}</span>`
    + `<span class="gl-path">${esc(c.path)}</span><span class="${c.failed ? 'gl-bad' : 'gl-ok'}">${esc(c.outcome)}</span>`;
  const paras = (text: string) => text.split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\r?\n/g, '<br>')}</p>`).join('');
  const card = (n: HighlightNote) => `<div class="gl-ev"><div class="gl-h">${callHead(n)}</div>${n.by ? `<span class="gl-by">${esc(n.by)}</span>` : ''}${paras(n.body)}</div>`;

  let html = `<section class="about glance"><h2>🔎 At a Glance</h2><div class="gl-counts">${esc(countsLine(h))}</div>`;
  if (h.overview) {
    html += `<div class="gl-overview"><div class="gl-who">${h.overview.by ? '🤖 ' + esc(h.overview.by) + ' · ' : ''}cycle overview · on <a href="#call-${h.overview.n}">call ${h.overview.n}</a></div>`
      + `${paras(h.overview.body.replace(OVERVIEW, ''))}</div>`;
  }
  const sections = notesBySection(h);
  if (sections.length) {
    html += '<div class="gl-tl">' + sections.map((s) => `<div class="gl-step" data-n="${s.n ?? '·'}">${s.label == null ? 'Other calls' : esc(s.label)}`
      + `${s.label == null ? '' : `<span class="gl-rg">${range(s.from, s.to)}</span>`}</div>`
      + (s.notes.length ? s.notes.map(card).join('') : '<div class="gl-quiet">no notes</div>')).join('') + '</div>';
  }
  const issues = issuesOf(h);
  if (issues.length) {
    html += '<div class="gl-sec">Needs a look</div><div class="gl-issues">' + issues.map((i) => `<div class="gl-h">${callHead(i.call)}`
      + `<span class="gl-why">${esc(i.why).replace(/`([^`]*)`/g, '<code>$1</code>')}</span></div>`).join('') + '</div>';
  }
  return html + '</section>';
}

/** The story's look - added to the .html export's stylesheet (uses its theme variables). */
export const GLANCE_STYLE = `
.glance .gl-counts { color: var(--text-dim); font-size: 0.85rem; margin: -0.3rem 0 0.8rem; }
.glance .gl-overview { border-left: 3px solid #a78bfa; background: rgba(167,139,250,.07); border-radius: 0 8px 8px 0; padding: 0.45rem 0.8rem; margin-bottom: 0.9rem; }
.glance .gl-overview p { color: var(--text); margin: 0.25rem 0; }
.glance .gl-who { font-size: 0.7rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #a78bfa; }
.glance .gl-who a { color: inherit; }
.glance .gl-tl { position: relative; margin-left: 0.7rem; padding-left: 1.4rem; border-left: 2px solid var(--border); }
.glance .gl-step { position: relative; margin: 0.9rem 0 0.35rem; font-weight: 700; color: var(--text); }
.glance .gl-step::before { content: attr(data-n); position: absolute; left: -2.3rem; top: -0.1rem; width: 1.6rem; height: 1.6rem; border-radius: 50%;
  background: var(--card); border: 2px solid #a78bfa; color: #a78bfa; font-size: 0.7rem; display: flex; align-items: center; justify-content: center; }
.glance .gl-rg { font-weight: 400; font-family: Consolas, monospace; font-size: 0.75rem; color: var(--text-dim); margin-left: 0.5rem; }
.glance .gl-ev { position: relative; margin: 0.3rem 0; padding: 0.4rem 0.65rem; border-radius: 8px; background: var(--card-inner); border: 1px solid var(--border); }
.glance .gl-ev::before { content: ''; position: absolute; left: -1.75rem; top: 0.8rem; width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); }
.glance .gl-ev p { color: var(--text); margin: 0.15rem 0; }
.glance .gl-h { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; font-size: 0.78rem; margin-bottom: 0.15rem; }
.glance .gl-cl { font-family: Consolas, monospace; white-space: nowrap; }
.glance .gl-m { font-size: 0.65rem; font-weight: 700; border-radius: 5px; padding: 0 0.35rem; background: rgba(125,211,252,.12); color: #7dd3fc; }
.glance .gl-path { font-family: Consolas, monospace; color: var(--text-dim); word-break: break-all; }
.glance .gl-ok { font-family: Consolas, monospace; color: #6ee7a8; } .glance .gl-bad { font-family: Consolas, monospace; color: #f07178; font-weight: 700; }
.glance .gl-by { float: left; margin: 0.2rem 0.4rem 0 0; font-size: 0.62rem; font-weight: 700; color: #a78bfa; background: rgba(167,139,250,.12); border-radius: 4px; padding: 0 0.3rem; }
.glance .gl-quiet { color: var(--text-dim); font-size: 0.78rem; margin: 0.1rem 0 0.2rem; }
.glance .gl-sec { font-size: 0.7rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--text-dim); margin: 1rem 0 0.35rem; }
.glance .gl-issues .gl-h { padding: 0.25rem 0; border-top: 1px dashed var(--border); font-size: 0.82rem; }
.glance .gl-why { color: var(--text); }
`;
