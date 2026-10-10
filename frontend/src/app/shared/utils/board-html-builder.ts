import {
  ActivityEntry, CardDetail, FLAG_LABELS, MARK_LABELS, RESOLUTION_LABELS, SCOPE_LABELS, STATUS_LABELS, mentionTypeOf,
} from '../../core/models/board.models';
import { changeText, claudeParts } from './board-activity';
import { BoardExport } from './board-json';
import { escapeHtml } from './html-builder';

/**
 * The board as a standalone HTML page (FR-045, FR-047). Every value goes through escapeHtml - card text, comments and
 * spec files are untrusted, and a captured payload must never run in a reader's browser (constitution I). Text keeps
 * its line breaks (pre-wrap) rather than being rendered as Markdown, so nothing is dropped or reinterpreted.
 */
export function buildBoardHtmlParts(data: BoardExport, title: string): string[] {
  const parts: string[] = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#1d2340}',
    '.t{white-space:pre-wrap;word-break:break-word;background:#f5f6fb;border:1px solid #dde0ee;border-radius:6px;padding:.5rem .7rem}',
    'table{border-collapse:collapse}td{border:1px solid #dde0ee;padding:.25rem .5rem;vertical-align:top}.dim{color:#6b7394}',
    '.lbl{font-weight:700;font-size:.75rem;margin-right:.4rem}.card{border-top:2px solid #8b5cf6;margin-top:2rem;padding-top:.5rem}</style>',
    `</head><body><h1>${escapeHtml(title)}</h1>`,
    `<p class="dim">Project: ${escapeHtml(data.project || 'No project')} · ${data.cards.length} cards · exported ${escapeHtml(new Date().toISOString())}</p>`,
  ];
  for (const b of data.briefs) parts.push(`<h2>Cycle brief - ${escapeHtml(b.cycleId)}</h2><div class="t">${escapeHtml(b.text || '(no brief)')}</div>`);
  for (const s of data.specs) {
    parts.push(`<h2>Spec file - ${escapeHtml(s.name)} <span class="dim">(cycle ${escapeHtml(s.cycleId)})</span></h2><div class="t">${escapeHtml(s.content)}</div>`);
  }
  if (data.marks.length) {
    parts.push('<h2>Acceptance checklist marks</h2><table>');
    for (const m of data.marks) {
      parts.push(`<tr><td>${escapeHtml(m.fileName)}</td><td>${escapeHtml(m.itemKey)}</td><td>${escapeHtml(MARK_LABELS[m.mark])}</td>`
        + `<td class="t">${escapeHtml(m.evidence)}</td><td>${escapeHtml(m.updatedAt)}</td></tr>`);
    }
    parts.push('</table>');
  }
  for (const card of data.cards) parts.push(cardHtml(card, data.activity[card.id] ?? []));
  parts.push('</body></html>');
  return parts;
}

function row(label: string, value: string): string {
  return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`;
}

function cardHtml(c: CardDetail, history: readonly ActivityEntry[]): string {
  const out = [
    `<section class="card"><h2>#${c.number} ${escapeHtml(c.title)}</h2><table>`,
    row('Kind', c.kind),
    row('Status', `${STATUS_LABELS[c.status]}${c.resolution ? ` - ${RESOLUTION_LABELS[c.resolution]}` : ''}`),
    row('Reason', c.reason ?? ''),
    row('Flags', c.flags.map((f) => FLAG_LABELS[f]).join(', ') || 'none'),
    row('Scope', SCOPE_LABELS[c.scope]),
    row('Author', c.author === 'CLAUDE' ? 'Claude' : 'User'),
    row('Cycle', `${c.cycleId ?? ''}${c.cycleDeleted ? ' (deleted)' : ''}`),
    row('Created', c.createdAt),
    row('Updated', `${c.updatedAt} by ${c.updatedBy === 'CLAUDE' ? 'Claude' : 'User'}`),
    '</table><h3>Description</h3>',
    `<div class="t">${escapeHtml(c.description || '(no description)')}</div><h3>Linked</h3><ul>`,
    ...c.links.map((l) => `<li>${escapeHtml(mentionTypeOf(l))} <code>${escapeHtml(l.ref)}</code> - ${escapeHtml(l.label)}</li>`),
    '</ul><h3>Activity</h3><ul>',
  ];
  for (const e of history) {
    if (e.kind === 'COMMENT') {
      const parts = claudeParts(e.text);
      const body = parts ? parts.map((p) => `<div><span class="lbl">${escapeHtml(p.label)}</span>${escapeHtml(p.text)}</div>`).join('')
        : escapeHtml(e.text ?? '');
      out.push(`<li><b>${e.actor === 'CLAUDE' ? 'Claude' : 'User'}</b> <span class="dim">${escapeHtml(e.at)}</span><div class="t">${body}</div></li>`);
    } else {
      out.push(`<li>${escapeHtml(changeText(e))} <span class="dim">${escapeHtml(e.at)}</span></li>`);
    }
  }
  out.push('</ul></section>');
  return out.join('');
}
