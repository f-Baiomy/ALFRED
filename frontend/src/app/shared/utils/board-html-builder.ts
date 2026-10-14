import {
  ActivityEntry, CardDetail, FLAG_LABELS, MARK_LABELS, RESOLUTION_LABELS, SCOPE_LABELS, STATUS_LABELS, mentionTypeOf,
} from '../../core/models/board.models';
import { changeText, claudeParts } from './board-activity';
import { replyNote } from './board-threads';
import { BoardExport } from './board-json';
import { escapeHtml } from './html-builder';
import { blocksToHtml, htmlBlocks, isHtml } from './rich-html';
import { BoardVisuals, NO_VISUALS } from './board-visuals-export';
import { FrameKit, VISUALS_CSS, filesHtml, inlineHtml, pagesHtml, widgetsHtml } from './board-visuals-render';
import { briefParts } from './task-view';

/**
 * The board as a standalone HTML page (FR-045, FR-047). Every value goes through escapeHtml - card text, comments and
 * spec files are untrusted, and a captured payload must never run in a reader's browser (constitution I). Text keeps
 * its line breaks (pre-wrap) rather than being rendered as Markdown, so nothing is dropped or reinterpreted. A text
 * stored as rich text (HTML) is written as the board's own clean HTML - rebuilt from its blocks, never copied as it came.
 */
export function buildBoardHtmlParts(data: BoardExport, title: string, kit: FrameKit | null = null): string[] {
  const v = data.visuals ?? NO_VISUALS;
  const frames: FrameKit = kit ?? { origin: (globalThis as { BACKEND_URL?: string }).BACKEND_URL ?? '', libCode: {}, data: {} };
  const parts: string[] = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#1d2340}',
    '.t{white-space:pre-wrap;word-break:break-word;background:#f5f6fb;border:1px solid #dde0ee;border-radius:6px;padding:.5rem .7rem}',
    'table{border-collapse:collapse}td{border:1px solid #dde0ee;padding:.25rem .5rem;vertical-align:top}.dim{color:#6b7394}',
    '.lbl{font-weight:700;font-size:.75rem;margin-right:.4rem}.card{border-top:2px solid #8b5cf6;margin-top:2rem;padding-top:.5rem}',
    '.r{white-space:normal}.r aside{border-left:3px solid #8b5cf6;padding:.2rem .6rem;margin:.3rem 0}.r pre{background:#eef0f8;padding:.4rem;white-space:pre-wrap}',
    '.r mark{background:#fde68a}.r img{max-width:100%}.r td,.r th{border:1px solid #dde0ee;padding:.2rem .4rem}' + VISUALS_CSS + '</style>',
    `</head><body><h1>${escapeHtml(title)}</h1>`,
    `<p class="dim">Project: ${escapeHtml(data.project || 'No project')} · ${data.cards.length} cards · exported ${escapeHtml(new Date().toISOString())}</p>`,
  ];
  for (const b of data.briefs) {
    parts.push(`<h2>Cycle brief - ${escapeHtml(b.cycleId)}</h2>${textHtml(b.text, '(no brief)')}`);
    parts.push(briefVisuals(frames, v, b.cycleId, b.text), pagesHtml(frames, v, v.pages.filter((p) => p.owner === 'cycle' && p.cycleId === b.cycleId)),
      filesHtml(v, (f) => f.cardNumber == null && f.cycleId === b.cycleId));
  }
  for (const s of data.specs) {
    parts.push(`<h2>Spec file - ${escapeHtml(s.name)} <span class="dim">(cycle ${escapeHtml(s.cycleId)})</span></h2>${textHtml(s.content, '')}`);
  }
  if (data.marks.length) {
    parts.push('<h2>Acceptance checklist marks</h2><table>');
    for (const m of data.marks) {
      parts.push(`<tr><td>${escapeHtml(m.fileName)}</td><td>${escapeHtml(m.itemKey)}</td><td>${escapeHtml(MARK_LABELS[m.mark])}</td>`
        + `<td>${textHtml(m.evidence, '')}</td><td>${escapeHtml(m.updatedAt)}</td></tr>`);
    }
    parts.push('</table>');
  }
  for (const card of data.cards) parts.push(cardHtml(card, data.activity[card.id] ?? [], frames, v));
  const projectPages = v.pages.filter((p) => p.owner === 'project');
  if (projectPages.length) parts.push('<h2>Project pages</h2>', pagesHtml(frames, v, projectPages));
  parts.push(widgetsHtml(frames, v));
  parts.push('</body></html>');
  return parts;
}

function row(label: string, value: string): string {
  return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
}

/** The brief's snippets running, by the part of the brief each is in (as the brief view numbers them). */
function briefVisuals(kit: FrameKit, v: BoardVisuals, cycleId: string, text: string | null | undefined): string {
  const p = briefParts(text ?? '');
  const id = `inline:cycle:${cycleId}`;
  return inlineHtml(kit, v, p.goal, `${id}:goal`, 'Goal') + inlineHtml(kit, v, p.sections['description'], `${id}:desc`, 'Description')
    + p.other.map((o, i) => inlineHtml(kit, v, o.text, `${id}:o${i}`, o.title || 'Brief')).join('');
}

function cardHtml(c: CardDetail, history: readonly ActivityEntry[], kit: FrameKit, v: BoardVisuals): string {
  const out = [
    `<section class="card"><h2>#${c.number} ${escapeHtml(c.title)}</h2><table>`,
    row('Kind', c.kind),
    row('Status', `${STATUS_LABELS[c.status]}${c.resolution ? ` - ${RESOLUTION_LABELS[c.resolution]}` : ''}`),
    row('Reason', c.reason ?? ''),
    row('Flags', c.flags.map((f) => FLAG_LABELS[f]).join(', ') || 'none'),
    row('Teams', (c.teams ?? []).join(', ') || 'none'),
    row('Scope', SCOPE_LABELS[c.scope]),
    row('Author', c.author === 'CLAUDE' ? 'Claude' : 'User'),
    row('Cycle', `${c.cycleId ?? ''}${c.cycleDeleted ? ' (deleted)' : ''}`),
    row('Created', c.createdAt),
    row('Updated', `${c.updatedAt} by ${c.updatedBy === 'CLAUDE' ? 'Claude' : 'User'}`),
    '</table><h3>Description</h3>',
    `${textHtml(c.description, '(no description)')}${inlineHtml(kit, v, c.description, `inline:card:#${c.number}:desc`, 'Description')}`,
    pagesHtml(kit, v, v.pages.filter((p) => p.owner === 'card' && p.cardNumber === c.number)),
    filesHtml(v, (f) => f.cardNumber === c.number),
    '<h3>Linked</h3><ul>',
    ...c.links.map((l) => `<li>${escapeHtml(mentionTypeOf(l))} <code>${escapeHtml(l.ref)}</code> - ${escapeHtml(l.label)}</li>`),
    '</ul><h3>Activity</h3><ul>',
  ];
  for (const e of history) {
    if (e.kind === 'COMMENT') {
      const parts = claudeParts(e.text);
      const body = parts ? parts.map((p) => `<div><span class="lbl">${escapeHtml(p.label)}</span>${escapeHtml(p.text)}</div>`).join('')
        : null;
      const running = parts
        ? parts.map((p, i) => inlineHtml(kit, v, p.text, `inline:card:#${c.number}:${e.id}p${i}`, p.label)).join('')
        : inlineHtml(kit, v, e.text, `inline:card:#${c.number}:${e.id}`, 'Comment');
      out.push(`<li><b>${e.actor === 'CLAUDE' ? 'Claude' : 'User'}</b> <span class="dim">${escapeHtml(e.at + replyNote(e, history))}</span>`
        + `${body === null ? textHtml(e.text, '') : `<div class="t">${body}</div>`}${running}</li>`);
    } else {
      out.push(`<li>${escapeHtml(changeText(e))} <span class="dim">${escapeHtml(e.at)}</span></li>`);
    }
  }
  out.push('</ul></section>');
  return out.join('');
}

/** A text as the page shows it: Markdown kept as written (escaped, line breaks kept), rich text as clean HTML. */
function textHtml(text: string | null | undefined, empty: string): string {
  if (isHtml(text)) {
    // pictures load from the Alfred the page was exported from
    const origin = (globalThis as { BACKEND_URL?: string }).BACKEND_URL ?? '';
    return `<div class="t r">${blocksToHtml(htmlBlocks(text!)).replace(/ src="\/board\/images\//g, ` src="${origin}/board/images/`)}</div>`;
  }
  return `<div class="t">${escapeHtml(text || empty)}</div>`;
}
