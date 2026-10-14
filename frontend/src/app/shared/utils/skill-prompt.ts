import { CardSummary, STATUS_LABELS, SkillRun, WAITING_LABELS } from '../../core/models/board.models';

/**
 * What ▶ sends and ⧉ copies (docs/board.md "Run from the board"): the command first, then where it applies - the
 * Alfred, project, cycle and card - so a session on any machine, or another agent, starts on the right thing without
 * asking. The same text either way.
 */
export interface SkillPromptContext {
  readonly command: string;
  readonly alfredUrl: string;
  readonly project: string;
  readonly cycleId?: string | null;
  readonly cycleName?: string | null;
  readonly card?: Pick<CardSummary, 'number' | 'kind' | 'status' | 'title' | 'waiting'> | null;
  /** The user's latest words on the card, when known (the drawer has them). */
  readonly lastUserWord?: string | null;
}

export function skillPrompt(ctx: SkillPromptContext): string {
  const lines = [ctx.command.trim()];
  const where = [`Alfred: ${ctx.alfredUrl}`, `project ${ctx.project || 'No project'}`];
  if (ctx.cycleId) where.push(`cycle ${ctx.cycleName ? `"${ctx.cycleName}" (${ctx.cycleId})` : ctx.cycleId}`);
  lines.push(where.join(' · '));
  const c = ctx.card;
  if (c) {
    lines.push(`Card #${c.number} ${c.kind} ${STATUS_LABELS[c.status] ?? c.status} "${c.title}"`);
    if (c.waiting && c.waiting.who !== 'NONE') lines.push(`Waiting on ${WAITING_LABELS[c.waiting.who]} since ${c.waiting.since.slice(0, 16).replace('T', ' ')}`);
  }
  if (ctx.lastUserWord?.trim()) lines.push(`The user's last word on it: "${ctx.lastUserWord.trim().replace(/\s+/g, ' ').slice(0, 300)}"`);
  return lines.join('\n');
}

/** The prompt as one shell line: `claude -p "…"` (double quotes, escaped for bash and PowerShell alike). */
export function shellLine(prompt: string): string {
  return `claude -p "${prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

/** "38 s", "1 min 12 s". */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** "~1 min" - how long a skill usually takes, rounded for a hint. */
export function usualText(ms: number | undefined | null): string | null {
  if (!ms) return null;
  const s = ms / 1000;
  return s < 60 ? `~${Math.max(5, Math.round(s / 5) * 5)} s` : `~${Math.round(s / 60)} min`;
}

/** How long a run took (to its end), or has been running. */
export function runDuration(r: SkillRun, now = Date.now()): string {
  const from = Date.parse(r.takenAt ?? r.createdAt);
  const to = r.endedAt ? Date.parse(r.endedAt) : now;
  return durationText(to - from);
}

/** The skill's name of a command: "/alfred-fix 35" -> "/alfred-fix". */
export function skillOf(command: string): string {
  return command.trim().split(/\s+/)[0];
}

/** What came of a failed run, in one line. */
export function failureHint(r: SkillRun): string {
  if (r.failure === 'lost') return 'the chat that handled this cycle stopped before the run ended';
  return r.outcome ? `the chat could not run it: ${r.outcome}` : 'the chat ended it without an answer';
}

/** The steps that start a chat for a cycle - what ▶ shows when no chat handles it. */
export function startSteps(cycleId: string, cwd: string | null): { readonly cd: string; readonly live: string; readonly listen: string } {
  return { cd: `cd "${cwd ?? "<the app's repo>"}"`, live: `/alfred-live ${cycleId}`, listen: `/alfred-listen ${cycleId}` };
}
