import { ActivityEntry, CardDetail, CardSummary, RESOLUTION_LABELS, STATUS_LABELS, WAITING_LABELS, WaitingOn, ageText } from '../../core/models/board.models';
import { historyThreads } from './board-threads';
import { parseMentions } from './mention-syntax';

/**
 * The board's hand-off to Claude Code (specs/015): which /alfred-* skill a card or a cycle needs next, as the exact
 * command to paste, and a card as a Markdown issue for another team.
 */

/** A cycle name as a skill argument: quoted when it has spaces. */
export function skillArg(name: string): string {
  return /\s/.test(name) ? `"${name.replace(/"/g, "'")}"` : name;
}

/** The skill a card needs next, from what it waits on and its status - null when nothing is left to do. */
export function skillFor(card: Pick<CardSummary, 'number' | 'status' | 'waiting' | 'flags'>): string | null {
  if (card.status === 'CLOSED' || card.status === 'DONE') return null;
  if (card.waiting?.who === 'USER' && card.flags.includes('NEEDS_DECISION')) return '/alfred-sync';
  if (card.status === 'INBOX') return '/alfred-triage';
  if (card.status === 'TO_DO' || card.status === 'IN_PROGRESS') return `/alfred-fix ${card.number}`;
  if (card.status === 'FIXED') return `/alfred-verify ${card.number}`;
  if (card.status === 'VERIFIED') return '/alfred-status';
  return null;
}

/** "waiting on you · 2 d" - null for nobody / not set. */
export function waitingText(w: WaitingOn | null | undefined, now: number): string | null {
  if (!w || w.who === 'NONE') return null;
  return `waiting on ${WAITING_LABELS[w.who]} · ${ageText(w.since, now)}`;
}

/** Mentions as their labels, for plain text that leaves Alfred. */
function plain(text: string | null | undefined): string {
  return parseMentions(text).map((s) => ('mention' in s ? s.mention.label : s.text)).join('');
}

/**
 * The card as a Markdown issue (Jira / GitHub): title, state, what happens (the description), the evidence (every link
 * with its label), the spec items it breaks, and every answer the user gave Claude's questions.
 */
export function issueMarkdown(card: CardDetail, history: readonly ActivityEntry[], projectLabel = card.project || 'No project'): string {
  const state = card.resolution ? `${STATUS_LABELS[card.status]} (${RESOLUTION_LABELS[card.resolution]})` : STATUS_LABELS[card.status];
  const lines = [`## ${card.title}`, '',
    `**Alfred card** ${projectLabel} #${card.number} · ${card.kind} · ${state}${card.flags.length ? ` · flags: ${card.flags.join(', ')}` : ''}${card.teams?.length ? ` · teams: ${card.teams.join(', ')}` : ''}`, ''];
  if (card.description.trim()) lines.push('### What happens', '', plain(card.description), '');
  if (card.links.length) {
    lines.push('### Evidence', '');
    for (const l of card.links) lines.push(`- ${l.type.toLowerCase()}: ${l.label} (\`${l.ref}\`)`);
    lines.push('');
  }
  if (card.specItems?.length) {
    lines.push('### Breaks the spec', '');
    for (const i of card.specItems) lines.push(`- ${i.fileName}: ${i.text ?? '(item removed)'}`);
    lines.push('');
  }
  const answers = historyThreads(history).filter((t) => t.question).flatMap((t) =>
    t.replies.filter((r) => r.actor === 'USER').map((r) => `- Q: ${plain(t.entry.text).replace(/^\*\*Question\*\*\s*/, '')}\n  A: ${plain(r.text)} (${r.at.slice(0, 16).replace('T', ' ')})`));
  if (answers.length) lines.push('### Decisions', '', ...answers, '');
  if (card.blockedBy?.length) lines.push('### Blocked by', '', ...card.blockedBy.map((b) => `- #${b.number} ${b.title} (${STATUS_LABELS[b.status]})`), '');
  if (card.waiting && card.waiting.who !== 'NONE') lines.push(`_Waiting on ${WAITING_LABELS[card.waiting.who]} since ${card.waiting.since.slice(0, 10)}._`);
  return lines.join('\n').trimEnd() + '\n';
}
