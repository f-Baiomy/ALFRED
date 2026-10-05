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
 * the same facts. Numbers are the exports' own chronological call numbers (1 = earliest).
 */
export interface ExportHighlights {
  readonly steps: readonly { readonly label: string; readonly from: number; readonly to: number }[];
  readonly failures: readonly HighlightCall[];
  readonly softFailures: readonly (HighlightCall & { readonly code: string | null; readonly message: string })[];
  readonly emptyResults: readonly (HighlightCall & { readonly keys: readonly string[] })[];
  readonly notes: readonly (HighlightCall & { readonly text: string })[];
}

export interface HighlightCall {
  readonly n: number;
  readonly label: string;
}

/** Claude's comments start with this (mcp-server's add_comment) - shown here like whole-call notes. */
const CLAUDE_PREFIX = '🤖';

function labelOf(call: CallRecord): string {
  const outcome = call.error ? `error: ${call.error}` : call.response ? String(call.response.status) : 'no response';
  return `${call.method} ${uriPath(call.url)} → ${outcome}`;
}

export function buildExportHighlights(
  calls: readonly CallRecord[],
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  spacers: readonly ExportedSpacer[],
): ExportHighlights {
  const sorted = [...calls].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const at = (call: CallRecord, i: number): HighlightCall => ({ n: i + 1, label: labelOf(call) });

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

  return {
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
    notes: sorted.flatMap((c, i) => (commentsByCallId.get(c.id) ?? [])
      .filter((comment) => comment.block === 'call' || comment.comment.startsWith(CLAUDE_PREFIX))
      .map((comment) => ({ ...at(c, i), text: comment.comment }))),
  };
}

export function hasHighlights(h: ExportHighlights): boolean {
  return h.steps.length + h.failures.length + h.softFailures.length + h.emptyResults.length + h.notes.length > 0;
}

/** Markdown: one heading, a short list per kind, each call linked to its section. */
export function highlightsMarkdown(h: ExportHighlights, md: (text: string) => string): string[] {
  if (!hasHighlights(h)) return [];
  const link = (c: HighlightCall) => `[call ${c.n}](#call-${c.n})`;
  const lines = ['## 🔎 At a Glance', ''];
  if (h.steps.length) lines.push('**Steps**', '', ...h.steps.map((s) => `- **${md(s.label)}** - calls ${s.from}${s.to > s.from ? `-${s.to}` : ''}`), '');
  if (h.failures.length) lines.push('**Failed**', '', ...h.failures.map((c) => `- ${link(c)} ${md(c.label)}`), '');
  if (h.softFailures.length) {
    lines.push('**Errors inside successful responses**', '', ...h.softFailures.map((c) => `- ${link(c)} ${md(c.label)} - ✖ ${c.code ? `${md(c.code)}: ` : ''}${md(c.message)}`), '');
  }
  if (h.emptyResults.length) lines.push('**Empty results**', '', ...h.emptyResults.map((c) => `- ${link(c)} ${md(c.label)} - empty: ${c.keys.map((k) => `\`${k}\``).join(', ')}`), '');
  if (h.notes.length) lines.push('**Notes**', '', ...h.notes.map((c) => `- ${link(c)} ${md(c.text.replace(/\s*\n\s*/g, ' '))}`), '');
  lines.push('---', '');
  return lines;
}

/** HTML: the same lists; `esc` is the builder's own escaping, so call data can never become markup. */
export function highlightsHtml(h: ExportHighlights, esc: (text: string) => string): string {
  if (!hasHighlights(h)) return '';
  const list = (title: string, items: readonly string[]) => (items.length ? `<p><b>${title}</b></p><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '');
  const call = (c: HighlightCall) => `<b>call ${c.n}</b> ${esc(c.label)}`;
  return '<section class="about"><h2>🔎 At a Glance</h2>'
    + list('Steps', h.steps.map((s) => `<b>${esc(s.label)}</b> - calls ${s.from}${s.to > s.from ? `-${s.to}` : ''}`))
    + list('Failed', h.failures.map(call))
    + list('Errors inside successful responses', h.softFailures.map((c) => `${call(c)} - ✖ ${c.code ? `${esc(c.code)}: ` : ''}${esc(c.message)}`))
    + list('Empty results', h.emptyResults.map((c) => `${call(c)} - empty: ${c.keys.map((k) => `<code>${esc(k)}</code>`).join(', ')}`))
    + list('Notes', h.notes.map((c) => `${call(c)} ${esc(c.text)}`))
    + '</section>';
}
