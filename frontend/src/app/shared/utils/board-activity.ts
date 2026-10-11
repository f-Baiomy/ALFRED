import { ActivityEntry, CardStatus, RESOLUTION_LABELS, Resolution, SCOPE_LABELS, STATUS_LABELS, Scope } from '../../core/models/board.models';

/** A Claude comment's labelled parts (FR-029). */
export interface ClaudeParts {
  readonly label: string;
  readonly text: string;
}

const CLAUDE_HEADING = /^\*\*(Did|Found|Next|Impact|Reply|Question)\*\*\s*/;

/** Splits `**Did** … **Found** … **Next** … **Impact** …` into its parts; null for a free-text comment. */
export function claudeParts(text: string | null): ClaudeParts[] | null {
  if (!text || !CLAUDE_HEADING.test(text)) return null;
  return text.split(/\n\n(?=\*\*(?:Did|Found|Next|Impact|Reply|Question)\*\*)/).map((part) => {
    const m = CLAUDE_HEADING.exec(part);
    return { label: m ? m[1].toUpperCase() : '', text: m ? part.slice(m[0].length) : part };
  });
}

/** "VERIFIED" / "CLOSED:FINE" as words: "Verified", "close as Fine - not an issue". */
export function proposalTarget(value: string | null): string {
  if (!value) return '';
  const [status, resolution] = value.split(':');
  if (status === 'MERGE') return `merge into ${resolution}`;
  if (status === 'REOPEN') return 'reopen (regression)';
  if (status === 'CLOSED') return `close as ${resolution ? RESOLUTION_LABELS[resolution as Resolution] ?? resolution : 'closed'}`;
  return STATUS_LABELS[status as CardStatus] ?? status;
}

/** "You moved Inbox → In progress" - a recorded change in words. `teamName` turns a team id into its name. */
export function changeText(e: ActivityEntry, teamName: (id: string) => string = (id) => id): string {
  const who = e.actor === 'CLAUDE' ? 'Claude' : 'You';
  const status = (v: string | null) => (v ? STATUS_LABELS[v as CardStatus] ?? v : '');
  const scope = (v: string | null) => (v ? SCOPE_LABELS[v as Scope] ?? v : '');
  switch (e.kind) {
    case 'CREATED': return `${who} created the card`;
    case 'STATUS': return `${who} moved ${status(e.oldValue)} → ${status(e.newValue)}${e.text ? ` (${e.text})` : ''}`;
    case 'SCOPE': return `${who} set scope ${scope(e.oldValue)} → ${scope(e.newValue)}`;
    case 'RESOLUTION': return `${who} closed it as ${RESOLUTION_LABELS[e.newValue as Resolution] ?? e.newValue}`;
    case 'REASON': return `${who} gave the reason “${e.newValue ?? ''}”`;
    case 'REOPENED': return `${who} reopened it`;
    case 'TITLE': return `${who} renamed it “${e.oldValue}” → “${e.newValue}”`;
    case 'DESCRIPTION': return `${who} edited the description`;
    case 'KIND': return `${who} changed the kind ${e.oldValue} → ${e.newValue}`;
    case 'FLAGS': return `${who} set flags ${e.oldValue || 'none'} → ${e.newValue || 'none'}`;
    case 'TEAMS': return teamsText(e, who, teamName);
    case 'CYCLE': return `${who} moved it to cycle ${e.newValue ?? 'none'}`;
    case 'PROJECT': return `${who} moved it to project ${e.newValue || 'No project'}`;
    case 'LINK_ADDED': return `${who} linked ${e.newValue ?? ''}`;
    case 'LINK_REMOVED': return `${who} removed the link ${e.oldValue ?? ''}`;
    case 'SPEC_REPLACED': return `${who} replaced the spec file ${e.newValue ?? ''}`;
    case 'IMPORTED': return `Imported as #${e.newValue}`;
    case 'MERGED': return `${who} merged ${e.newValue} “${e.text ?? ''}” into this card`;
    case 'BLOCKED': return `${who} marked it blocked by ${e.newValue} “${e.text ?? ''}”`;
    case 'UNBLOCKED': return `${who} removed the block by ${e.oldValue}`;
    case 'SPEC_ITEM': return `${who} linked it to the spec item “${e.text ?? ''}” (${e.newValue})`;
    case 'PROPOSED': return `${who} proposed ${proposalTarget(e.newValue)}${e.text ? ` - ${e.text}` : ''}`;
    case 'PROPOSAL_ACCEPTED': return `${who} accepted Claude's proposal: ${proposalTarget(e.newValue)}`;
    case 'PROPOSAL_DISMISSED': return `${who} dismissed Claude's proposal: ${proposalTarget(e.newValue)}`;
    default: return `${who}: ${e.kind}`;
  }
}

/** "Claude set teams: Backend, Frontend (was: Backend) - the page hides the error". */
function teamsText(e: ActivityEntry, who: string, teamName: (id: string) => string): string {
  const names = (v: string | null) => (v ? v.split(',').filter(Boolean).map(teamName).join(', ') : '');
  const now = names(e.newValue) || 'no team';
  const was = names(e.oldValue);
  const verb = was ? 'reassigned it to' : 'assigned it to';
  return `${who} ${verb} ${now}${was ? ` (was: ${was})` : ''}${e.text ? ` - ${e.text}` : ''}`;
}
