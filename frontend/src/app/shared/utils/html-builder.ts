import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { ExportedCycle, ExportedSpacer, ExportFormData } from '../../core/models/export-metadata.model';
import { Comment, CommentBlock, COMMENT_BLOCK_LABELS } from '../../core/models/comment.model';
import { detectAndFormatBody } from './body-format';
import { CallStatusFilter, callKey, isInProgress, supplierOf, uriPath } from './call-utils';
import { buildExportNarrative, depthByCallId, depthSentence, ExportNarrative } from './export-narrative';
import { buildWaterfallBands, waterfallAxisTicks, waterfallFormatMs, waterfallStatusText } from './waterfall';

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

/**
 * The "About This Document" section - see export-narrative.ts for why it exists. Rendered as one
 * bordered card rather than a run of <h2>s so it reads as a preface to the report rather than as its
 * first chapter, and the topology goes in a <pre> so it can be copied out with its alignment intact.
 */
function aboutSectionHtml(narrative: ExportNarrative): string {
  const parts: string[] = ['<section class="about">', '<h2>📖 About This Document</h2>'];

  parts.push(`<p><b>What this is.</b> ${escapeHtml(narrative.description)}</p>`);

  const depth = depthSentence(narrative);
  if (narrative.treeLines.length > 0 || narrative.flowSummary || depth) {
    parts.push(`<p><b>Who called whom.</b> ${depth ? escapeHtml(depth) : ''}</p>`);
    if (narrative.treeLines.length > 0) {
      parts.push(`<pre class="about-tree">${escapeHtml(narrative.treeLines.join('\n'))}</pre>`);
    }
    if (narrative.flowSummary) parts.push(`<p>${escapeHtml(narrative.flowSummary)}</p>`);
  }

  // A real Gantt rather than the .md's monospace approximation: same bands and same per-parent
  // scaling, but with an axis, gridlines and the parent's own span drawn as the track the children
  // sit inside. Without the axis it is only a picture of relative widths - it can say "this one is
  // wider", not "this started four seconds in".
  const bands = buildWaterfallBands(narrative);
  if (bands) {
    parts.push(
      "<p><b>When each call ran.</b> One chart per call that caused others, each scaled to that call's own window - so bars within a chart can be compared to each other, but not across charts. Durations are absolute.</p>"
    );
    for (const band of bands) {
      const ticks = waterfallAxisTicks(band.spanMs);
      // Indented and rail-connected to the chart it belongs to, with links both ways. Without that
      // each chart reads as an island and the same call appearing as a row here and as the parent of
      // the next chart looks like a coincidence rather than the same call.
      const nested = band.parentNumber != null;
      parts.push(
        `<div class="gantt${nested ? ' gantt-nested' : ''}" id="gantt-${band.number}"${nested ? ` style="margin-left:${band.depth * 22}px"` : ''}>`
      );
      parts.push(
        `<div class="gantt-title">Call ${band.number} &middot; ${escapeHtml(band.label)}` +
          (nested ? ` <a class="gantt-up" href="#gantt-${band.parentNumber}">&uarr; inside call ${band.parentNumber}</a>` : '') +
          '</div>'
      );
      parts.push(
        `<div class="gantt-sub">${escapeHtml(waterfallFormatMs(band.spanMs))} total` +
          (band.downstreamMs != null
            ? ` &middot; ${escapeHtml(waterfallFormatMs(band.downstreamMs))} waiting on the calls below`
            : '') +
          '</div>'
      );

      // The parent's own span, so children read as sub-tasks inside it rather than as free-floating
      // bars whose track the reader has to infer.
      const lead = band.ownLeadFraction * 100;
      const wait = band.waitFraction * 100;
      const tail = band.ownTailFraction * 100;
      parts.push(
        `<div class="gantt-row gantt-parent">` +
          `<span class="gantt-label">${escapeHtml(`${band.number}. ${band.label}`)}</span>` +
          `<span class="gantt-track">` +
          `<span class="gantt-bar gantt-bar-own" title="own work" style="left:0;width:${lead.toFixed(2)}%"></span>` +
          `<span class="gantt-bar gantt-bar-wait" title="waiting on the calls below" style="left:${lead.toFixed(2)}%;width:${wait.toFixed(2)}%"></span>` +
          `<span class="gantt-bar gantt-bar-own" title="own work" style="left:${(lead + wait).toFixed(2)}%;width:${tail.toFixed(2)}%"></span>` +
          `</span>` +
          `<span class="gantt-dur">${escapeHtml(waterfallFormatMs(band.spanMs))}</span>` +
          `<span class="gantt-status"></span>` +
          `</div>`
      );

      for (const row of band.rows) {
        const bad = row.error || row.inProgress || (row.status != null && row.status >= 400);
        const tone = bad ? ' gantt-bar-bad' : row.direction === 'outbound' ? ' gantt-bar-out' : ' gantt-bar-in';
        const title = `starts ${waterfallFormatMs((row.startFraction * (band.spanMs ?? 0)) || 0)} into call ${band.number}`;
        // A child that caused calls of its own is a link down to its own chart.
        const rowLabel = escapeHtml(`${row.number}. ${row.label}`);
        const labelHtml = row.hasOwnChart
          ? `<a class="gantt-down" href="#gantt-${row.number}">${rowLabel} &darr;</a>`
          : rowLabel;
        parts.push(
          `<div class="gantt-row">` +
            `<span class="gantt-label">${labelHtml}</span>` +
            `<span class="gantt-track"><span class="gantt-bar${tone}" title="${escapeHtml(title)}" style="left:${(row.startFraction * 100).toFixed(2)}%;width:${(row.widthFraction * 100).toFixed(2)}%"></span></span>` +
            `<span class="gantt-dur">${escapeHtml(waterfallFormatMs(row.durationMs))}</span>` +
            `<span class="gantt-status${bad ? ' gantt-bad' : ''}">${escapeHtml(waterfallStatusText(row))}</span>` +
            `</div>`
        );
      }

      if (ticks.length === 5) {
        parts.push(
          `<div class="gantt-row gantt-axis"><span class="gantt-label"></span><span class="gantt-track">` +
            ticks.map((t, i) => `<span class="gantt-tick" style="left:${i * 25}%">${escapeHtml(t)}</span>`).join('') +
            `</span><span class="gantt-dur"></span><span class="gantt-status"></span></div>`
        );
      }
      parts.push(
        `<div class="gantt-legend">Row ${band.number} is the parent: solid where it was doing its own work, hollow where it was only waiting on the calls below it.</div>`
      );
      parts.push('</div>');
    }
  }

  if (narrative.caveats.length > 0) {
    parts.push('<div class="about-caveats"><b>⚠️ Caveats for this capture.</b><ul>');
    for (const caveat of narrative.caveats) parts.push(`<li>${escapeHtml(caveat)}</li>`);
    parts.push('</ul></div>');
  }

  if (narrative.timingRows.length > 0) {
    parts.push('<p><b>Where the time went.</b></p>');
    parts.push(
      '<table class="metadata about-timing"><tr><td>#</td><td>Call</td><td>Total</td><td>Waiting on downstream</td><td>Own work</td></tr>'
    );
    for (const row of narrative.timingRows) {
      const downstream = row.downstreamMs != null ? formatMs(row.downstreamMs) : '<em>— leaf</em>';
      const own = row.selfMs != null ? `<b>${formatMs(row.selfMs)}</b>` : formatMs(row.durationMs);
      parts.push(
        `<tr><td>${row.number}</td><td>${escapeHtml(row.label)}</td><td>${formatMs(row.durationMs)}</td><td>${downstream}</td><td>${own}</td></tr>`
      );
    }
    parts.push('</table>');
    if (narrative.timingNote) parts.push(`<p class="about-note">${escapeHtml(narrative.timingNote)}</p>`);
  } else if (narrative.timingNote) {
    parts.push(`<p><b>Where the time went.</b> ${escapeHtml(narrative.timingNote)}</p>`);
  }

  if (narrative.orderingNote) {
    parts.push(`<p><b>How the list below is ordered.</b> ${escapeHtml(narrative.orderingNote)}</p>`);
  }

  parts.push(`<p><b>Flagged lines (comments).</b> ${escapeHtml(narrative.commentsNote)}</p>`);
  parts.push('</section>');

  return parts.join('');
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

/** Pretty-prints if the text is valid JSON or XML, otherwise the raw text verbatim - same never-truncate rule every other export format follows. */
function prettyText(text: string | undefined): string {
  if (!text) return '(empty)';
  return detectAndFormatBody(text).body;
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
  // Stated up front because a block is no longer rendered until it is opened, and some are very
  // large indeed (a measured 110,152-line response body) - worth knowing before you open one.
  const lineCount = config.text === '' ? 0 : config.text.split('\n').length;
  const meta = `<span class="json-block-meta">${lineCount.toLocaleString('en-US')} line${lineCount === 1 ? '' : 's'}</span>`;
  return `<details class="json-block" data-block-id="${config.id}"${open ? ' open' : ''}><summary>${escapeHtml(label)}${meta}</summary></details>`;
}

const STYLE = `
/* Slate, matching styles.scss's [data-theme="slate"] value for value. The translucent surfaces are
   spelled out as solids here because the export has no theme layer to composite them against - a
   reader opening this file gets one fixed palette, so each rgba() is pre-flattened over --bg rather
   than left to resolve differently depending on what it happens to sit on. */
:root {
  --bg: #141416; --card: #1b1b1d; --card-inner: #0e0e10;
  --border: rgba(255, 255, 255, 0.09); --border-strong: rgba(255, 255, 255, 0.18);
  --purple: #5b8def; --purple-light: #8fb2f7; --cyan: #7ee3d8; --text: #f2f2f5; --text-dim: #8b8b93; --text-faint: #5b5b63;
  --green: #7ee3a0; --amber: #e3a24a; --red: #e36a6a;
  --tok-key: #8fb2f7; --tok-string: #7ee3a0; --tok-number: #e3a24a; --tok-bool: #e37ec4; --tok-null: #6b6b73;
}
* { box-sizing: border-box; }
/* Without this a browser paints every link its own #0000EE, and the visited ones #551A8B - which on
   a dark slate page is a row of glaring blue and muddy purple, and is exactly what the summary
   table's "#" column looked like. :visited is set explicitly for the same reason: leaving it to the
   default means a link changes colour the second time someone opens the same report. */
a { color: var(--purple-light); text-decoration: none; border-bottom: 1px solid transparent; }
a:visited { color: var(--purple-light); }
a:hover { border-bottom-color: var(--border-strong); }
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
.status-neutral { color: var(--text-dim); font-weight: 600; }
.flagged { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 10px; padding: 1.1rem 1.25rem; margin: 1rem 0 1.5rem; }
.flagged h3 { margin: 0 0 0.7rem; font-size: 0.92rem; color: var(--amber); }
.flagged .note { font-size: 0.85rem; margin: 0.7rem 0; }
.flagged .note code { background: rgba(255,255,255,0.06); padding: 0.1rem 0.35rem; border-radius: 4px; }
.flagged .note blockquote { margin: 0.35rem 0 0; padding-left: 0.75rem; border-left: 2px solid var(--amber); color: var(--text-dim); }
.about { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 0.25rem 1.25rem 1rem; margin-bottom: 1.5rem; font-size: 0.9rem; }
.about h2 { margin-top: 1.1rem; }
.about p { color: var(--text-dim); }
.about p b { color: var(--text); }
.about-tree { background: var(--card-inner); border-radius: 8px; padding: 0.85rem 1rem; overflow-x: auto; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12.5px; line-height: 1.65; color: var(--text); }
.gantt { background: var(--card-inner); border-radius: 10px; padding: 0.8rem 1rem 0.6rem; margin-bottom: 0.7rem; border: 1px solid var(--border); }
/* The rail ties a nested chart back to the row it expands, so the two are read as one thing. */
.gantt-nested { position: relative; }
.gantt-nested::before { content: ""; position: absolute; left: -12px; top: -0.7rem; bottom: 0; width: 1px; background: var(--border-strong); }
.gantt-nested::after { content: ""; position: absolute; left: -12px; top: 1.05rem; width: 10px; height: 1px; background: var(--border-strong); }
.gantt-up { color: var(--text-faint); text-decoration: none; font-size: 10.5px; margin-left: 0.4rem; }
.gantt-up:hover, .gantt-down:hover { color: var(--purple-light); }
.gantt-down { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--border-strong); }
.gantt-title { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; color: var(--purple-light); }
.gantt-sub { font-size: 11px; color: var(--text-faint); margin-bottom: 0.55rem; }
.gantt-row { display: flex; align-items: center; gap: 10px; height: 20px; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; }
.gantt-label { flex: 0 0 42%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); }
.gantt-parent .gantt-label { color: var(--text); }
.gantt-legend { font-size: 10px; color: var(--text-faint); margin-top: 0.3rem; }
/* Gridlines at the same 25% steps as the axis ticks, so a bar's start can be read off the chart. */
.gantt-track { position: relative; flex: 1 1 auto; min-width: 0; height: 14px; border-left: 1px solid var(--border); border-right: 1px solid var(--border);
  background-image: repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), var(--border) calc(25% - 1px) 25%); }
.gantt-bar { position: absolute; top: 3px; height: 8px; border-radius: 3px; background: var(--purple); }
.gantt-bar-in { background: var(--purple); }
.gantt-bar-out { background: var(--cyan); }
.gantt-bar-bad { background: var(--red); }
/* The parent's row, split so you can see WHERE its children sit on it. Own work is drawn solid and
   waiting is drawn hollow, rather than the other way round: the parent's own time is the part you
   can do something about, and a parent that is almost entirely hollow is saying at a glance that it
   did nothing itself but wait. */
.gantt-bar-own { background: var(--purple); height: 10px; top: 2px; }
.gantt-bar-wait { height: 10px; top: 2px; border-radius: 0; background: transparent;
  background-image: repeating-linear-gradient(45deg, var(--border) 0 2px, transparent 2px 5px);
  border: 1px solid var(--border-strong); }
.gantt-dur { flex: 0 0 5.8rem; text-align: right; color: var(--text-dim); }
.gantt-status { flex: 0 0 2.2rem; text-align: right; color: var(--green); }
.gantt-status.gantt-bad { color: var(--red); }
.gantt-axis { height: 16px; }
.gantt-axis .gantt-track { height: 16px; border: none; background: none; }
.gantt-tick { position: absolute; top: 0; font-size: 9.5px; color: var(--text-faint); transform: translateX(-50%); white-space: nowrap; }
.gantt-tick:first-child { transform: none; }
.gantt-tick:last-child { transform: translateX(-100%); }
.about-caveats { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.35); border-radius: 8px; padding: 0.8rem 1rem; margin: 0.9rem 0; }
.about-caveats ul { margin: 0.5rem 0 0; padding-left: 1.1rem; color: var(--text-dim); }
.about-caveats li { margin-bottom: 0.3rem; }
.about-timing { margin-bottom: 0.75rem; }
.about-timing td:first-child { width: 3rem; }
.about-note { font-size: 0.82rem; color: var(--text-faint) !important; }
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
.json-block-meta { float: right; font-weight: 400; color: var(--text-faint); font-size: 0.78rem; }
.json-toolbar { display: flex; gap: 6px; align-items: center; padding: 0 0.9rem 0.6rem; }
.json-toolbar input[type="text"] { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 5px 8px; border-radius: 6px; font-size: 12px; outline: none; }
.json-toolbar input[type="text"]:focus { border-color: var(--border-strong); }
.json-match-count { font-size: 11px; color: var(--text-faint); white-space: nowrap; min-width: 3em; text-align: right; }
.json-toolbar button { background: rgba(139, 92, 246, 0.12); border: 1px solid var(--border); color: var(--purple-light); font-size: 12px; padding: 3px 9px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
.json-toolbar button:hover { border-color: var(--border-strong); background: rgba(139, 92, 246, 0.22); }
.json-toolbar .copy-btn { background: rgba(139, 92, 246, 0.18); border-color: var(--border-strong); }
.json-lines { background: var(--card-inner); margin: 0 0.9rem 0.9rem; border-radius: 8px; padding: 8px 4px; font-family: "SFMono-Regular", Consolas, monospace; font-size: 12.5px; line-height: 1.7; overflow-x: auto; }
/* Only a block past VIRTUAL_MIN_LINES becomes its own scroller. Bounding the height is what gives the render window a viewport to measure against, and it also stops a six-figure-line body from burying the rest of the document. */
.json-lines-virtual { max-height: 60vh; overflow-y: auto; }
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
/* Above this many lines a block switches from "render the whole thing" to a real render window:
   a fixed-height scroller that only ever materialises the rows actually on screen. Below it, a block
   renders in full exactly as it always did, so a normal header or a small body looks and behaves
   unchanged - windowing only turns on where it is needed. */
var VIRTUAL_MIN_LINES = 400;
var OVERSCAN = 20;

function buildBlock(block, config) {
  var lines = config.text.split('\\n');
  var matches = [], active = 0, query = '';
  var start = 0, end = 0;
  var virtual = lines.length > VIRTUAL_MIN_LINES;
  var lineH = 0;

  /* Every .json-line is exactly one row tall - .json-line-content is white-space:pre and the
     container scrolls horizontally, so nothing ever wraps. That uniformity is what makes the window
     arithmetic below exact rather than an estimate. A flagged line is the one exception: it also
     renders a comment card of unpredictable height, so those are measured after paint and folded
     into the offsets (see measureCards). Flagged lines are rare, which is why a plain loop over them
     is cheaper than a full prefix-sum table. */
  var commentLines = [];
  for (var key in config.comments) {
    if (Object.prototype.hasOwnProperty.call(config.comments, key)) commentLines.push(parseInt(key, 10));
  }
  commentLines.sort(function (a, b) { return a - b; });
  var cardH = {};
  for (var ci = 0; ci < commentLines.length; ci++) cardH[commentLines[ci]] = 34;

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
  linesEl.className = 'json-lines' + (virtual ? ' json-lines-virtual' : '');
  var rowsEl = document.createElement('div');
  rowsEl.className = 'json-rows';
  linesEl.appendChild(rowsEl);
  block.appendChild(linesEl);

  var searchEl = toolbar.querySelector('.json-search');
  var countEl = toolbar.querySelector('.json-match-count');

  /* One HTML string per window, instead of createElement per line and per token. */
  function rowHtml(i) {
    var comment = config.comments[i];
    var html = '<div class="json-line' + (comment ? ' has-comment' : '') + '" data-line="' + i + '">' +
      '<span class="json-line-num">' + (i + 1) + '</span>' +
      '<span class="json-line-flag' + (comment ? '' : ' hidden') + '">+</span>' +
      '<span class="json-line-content">' + tokensToHtml(tokenizeLine(lines[i]), query) + '</span>' +
      '</div>';
    if (comment) html += '<div class="json-comment-card" data-card="' + i + '">' + escapeHtml(comment) + '</div>';
    return html;
  }
  function chunkHtml(from, to) {
    var out = [];
    for (var i = from; i < to; i++) out.push(rowHtml(i));
    return out.join('');
  }

  function extraBefore(i) {
    var sum = 0;
    for (var k = 0; k < commentLines.length && commentLines[k] < i; k++) sum += cardH[commentLines[k]];
    return sum;
  }
  function offsetOf(i) { return i * lineH + extraBefore(i); }
  function totalHeight() { return lines.length * lineH + extraBefore(lines.length); }
  function firstVisible(scrollTop) {
    var lo = 0, hi = lines.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (offsetOf(mid + 1) <= scrollTop) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /* A comment card's real height is only knowable once it is in the document. Correcting it here
     keeps the scrollbar honest instead of drifting by however far the estimate was off. */
  function measureCards() {
    var changed = false;
    var cards = rowsEl.querySelectorAll('[data-card]');
    for (var i = 0; i < cards.length; i++) {
      var idx = parseInt(cards[i].getAttribute('data-card'), 10);
      var h = cards[i].offsetHeight;
      if (h > 0 && h !== cardH[idx]) { cardH[idx] = h; changed = true; }
    }
    return changed;
  }
  function applyPadding() {
    rowsEl.style.paddingTop = offsetOf(start) + 'px';
    rowsEl.style.paddingBottom = Math.max(0, totalHeight() - offsetOf(end)) + 'px';
  }

  function renderWindow(force) {
    if (!virtual) {
      start = 0; end = lines.length;
      rowsEl.innerHTML = chunkHtml(0, lines.length);
      updateCount();
      return;
    }
    var viewport = linesEl.clientHeight || 400;
    var first = Math.max(0, firstVisible(linesEl.scrollTop) - OVERSCAN);
    var count = Math.ceil(viewport / lineH) + OVERSCAN * 2;
    var last = Math.min(lines.length, first + count);
    if (!force && first === start && last === end) return;
    start = first; end = last;
    rowsEl.innerHTML = chunkHtml(start, end);
    if (measureCards()) applyPadding(); else applyPadding();
    updateCount();
  }

  function updateCount() {
    countEl.textContent = query
      ? (matches.length ? (active + 1) + '/' + matches.length : '0/0')
      : (lines.length + ' lines');
  }

  /* Matching scans the raw strings, never the DOM, so the count is exact across the WHOLE body even
     though only a screenful of it is rendered. A case-insensitive RegExp rather than
     lines[i].toLowerCase().indexOf(q): the latter allocates a lowercased copy of every line on every
     search, which on a 110k-line body is 110k throwaway strings and most of the cost. */
  function recomputeMatches() {
    matches = [];
    if (!query) return;
    var re = new RegExp(query.replace(/[-.*+?^{}()|[\\]\\\\$]/g, '\\\\$&'), 'i');
    for (var i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) matches.push(i);
    }
  }
  function revealActive() {
    if (!matches.length) { renderWindow(true); return; }
    var line = matches[active];
    if (virtual) {
      linesEl.scrollTop = Math.max(0, offsetOf(line) - linesEl.clientHeight / 2);
      renderWindow(true);
    } else {
      renderWindow(true);
      var row = rowsEl.querySelector('[data-line="' + line + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    }
  }
  function runSearch() {
    query = searchEl.value;
    active = 0;
    recomputeMatches();
    revealActive();
    updateCount();
  }
  /* Debounced: a keystroke used to re-render the entire block synchronously - measured at 5.6s per
     character on a 110k-line body. */
  var searchTimer = null;
  searchEl.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 150);
  });
  toolbar.querySelector('.json-next').addEventListener('click', function () {
    if (matches.length) { active = (active + 1) % matches.length; revealActive(); updateCount(); }
  });
  toolbar.querySelector('.json-prev').addEventListener('click', function () {
    if (matches.length) { active = (active - 1 + matches.length) % matches.length; revealActive(); updateCount(); }
  });
  toolbar.querySelector('.json-copy').addEventListener('click', function (e) {
    // Always the COMPLETE block, never just the window on screen - an export never truncates.
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

  if (virtual) {
    // One real row, measured rather than derived from the stylesheet, so a browser's own rounding of
    // font-size x line-height cannot put the window slightly out of step with the scrollbar.
    rowsEl.innerHTML = '<div class="json-line" data-line="0"><span class="json-line-num">1</span>' +
      '<span class="json-line-flag hidden">+</span><span class="json-line-content">x</span></div>';
    lineH = rowsEl.firstChild.offsetHeight || 21;
    var ticking = false;
    linesEl.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { ticking = false; renderWindow(false); });
    });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { renderWindow(true); }).observe(linesEl);
    }
  }
  renderWindow(true);
}

/* Nothing inside a block is built until that block is actually opened.
   Every block sits in a <details>, and they start CLOSED - yet this used to render all of them at
   load, so a file spent its entire opening cost on content nobody could see. Measured on a real
   6.6MB 8-call export: 1,300,952 DOM elements and 170,608 rendered lines before the first paint,
   3.6s to open and 5.6s per keystroke in the search box. */
function initJsonBlock(config) {
  var block = document.querySelector('[data-block-id="' + config.id + '"]');
  if (!block) return;
  var built = false;
  function build() {
    if (built) return;
    built = true;
    buildBlock(block, config);
  }
  block.addEventListener('toggle', function () { if (block.open) build(); });
  if (!block.open) return;
  // A block that ships open still waits until it is scrolled to, so a long document does not pay for
  // every one of them up front either.
  if (typeof IntersectionObserver === 'function') {
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) { io.disconnect(); build(); return; }
      }
    }, { rootMargin: '200px' });
    io.observe(block);
  } else {
    build();
  }
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

function statusHtml(call: CallRecord): string {
  if (call.error) return `<span class="status-err">⚠️ ${escapeHtml(call.error)}</span>`;
  if (!call.response) return '<span class="status-err">?</span>';
  return call.response.status < 400
    ? `<span class="status-ok">${call.response.status}</span>`
    : `<span class="status-err">${call.response.status}</span>`;
}

/** The Request half of callSectionHtml, factored out so it can be rendered alone as a split internal call's request block (see requestSectionHtml/responseSectionHtml/callSectionHtml). */
function requestPartHtml(call: CallRecord, comments: readonly Comment[], idPrefix: string, includeTimestampAndDuration: boolean): { html: string; blocks: JsonBlockConfig[] } {
  const reqHeaders = jsonBlockConfig(`${idPrefix}-req-headers`, JSON.stringify(call.request?.headers ?? {}), commentsForBlock(comments, 'request-headers'));
  const reqBody = jsonBlockConfig(`${idPrefix}-req-body`, call.request?.body, commentsForBlock(comments, 'request-body'));

  const parts: string[] = [];
  parts.push('<h2>📤 Request</h2>');
  parts.push('<ul class="field-list">');
  parts.push(`<li><b>Method:</b> ${escapeHtml(call.method)}</li>`);
  parts.push(`<li><b>URL:</b> ${escapeHtml(call.url)}</li>`);
  if (includeTimestampAndDuration) {
    parts.push(`<li><b>Timestamp:</b> ${escapeHtml(call.timestamp)}</li>`);
    if (call.duration_ms != null) parts.push(`<li><b>Duration:</b> ${formatMs(call.duration_ms)}</li>`);
  }
  parts.push('</ul>');
  parts.push(jsonBlockHtml(reqHeaders, 'Headers', false));
  parts.push(jsonBlockHtml(reqBody, 'Body', false));

  return { html: parts.join(''), blocks: [reqHeaders, reqBody] };
}

/** The Response half of callSectionHtml, factored out so it can be rendered alone as a split internal call's response block (see requestSectionHtml/responseSectionHtml/callSectionHtml). */
function responsePartHtml(call: CallRecord, comments: readonly Comment[], idPrefix: string, leadingHr: boolean, receivedAt?: string): { html: string; blocks: JsonBlockConfig[] } {
  const resHeaders = jsonBlockConfig(`${idPrefix}-res-headers`, JSON.stringify(call.response?.headers ?? {}), commentsForBlock(comments, 'response-headers'));
  const resBody = jsonBlockConfig(`${idPrefix}-res-body`, call.response?.body, commentsForBlock(comments, 'response-body'));

  const parts: string[] = [];
  if (leadingHr) parts.push('<hr />');
  parts.push('<h2>📥 Response</h2>');
  if (call.error) {
    const suffix = call.response ? '' : ' No response was received for this call.';
    parts.push(`<p>⚠️ <b>Error:</b> ${escapeHtml(call.error)}${suffix}</p>`);
  }
  if (call.response || receivedAt) {
    parts.push('<ul class="field-list">');
    if (call.response) parts.push(`<li><b>Status:</b> ${statusHtml(call)}</li>`);
    if (receivedAt) parts.push(`<li><b>Received:</b> ${escapeHtml(receivedAt)}</li>`);
    if (call.duration_ms != null) parts.push(`<li><b>Duration:</b> ${formatMs(call.duration_ms)}</li>`);
    parts.push('</ul>');
  }
  if (call.response) {
    parts.push(jsonBlockHtml(resHeaders, 'Headers', false));
    parts.push(jsonBlockHtml(resBody, 'Body', false));
  }

  return { html: parts.join(''), blocks: [resHeaders, resBody] };
}

function callSectionHtml(call: CallRecord, comments: readonly Comment[], idPrefix: string): { html: string; blocks: JsonBlockConfig[] } {
  const req = requestPartHtml(call, comments, idPrefix, true);
  const res = responsePartHtml(call, comments, idPrefix, true);
  return { html: req.html + res.html, blocks: [...req.blocks, ...res.blocks] };
}

/** Renders just the request half of a split internal call - see buildBulkExportHtml. */
function requestSectionHtml(call: CallRecord, comments: readonly Comment[], idPrefix: string): { html: string; blocks: JsonBlockConfig[] } {
  return requestPartHtml(call, comments, idPrefix, true);
}

/** Renders just the response half of a split internal call - see buildBulkExportHtml. */
function responseSectionHtml(call: CallRecord, comments: readonly Comment[], idPrefix: string, receivedAt: string): { html: string; blocks: JsonBlockConfig[] } {
  return responsePartHtml(call, comments, idPrefix, false, receivedAt);
}

/** `overlapCandidates` serves the About section only - see buildExportMarkdown's doc for why a
 * single-call export takes it. */
export function buildExportHtml(
  call: CallRecord,
  form: ExportFormData,
  comments: readonly Comment[] = [],
  overlapCandidates: readonly CallOverlapCandidate[] = []
): string {
  const { html: sectionHtml, blocks } = callSectionHtml(call, comments, 'call');
  const narrative = buildExportNarrative({
    calls: [call],
    commentsByCallId: new Map([[call.id, comments]]),
    overlapCandidates,
  });

  const body = [
    '<h1>📄 API Call Export</h1>',
    `<div class="exported-line">Exported from Alfred/Frontend</div>`,
    aboutSectionHtml(narrative),
    '<h2>🧾 Metadata</h2>',
    metadataTableHtml(form),
    flaggedIssuesHtml(comments),
    sectionHtml,
    '<hr />',
    '<footer>Exported from Alfred/Frontend</footer>',
  ].join('');

  return documentShell('API Call Export', body, blocks);
}

/**
 * One rendered block in the bulk HTML report - mirrors markdown-builder's RenderBlock. A whole call
 * ('full', always used for external calls) or one half of a split internal call
 * ('request'/'response').
 */
interface RenderBlock {
  readonly call: CallRecord;
  readonly n: number;
  readonly variant: 'request' | 'response' | 'full';
  readonly sortTime: number;
}

/**
 * Same 3-check containment + ownership + ambiguity-veto algorithm as call-utils.ts's
 * qualifiesAsEvidence/computeSplitCallIds - re-implemented here per this codebase's
 * mirror-per-consumer convention (see markdown-builder.ts's identical copy).
 */
function targetWindow(target: CallRecord): { start: number; end: number } {
  const start = new Date(target.timestamp).getTime();
  return { start, end: start + (target.duration_ms ?? 0) };
}

/** Whether `inner` sits STRICTLY inside `outer` - one-directionally. Two calls with identical
 * windows contain each other, and that's ambiguity rather than nesting: there's no telling which of
 * them a call inside both belongs to, so neither may claim it. Mirrors call-tree.ts's resolveParent,
 * so the split and the tree views can never disagree about whose downstream work a call was. */
function strictlyContainsCall(outer: CallRecord, inner: CallRecord): boolean {
  if (outer.id === inner.id) return false;
  const o = targetWindow(outer);
  const i = targetWindow(inner);
  const innerFitsInOuter = i.start >= o.start && i.end <= o.end;
  const outerFitsInInner = o.start >= i.start && o.end <= i.end;
  return innerFitsInOuter && !outerFitsInInner;
}

function candidateWindow(candidate: CallOverlapCandidate): { start: number; end: number } {
  const start = new Date(candidate.timestamp).getTime();
  return { start, end: start + candidate.durationMs };
}

/** Check 1 of 4: strict containment - see call-utils.ts's isStrictlyContained. */
function isStrictlyContained(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  if (candidate.id === target.id) return false;
  const t = targetWindow(target);
  const c = candidateWindow(candidate);
  return c.start >= t.start && c.end <= t.end;
}

/** Check 2 of 4: ownership/attribution - see call-utils.ts's passesOwnershipCheck. */
function passesOwnershipCheck(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  const targetServiceName = target.service_name ?? null;
  if (candidate.source === 'internal') {
    return candidate.serviceName !== targetServiceName;
  }
  if (candidate.serviceName == null) return true;
  return candidate.serviceName === targetServiceName;
}

/** Checks 1-2 combined - see call-utils.ts's qualifiesAsNestedChild. */
function qualifiesAsNestedChild(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  return isStrictlyContained(target, candidate) && passesOwnershipCheck(target, candidate);
}

/** Mirrors call-utils.ts's candidateMatchesStatusFilter - see its doc. */
function candidateMatchesStatusFilter(candidate: CallOverlapCandidate, filter: CallStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'inProgress':
      return false;
    case 'ok':
      return candidate.status != null && candidate.status < 400;
    case 'client':
      return candidate.status != null && candidate.status >= 400 && candidate.status < 500;
    case 'failed':
      return candidate.error != null || (candidate.status != null && candidate.status >= 500);
  }
}

/** Mirrors call-utils.ts's computeSplitCallIds - see its doc for the exact two-pass mechanics. */
function computeSplitCallIds(
  internalCalls: readonly CallRecord[],
  candidates: readonly CallOverlapCandidate[],
  statusFilter: CallStatusFilter
): ReadonlySet<string> {
  const visibleCandidates = candidates.filter((candidate) => candidateMatchesStatusFilter(candidate, statusFilter));

  const survivorsByCallId = new Map<string, CallOverlapCandidate[]>(internalCalls.map((call) => [call.id, []]));

  for (const candidate of visibleCandidates) {
    const owners = internalCalls.filter((call) => qualifiesAsNestedChild(call, candidate));
    if (owners.length === 0) continue;

    // The INNERMOST owner takes it, provided the owners form a single nested chain - odeysys
    // containing core-service containing this call isn't ambiguous at all, it just means
    // core-service is whose work it was. Only owners that merely OVERLAP, neither inside the other,
    // are genuinely ambiguous, and those give it up entirely rather than guess.
    const innermost = owners.reduce((best, owner) => ((owner.duration_ms ?? 0) < (best.duration_ms ?? 0) ? owner : best));
    const nestedChain = owners.every((owner) => owner.id === innermost.id || strictlyContainsCall(owner, innermost));
    if (!nestedChain) continue;

    survivorsByCallId.get(innermost.id)!.push(candidate);
  }

  const staysSplit = new Set<string>();
  for (const [callId, survivors] of survivorsByCallId) {
    if (survivors.length > 0) staysSplit.add(callId);
  }
  return staysSplit;
}

/** An internal call is eligible to be split at all only once it's resolved (has a response or
 * error, never while still in-progress) - see buildRenderBlocks. */
function isResolvedInternalCall(call: CallRecord): boolean {
  return call.source === 'internal' && (call.response !== undefined || call.error !== undefined) && !isInProgress(call);
}

/**
 * Same interleaving logic as markdown-builder.ts's buildRenderBlocks - a response block sorts at
 * its call's timestamp plus duration, so it can land after another call's later-starting request
 * block. Splitting is computed up front across every resolved internal call in `sortedCalls` at
 * once (see computeSplitCallIds - the ambiguity veto needs the whole picture first).
 */
function buildRenderBlocks(
  sortedCalls: readonly CallRecord[],
  overlapCandidates: readonly CallOverlapCandidate[],
  statusFilter: CallStatusFilter
): { blocks: RenderBlock[]; staysSplitIds: ReadonlySet<string> } {
  const resolvedInternalCalls = sortedCalls.filter(isResolvedInternalCall);
  const staysSplitIds = computeSplitCallIds(resolvedInternalCalls, overlapCandidates, statusFilter);

  const blocks: RenderBlock[] = [];
  sortedCalls.forEach((call, i) => {
    const n = i + 1;
    const baseTime = new Date(call.timestamp).getTime();
    if (isResolvedInternalCall(call) && staysSplitIds.has(call.id)) {
      blocks.push({ call, n, variant: 'request', sortTime: baseTime });
      blocks.push({ call, n, variant: 'response', sortTime: baseTime + (call.duration_ms ?? 0) });
    } else {
      blocks.push({ call, n, variant: 'full', sortTime: baseTime });
    }
  });
  blocks.sort((a, b) => a.sortTime - b.sortTime);
  return { blocks, staysSplitIds };
}

function blockAnchorId(block: RenderBlock): string {
  return block.variant === 'response' ? `call-${block.n}-response` : `call-${block.n}`;
}

function blockSuffixHtml(block: RenderBlock): string {
  return block.variant === 'full' ? '' : ` &middot; ${block.variant}`;
}

/**
 * A request block only ever exists for a call that has ALREADY resolved (see isSplitInternalCall -
 * a still-in-progress call stays a single 'full' block, never 'request'), so this must never say
 * "pending" - it settles to a plain "sent" marker exactly like the live list's request row does
 * once its paired response arrives, and the real outcome shows on the response block instead.
 */
function blockStatusHtml(block: RenderBlock): string {
  return block.variant === 'request' ? '<span class="status-neutral">sent</span>' : statusHtml(block.call);
}

/** Same request-only/response-only comment scoping as markdown-builder.ts's commentsForVariant. */
function commentsForVariant(comments: readonly Comment[], variant: RenderBlock['variant']): Comment[] {
  if (variant === 'request') return comments.filter((c) => c.block.startsWith('request'));
  if (variant === 'response') return comments.filter((c) => c.block.startsWith('response'));
  return [...comments];
}

export function buildBulkExportHtml(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  exportedAt: string,
  overlapCandidates: readonly CallOverlapCandidate[] = [],
  statusFilter: CallStatusFilter = 'all',
  cycle: ExportedCycle | null = null,
  spacers: readonly ExportedSpacer[] = []
): string {
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;
  const failed = calls.length - succeeded;
  const totalDurationMs = calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0);
  const totalFlagged = [...commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0);
  const callWord = calls.length === 1 ? 'Call' : 'Calls';

  // Same forced-chronological reasoning as markdown-builder.ts: the split only reads sensibly in
  // real time order, regardless of whatever order the caller passed in.
  const sortedCalls = [...calls].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const { blocks, staysSplitIds } = buildRenderBlocks(sortedCalls, overlapCandidates, statusFilter);
  const narrative = buildExportNarrative({ calls, commentsByCallId, splitCallIds: staysSplitIds, cycle });
  const depthsByCallId = depthByCallId(narrative.topology);

  const allBlocks: JsonBlockConfig[] = [];
  const summaryRows: string[] = [];
  const callSections: string[] = [];

  const spacersBeforeCallId = new Map<string, ExportedSpacer[]>();
  const trailingSpacers: ExportedSpacer[] = [];
  for (const spacer of spacers) {
    if (spacer.beforeCallId == null) {
      trailingSpacers.push(spacer);
    } else {
      const list = spacersBeforeCallId.get(spacer.beforeCallId);
      if (list) list.push(spacer);
      else spacersBeforeCallId.set(spacer.beforeCallId, [spacer]);
    }
  }
  const spacerHtml = (spacer: ExportedSpacer) => `<h3 class="spacer-heading">🏷️ ${escapeHtml(spacer.label)}</h3>`;

  blocks.forEach((block) => {
    const { call } = block;
    const allComments = commentsByCallId.get(call.id) ?? [];
    const comments = commentsForVariant(allComments, block.variant);
    for (const spacer of spacersBeforeCallId.get(call.id) ?? []) {
      callSections.push(spacerHtml(spacer));
    }
    const flaggedCount = comments.length;
    const duration = block.variant !== 'request' && call.duration_ms != null ? formatMs(call.duration_ms) : '—';
    const anchor = blockAnchorId(block);
    summaryRows.push(
      `<tr><td><a href="#${anchor}">${block.n}${blockSuffixHtml(block)}</a></td><td>${escapeHtml(call.method)}</td><td>${escapeHtml(
        call.url
      )}</td><td>${blockStatusHtml(block)}</td><td>${duration}</td><td>${flaggedCount > 0 ? `🚩 ${flaggedCount}` : '—'}</td></tr>`
    );

    let sectionHtml: string;
    let sectionBlocks: JsonBlockConfig[];
    if (block.variant === 'request') {
      const result = requestSectionHtml(call, allComments, anchor);
      sectionHtml = result.html;
      sectionBlocks = result.blocks;
    } else if (block.variant === 'response') {
      const receivedAt = new Date(new Date(call.timestamp).getTime() + (call.duration_ms ?? 0)).toISOString();
      const result = responseSectionHtml(call, allComments, anchor, receivedAt);
      sectionHtml = result.html;
      sectionBlocks = result.blocks;
    } else {
      const result = callSectionHtml(call, allComments, anchor);
      sectionHtml = result.html;
      sectionBlocks = result.blocks;
    }
    allBlocks.push(...sectionBlocks);

    // Indented to match the topology, so the Calls list reads as the tree it already is: a split
    // parent's request and response sit at one level with everything it caused nested between them.
    // The rail makes the relationship readable when a parent's two halves are screens apart.
    const depth = depthsByCallId.get(call.id) ?? 0;
    const nestAttrs = depth > 0 ? ` class="json-block call-nested" style="margin-left:${depth * 26}px"` : ' class="json-block"';

    callSections.push(
      `<a id="${anchor}"></a><details${nestAttrs}><summary class="call-summary"><b>Call ${block.n}</b>${blockSuffixHtml(
        block
      )} &nbsp; <code>${escapeHtml(call.method)} ${escapeHtml(uriPath(call.url))}</code> &nbsp; ${blockStatusHtml(
        block
      )}</summary><div class="call-summary-body">${flaggedIssuesHtml(comments)}${sectionHtml}</div></details>`
    );
  });

  const body = [
    `<h1>📋 API Calls Export — ${calls.length} ${callWord}</h1>`,
    `<div class="exported-line">Exported: ${escapeHtml(exportedAt)} &nbsp;•&nbsp; Succeeded: ${succeeded} ✅ &nbsp;•&nbsp; Failed: ${failed} ❌ &nbsp;•&nbsp; Total duration: ${formatMs(totalDurationMs)}</div>`,
    aboutSectionHtml(narrative),
    '<h2>🧾 Metadata</h2>',
    metadataTableHtml(form),
    '<h2>📊 Summary</h2>',
    `<table class="metadata"><tr><td>#</td><td>Method</td><td>URL</td><td>Status</td><td>Duration</td><td>Flagged</td></tr>${summaryRows.join('')}</table>`,
    '<h2>🔗 Calls</h2>',
    callSections.join(''),
    ...trailingSpacers.map(spacerHtml),
    '<hr />',
    `<footer>Exported from Alfred/Frontend — ${calls.length} call${calls.length === 1 ? '' : 's'}, ${totalFlagged} flagged issue${totalFlagged === 1 ? '' : 's'} total</footer>`,
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
