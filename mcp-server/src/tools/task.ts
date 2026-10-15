import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { cycleCallCount, findCycle } from '../cycle-calls.ts';
import type { SessionCycle } from '../frontend.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { ok, REPLY_BUDGET, run, text } from '../reply.ts';
import { ago } from './board.ts';
import { MaskSchema } from './cycles.ts';
import { countsLine, readRequirements, type RequirementsView } from './requirements.ts';

/**
 * The harness (task_context, the `resume` prompt): a session cycle is a TASK, and everything about it lives in Alfred -
 * the brief (task, description, scope, data, decisions), the requirements (the spec files' Acceptance items with the
 * user's marks), the test steps, the cards (bugs, missing work, notes, questions), what waits on whom, and what Claude
 * did in earlier runs. One call gives a new session - on another machine, or another agent - the whole state, so
 * nothing depends on a conversation that is gone. Read-only; the skills write their progress back to the board.
 */

const SECTION_MAX = 1_400;
const BRIEF_SECTIONS = ['task', 'description', 'scope', 'out of scope', 'requirements', 'test steps', 'data', 'decisions', 'notes'];
/** What the user ruled out and decided: a session that misses a line of these redoes a closed argument, so they are never cut. */
const NEVER_CUT = new Set(['out of scope', 'decisions']);

/**
 * How much of each part of task_context fits. The reply is held to REPLY_BUDGET by trying these in order, the first that fits
 * wins: the earlier runs go first (the board's session log has them), then the tail of the findings, and only then the
 * longer brief sections and the requirements. The brief's Out of scope and Decisions and every requirement's key are never cut.
 */
interface Limits { runs: number; runChars: number; open: number; decided: number; section: number; requirements: number }
const FULL: Limits = { runs: 3, runChars: 400, open: Infinity, decided: 15, section: SECTION_MAX, requirements: Infinity };
const LADDER: readonly Limits[] = [
  FULL,
  { ...FULL, runs: 1, runChars: 250 },
  { ...FULL, runs: 0 },
  { ...FULL, runs: 0, open: 60, decided: 5 },
  { ...FULL, runs: 0, open: 25, decided: 0 },
  { ...FULL, runs: 0, open: 25, decided: 0, section: 500, requirements: 40 },
];

interface CardHit {
  project: string; number: number; kind: string; title: string; status: string; flags: string[];
  waiting?: { who: string; since: string } | null; resolution: string | null; reason: string | null;
}
interface ChecklistFile { fileName: string; items: { key: string; text: string; mark: { mark: string } | null; suggestion?: { mark: string } | null; cards?: { number: number }[] }[] }
interface StepRow { key: string; text: string; state: string; calls: number; cardNumber: number | null; note: string | null }
interface LogEntry { skill: string; did: string; found: string; next: string; at: string }
interface NextSteps { waitingOnUser: { number: number; title: string; why: string; since: string }[]; waitingOnClaude: number; toDo: number; inProgress: number; fixed: number; inbox: number }
interface AgentStatus { state: string; step?: string | null; cycleId: string | null; updatedAt: string }

/** The brief's sections by heading ("## Task", "## Out of scope"...); text before the first heading is the "summary". */
export function briefSections(brief: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  let current = { name: 'summary', text: '' };
  for (const line of brief.split('\n')) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      if (current.text.trim()) out.push({ name: current.name, text: current.text.trim() });
      current = { name: h[1].toLowerCase(), text: '' };
    } else {
      current.text += `${line}\n`;
    }
  }
  if (current.text.trim()) out.push({ name: current.name, text: current.text.trim() });
  return out;
}

function cut(value: string, max = SECTION_MAX): string {
  return value.length > max ? `${value.slice(0, max)}… (${value.length} chars - get_brief for all)` : value;
}

const MARK = { PASS: '✓', FAIL: '✗', CANT_TELL: '?' } as Record<string, string>;

const ACTIVE = new Set(['INBOX', 'TO_DO', 'IN_PROGRESS']);

/**
 * A requirement's state, the same way the frontend's Task tab (shared/utils/task-view.ts requirementsOf) derives it -
 * so Claude and the user read one picture: the user's mark, then the cards linked to the item, then Claude's suggestion.
 */
export function requirementState(item: ChecklistFile['items'][number], cards: readonly Pick<CardHit, 'number' | 'kind' | 'status'>[]): string {
  const linked = (item.cards ?? []).map((r) => cards.find((c) => c.number === r.number)).filter((c) => c !== undefined)
    .filter((c) => c.kind === 'BUG' || c.kind === 'TASK');
  const active = linked.filter((c) => ACTIVE.has(c.status));
  const byCards = active.some((c) => c.kind === 'BUG') ? 'BUG' : active.length ? 'MISSING' : linked.some((c) => c.status === 'FIXED') ? 'FIXED' : null;
  const mark = item.mark?.mark;
  if (mark === 'PASS') return 'MET';
  if (mark === 'FAIL') return byCards ?? 'BUG';
  if (mark === 'CANT_TELL') return byCards ?? "CAN'T TELL";
  if (byCards) return byCards;
  const sg = item.suggestion?.mark;
  return sg === 'PASS' ? 'MET?' : sg === 'FAIL' ? 'BUG?' : sg === 'CANT_TELL' ? "CAN'T TELL?" : 'NOT CHECKED';
}
const OPEN = new Set(['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED']);

/** The one next step, from what the board says - the same order /alfred-status and /alfred-guide follow. */
export function nextStep(cycleName: string, hasBrief: boolean, hasRequirements: boolean, n: NextSteps | null, cards: readonly CardHit[]): string {
  const arg = JSON.stringify(cycleName);
  if (!hasBrief) return `No brief yet - /alfred-setup (or /alfred-spec ${arg}) to write the task, its scope and its requirements.`;
  if (n?.waitingOnUser.length) return `${n.waitingOnUser.length} wait on the user (answer on the board), then /alfred-sync.`;
  if (cards.some((c) => c.status === 'INBOX')) return '/alfred-triage - sort the Inbox with the user.';
  if (cards.some((c) => c.status === 'TO_DO' || c.status === 'IN_PROGRESS')) return '/alfred-fix - work the To do cards the user chose.';
  if (cards.some((c) => c.status === 'FIXED')) return `Re-test the Fixed cards (use the app again), then /alfred-verify.`;
  if (!hasRequirements) return `Add the requirements (an Acceptance list) - /alfred-spec ${arg} - so the task can be checked against them.`;
  return `/alfred-review ${arg} on the latest recording, or /alfred-report when the task is done.`;
}

async function listTasks(client: AlfredClient): Promise<string> {
  const cycles = await client.get<SessionCycle[]>('/session-cycles');
  const recent = [...cycles].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20);
  const lines = recent.map((c) => `  ${c.name}  (${c.id}) · ${c.status}${c.reliveRunId ? ' · relive run' : ''} · created ${ago(c.createdAt)} ago`);
  return ['TASKS - each session cycle is a task; the newest first:', ...lines, '',
    'Call task_context with the task\'s name or id to load it. Ask the user which task they mean when it is not clear.'].join('\n');
}

async function taskText(client: AlfredClient, ctx: MaskContext, cycle: SessionCycle): Promise<string> {
  const id = cycle.id;
  const [brief, checklist, steps, cardsPage, log, calls, verdicts] = await Promise.all([
    client.get<{ text: string; updatedAt: string | null; updatedBy?: string }>(`/board/cycles/${seg(id)}/brief`).catch(() => ({ text: '', updatedAt: null })),
    client.get<ChecklistFile[]>(`/board/cycles/${seg(id)}/checklist`).catch(() => [] as ChecklistFile[]),
    client.get<StepRow[]>(`/board/cycles/${seg(id)}/steps`).catch(() => [] as StepRow[]),
    client.get<{ cards: CardHit[]; total: number }>('/board/search', { query: { cycleId: id, limit: 200 } }).catch(() => ({ cards: [] as CardHit[], total: 0 })),
    client.get<LogEntry[]>(`/board/cycles/${seg(id)}/log`, { query: { limit: 3 } }).catch(() => [] as LogEntry[]),
    cycleCallCount(client, id).catch(() => null),
    readRequirements(client, id).catch(() => null as RequirementsView | null),
  ]);
  const cards = cardsPage.cards;
  // specs/018: each item's verdict by the calls, worked out by Alfred in code
  const verdictOf = new Map((verdicts?.items ?? []).map((r) => [`${r.fileName}\n${r.itemKey}`, r]));
  const project = cards.find((c) => c.project)?.project ?? '';
  const [next, agent] = await Promise.all([
    client.get<NextSteps>('/board/next-steps', { query: { project, cycleId: id } }).catch(() => null),
    client.get<AgentStatus | null>('/board/agent-status', { query: { project } }).catch(() => null),
  ]);

  // Everything that shows a masked value is masked here, once - rendering below may run several times to fit the reply.
  const taskName = maskText(ctx, cycle.name);
  const sections = briefSections(maskText(ctx, brief.text ?? ''));
  const ordered = [...sections].sort((a, b) => (BRIEF_SECTIONS.indexOf(a.name) + 99) % 99 - (BRIEF_SECTIONS.indexOf(b.name) + 99) % 99);

  // requirements: the Acceptance items with the user's marks
  const items = checklist.flatMap((f) => f.items.map((i) => ({ ...i, file: f.fileName })));
  const counts = { PASS: 0, FAIL: 0, CANT_TELL: 0, none: 0 } as Record<string, number>;
  for (const i of items) counts[i.mark?.mark ?? 'none']++;
  const requirementLines = items.map((i) => {
    const mark = i.mark ? MARK[i.mark.mark] ?? i.mark.mark : '·';
    const v = verdictOf.get(`${i.file}\n${i.key}`)?.verdict;
    const byCalls = v && v.verdict !== 'NO_EVIDENCE'
      ? `calls: ${v.verdict}${v.reason ? ` (${maskText(ctx, v.reason)})` : ''}` : v ? 'calls: no evidence yet' : '';
    const extra = [i.cards?.length ? `cards ${i.cards.map((c) => `#${c.number}`).join(' ')}` : '', i.suggestion ? `you suggested ${i.suggestion.mark}` : '',
      byCalls].filter(Boolean).join(' · ');
    // The key in full: board_link_spec and board_suggest_mark take it as it is, and a shortened one matches nothing.
    return `  ${mark} ${requirementState(i, cards)} [${i.key}] ${maskText(ctx, i.text)}${extra ? ` - ${extra}` : ''}  (${i.file})`;
  });

  const stepLines = steps.map((s) => {
    const mark = s.state === 'SEEN' ? '✓' : s.state === 'FAILED' ? '✗' : '·';
    return `  ${mark} [${s.key}] ${maskText(ctx, s.text)}${s.state === 'SEEN' ? ` (${s.calls} calls)` : s.state === 'FAILED' ? ` (${s.cardNumber ? `#${s.cardNumber}` : 'failed'})` : ''}`;
  });

  // findings: bugs, missing work, notes, questions
  const open = cards.filter((c) => OPEN.has(c.status));
  const byKind = (k: string) => open.filter((c) => c.kind === k).length;
  const order = ['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED'];
  const openLines = [...open].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map((c) => {
    const waiting = c.waiting && c.waiting.who !== 'NONE' ? ` · waiting on ${c.waiting.who === 'USER' ? 'the user' : c.waiting.who.toLowerCase()} ${ago(c.waiting.since)}` : '';
    return `  #${c.number} ${c.kind} ${c.status}${c.flags.length ? ` [${c.flags.join(', ')}]` : ''}${waiting} - ${maskText(ctx, c.title)}`;
  });
  const decidedLines = cards.filter((c) => c.status === 'CLOSED' && c.resolution)
    .map((c) => `    #${c.number} ${c.resolution}${c.reason ? `: ${maskText(ctx, c.reason)}` : ''} - ${maskText(ctx, c.title)}`);

  const waitingLines = (next?.waitingOnUser ?? []).slice(0, 10).map((w) => `  #${w.number} ${w.why} · ${ago(w.since)} - ${maskText(ctx, w.title)}`);
  const runs = log.map((e) => ({ skill: e.skill, at: e.at, did: maskText(ctx, e.did), found: maskText(ctx, e.found), next: maskText(ctx, e.next) }));

  const render = (l: Limits): string => {
    const out: string[] = [];
    out.push(`TASK "${taskName}" (cycle ${id})${project ? ` · project ${project}` : ''} · ${cycle.status}${calls != null ? ` · ${calls} calls recorded` : ''} · created ${ago(cycle.createdAt)} ago`);
    out.push('Alfred holds this task\'s state - this is the shared memory across sessions, machines and agents. Work from it, write progress back '
      + '(board_comment did/found/next, board_session_log), and never rely on an earlier conversation.');

    // the brief: the task, its description, scope, data, decisions
    out.push('', `BRIEF${brief.updatedAt ? ` (edited ${ago(brief.updatedAt)} ago${brief.updatedBy === 'CLAUDE' ? ' by Claude' : ''})` : ''}`);
    if (!sections.length) {
      out.push('  (none) - the task, its description and scope are not written down yet.');
    } else {
      for (const sec of ordered) {
        if (sec.name === 'test steps' && steps.length) continue; // shown with their results below
        out.push(`  ${sec.name.toUpperCase()}: ${(NEVER_CUT.has(sec.name) ? sec.text : cut(sec.text, l.section)).replace(/\n/g, '\n    ')}`);
      }
    }

    out.push('', `REQUIREMENTS (Acceptance items of the spec files; marks are the user's)${items.length
      ? ` - ${items.length}: ${counts.PASS} pass · ${counts.FAIL} fail · ${counts.CANT_TELL} can't tell · ${counts.none} unmarked` : ''}`);
    if (!items.length) out.push('  (none) - no spec file has an Acceptance list; the task can only be checked against generic rules.');
    if (items.length) out.push('  (state as the Task tab shows it: the user\'s mark, then the linked cards - open BUG = bug, open TASK = missing, '
      + 'FIXED = re-test - then your suggestion, shown with "?")');
    if (verdicts && verdicts.items.length) out.push(`  By the calls (Alfred's requirement check, in code): ${countsLine(verdicts)} - board_requirements has each `
      + 'deciding call; a MISSING item already has its "Missing feature" card, link to it.');
    out.push(...requirementLines.slice(0, l.requirements));
    if (requirementLines.length > l.requirements) out.push(`  … +${requirementLines.length - l.requirements} more - read_spec lists every item with its key`);

    if (stepLines.length) out.push('', 'TEST STEPS', ...stepLines);

    out.push('', `FINDINGS - ${open.length} open (${byKind('BUG')} bugs · ${byKind('TASK')} missing / to do · ${byKind('NOTE')} notes · ${byKind('QUESTION')} questions), `
      + `${cards.length - open.length} finished or closed`);
    out.push(...openLines.slice(0, l.open));
    if (openLines.length > l.open) out.push(`  … +${openLines.length - l.open} more open - board_search ${JSON.stringify({ cycleId: id })}`);
    if (decidedLines.length) {
      out.push('  Decided by the user (never raise again):');
      out.push(...decidedLines.slice(0, l.decided));
      if (decidedLines.length > l.decided) out.push(`    … +${decidedLines.length - l.decided} more - board_closed_reasons`);
    }

    if (waitingLines.length) out.push('', 'WAITING ON THE USER', ...waitingLines);

    if (runs.length) {
      out.push('', 'EARLIER RUNS (newest first)');
      for (const e of runs.slice(0, l.runs)) {
        out.push(`  /${e.skill} · ${ago(e.at)} ago`, `    did: ${cut(e.did, l.runChars)}`, `    found: ${cut(e.found, l.runChars)}`, `    next: ${cut(e.next, l.runChars - 100)}`);
      }
      if (runs.length > l.runs) out.push(`  … ${runs.length - l.runs} earlier run(s) not shown to fit this reply`);
    }
    if (agent && agent.cycleId === id && agent.state !== 'STOPPED') out.push('', `NOW: Claude ${agent.state.toLowerCase()}${agent.step ? ` - ${agent.step}` : ''} (${ago(agent.updatedAt)} ago)`);

    out.push('', `NEXT: ${nextStep(cycle.name, sections.length > 0, items.length > 0, next, cards)}`);
    out.push('', 'TOOLS: check_calls (check the recorded calls) · get_brief / read_spec (the full text) · board_get (a card in full) · board_changes '
      + '(what changed since your last entry, cursor "claude") · the /alfred-* skills when installed (/alfred-guide explains them).');
    return out.join('\n');
  };

  const meta = `\n${JSON.stringify({ cycleId: id, project, ...maskMeta(ctx) })}`;
  let body = '';
  for (const limits of LADDER) {
    body = render(limits);
    if (body.length + meta.length <= REPLY_BUDGET) break;
  }
  // Only what is never cut can still be over: say so rather than cutting it.
  if (body.length + meta.length > REPLY_BUDGET) {
    body += `\n(${body.length} characters, over the usual ${REPLY_BUDGET}: everything that may be cut was, and the brief's Out of scope and Decisions never are.)`;
  }
  return `${body}${meta}`;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('task_context', {
    description: 'START EVERY SESSION HERE. A session cycle is a task; Alfred keeps everything about it, so a new session, another machine or '
      + 'another agent picks up exactly where the work stands: the brief (task, description, scope, out of scope, data, decisions), the '
      + 'requirements (spec Acceptance items with the user\'s marks), the test steps, the findings (bugs, missing work, notes, questions) with '
      + 'who each waits on, what the user decided, Claude\'s earlier runs, and the one next step. Without a task: lists the tasks (newest first).',
    inputSchema: {
      task: z.string().optional().describe('The task: its cycle id, or text from its name. Omit to list the tasks.'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    if (!input.task) return text(await listTasks(client));
    const found = await findCycle(client, input.task);
    if ('candidates' in found) {
      return ok({ candidates: found.candidates }, `"${input.task}" matches ${found.candidates.length} tasks - ask the user which one, then call task_context with its id.`);
    }
    const ctx = await maskContext(client, input.mask);
    return text(await taskText(client, ctx, found));
  }));

  // An MCP prompt is a slash command in any MCP client (in Claude Code: /mcp__alfred__resume) - the harness for an
  // agent that has no /alfred-* skills installed.
  server.registerPrompt('resume', {
    title: 'Resume an Alfred task',
    description: 'Load a task\'s state from Alfred and continue it - from any session, machine or agent.',
    argsSchema: { task: z.string().optional().describe('The task (cycle) name or id; empty lists them') },
  }, ({ task }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Resume the Alfred task${task ? ` "${task}"` : ''}.`,
          `1. Call task_context${task ? ` with task ${JSON.stringify(task)}` : ' (no task: it lists them - ask me which one)'}. It is the whole state: brief, requirements, findings, decisions, earlier runs, next step.`,
          '2. Tell me in three lines where the task stands and the next step it names. Do not start work I did not choose.',
          '3. When you work: check recorded calls with check_calls, record findings with board_add / board_add_many (they land in the Inbox), '
            + 'progress with board_comment (did / found / next), and end with one board_session_log entry - so the next session, on any machine, '
            + 'continues from Alfred, not from this conversation.',
          '4. Never close, verify or mark a card or a requirement yourself - propose it (board_propose, board_suggest_mark); those are mine.',
        ].join('\n'),
      },
    }],
  }));
}
