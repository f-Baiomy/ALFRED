import {
  ActivityEntry, CardDetail, FLAG_LABELS, MARK_LABELS, RESOLUTION_LABELS, SCOPE_LABELS, STATUS_LABELS, mentionTypeOf,
} from '../../core/models/board.models';
import { changeText, claudeParts } from './board-activity';
import { BoardExport } from './board-json';

/**
 * The board as Markdown (FR-045, FR-047): every card with every field, its Linked list, its whole history and the
 * cycle briefs, spec files in full and checklist marks. Nothing is shortened. Mentions stay in their `@[type:ref|label]`
 * form inside text - readable as-is, and the reader can still see exactly what they point at.
 */
export function buildBoardMarkdownLines(data: BoardExport, title: string): string[] {
  const lines: string[] = [`# ${title}`, '', `Project: ${data.project || 'No project'} · ${data.cards.length} cards · exported ${new Date().toISOString()}`, ''];
  for (const b of data.briefs) {
    lines.push(`## Cycle brief - ${b.cycleId}`, '', b.text || '_No brief._', '');
  }
  for (const s of data.specs) {
    lines.push(`## Spec file - ${s.name} (cycle ${s.cycleId})`, '', '````', s.content, '````', '');
  }
  if (data.marks.length) {
    lines.push('## Acceptance checklist marks', '');
    for (const m of data.marks) lines.push(`- ${m.fileName} · ${m.itemKey.slice(0, 12)}… · ${MARK_LABELS[m.mark]} · ${m.evidence || 'no evidence'} · ${m.updatedAt}`);
    lines.push('');
  }
  for (const card of data.cards) lines.push(...cardLines(card, data.activity[card.id] ?? []));
  return lines;
}

function cardLines(c: CardDetail, history: readonly ActivityEntry[]): string[] {
  const lines = [
    `## #${c.number} ${c.title}`, '',
    `| Field | Value |`, `|---|---|`,
    `| Kind | ${c.kind} |`,
    `| Status | ${STATUS_LABELS[c.status]}${c.resolution ? ` - ${RESOLUTION_LABELS[c.resolution]}` : ''} |`,
    `| Reason | ${cell(c.reason ?? '')} |`,
    `| Flags | ${c.flags.map((f) => FLAG_LABELS[f]).join(', ') || 'none'} |`,
    `| Scope | ${SCOPE_LABELS[c.scope]} |`,
    `| Author | ${c.author === 'CLAUDE' ? 'Claude' : 'User'} |`,
    `| Cycle | ${c.cycleId ?? ''}${c.cycleDeleted ? ' (deleted)' : ''} |`,
    `| Created | ${c.createdAt} |`,
    `| Updated | ${c.updatedAt} by ${c.updatedBy === 'CLAUDE' ? 'Claude' : 'User'} |`,
    '', '### Description', '', c.description || '_No description._', '',
    '### Linked', '',
  ];
  if (c.links.length) for (const l of c.links) lines.push(`- ${mentionTypeOf(l)} \`${l.ref}\` - ${l.label}`);
  else lines.push('_Nothing linked._');
  lines.push('', '### Activity', '');
  for (const e of history) {
    if (e.kind === 'COMMENT') {
      lines.push(`- **${e.actor === 'CLAUDE' ? 'Claude' : 'User'}** · ${e.at}`);
      const parts = claudeParts(e.text);
      if (parts) for (const p of parts) lines.push(`  - **${p.label}** ${indent(p.text)}`);
      else lines.push(`  ${indent(e.text ?? '')}`);
    } else {
      lines.push(`- ${changeText(e)} · ${e.at}`);
    }
  }
  if (!history.length) lines.push('_No history._');
  lines.push('');
  return lines;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function indent(text: string): string {
  return text.replace(/\r?\n/g, '\n  ');
}
