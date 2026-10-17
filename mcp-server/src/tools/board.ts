import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { boardText, boardTexts, snippetNote } from '../board-text.ts';
import { callLines } from '../call-story.ts';
import { mentionsIn, serializeMention } from '../frontend.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { chunkText, fitItems, invalid, ok, preview, run, type ToolReply } from '../reply.ts';
import { MaskSchema } from './cycles.ts';
import { answererText, liveAnswerer } from './live.ts';
import { countsLine, readRequirements } from './requirements.ts';
import { ReadableWriter } from '../readable.ts';

/**
 * The task board (specs/014-task-board contracts/mcp-tools.md, docs/board.md "Claude"). Every request says it is Claude,
 * and the backend holds Claude to its limits whatever is asked: new cards land in the Inbox, moves only to To do /
 * In progress / Fixed, edits only on Claude's own Inbox cards, no scope, closing, reopening or deleting - those are
 * proposed (board_propose) and the user accepts them - and a card repeating one the user closed as Fine or Not in this
 * flow is refused with that card's reason. A refusal comes back word for word.
 *
 * Reading is complete: board_get gives every comment in full (a long one is read in parts with `entry`), history is
 * paged, and every mention comes with the tool that opens it; board_search/board_changes/board_wait let a new session
 * pick the work up from anywhere.
 */
const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };
/**
 * A card, a comment or a link is a write to the board's database; under load the backend takes longer than a read to answer one
 * it does finish, and a client that gave up at 4 s left Claude unsure whether it was saved.
 */
const WRITE_TIMEOUT_MS = 30_000;
const WRITE: Pick<RequestOptions, 'headers' | 'timeoutMs'> = { ...AS_CLAUDE, timeoutMs: WRITE_TIMEOUT_MS };

interface PlainQuestion {
  header: string; question: string; why?: string; multiSelect?: boolean;
  options: { label: string; description?: string; then?: string; recommended?: boolean; confidence?: string; followUp?: PlainQuestion }[];
}

/** Questions with options as board Markdown, for an Alfred that predates the questions dialog: numbered, options listed. */
export function plainQuestions(qs: readonly PlainQuestion[]): string {
  const one = (q: PlainQuestion, n: string): string[] => [
    `**${n}. ${q.header}** - ${q.question}${q.multiSelect ? ' (choose any)' : ''}`,
    ...(q.why ? [`  _Why I ask:_ ${q.why}`] : []),
    ...q.options.map((o, k) => `  ${String.fromCharCode(97 + k)}) **${o.label}**${o.recommended ? ` (recommended${o.confidence ? ` · ${o.confidence} confidence` : ''})` : ''}`
      + `${o.description ? ` - ${o.description}` : ''}${o.then ? ` → then I ${o.then.replace(/^I\s+/i, '')}` : ''}`
      + `${o.followUp ? `\n    ↳ then: ${o.followUp.question}` : ''}`),
  ];
  return [`${qs[0].question.split('\n')[0]}`, '', ...qs.flatMap((q, i) => [...one(q, String(i + 1)), '']),
    'Answer with the letters (e.g. "1a, 2b") or in your own words.'].join('\n');
}

/** One option of a question (specs/019): what picking it means, and what Claude does then. */
const AskOptionBase = z.object({
  label: z.string().min(1).max(80).describe('1-5 words'),
  description: z.string().max(2000).optional().describe('What it means, in one or two lines'),
  then: z.string().max(2000).optional().describe('What you will do if the user picks it'),
  recommended: z.boolean().optional().describe('The one you advise - at most one per question'),
  confidence: z.enum(['high', 'medium', 'low']).optional().describe('On the recommended option only (triage): high = the evidence decides '
    + 'it on its own, medium = one check could not be done, low = it rests on a guess. The tile shows it; "Accept all High" applies only high'),
  preview: z.string().max(16 * 1024).optional().describe('Shown on hover (Markdown or HTML): what changes, the effect on the recorded calls, '
    + 'the acceptance items it covers, why'),
});
const AskFollowUp = z.object({
  header: z.string().min(1).max(24).describe('A short chip label, unique on this ask, e.g. "Steps"'),
  question: z.string().min(1).max(4000),
  why: z.string().max(2000).optional().describe('Why you need the answer'),
  multiSelect: z.boolean().optional(),
  options: z.array(AskOptionBase).max(4).default([]).describe('2-4 options, or none for a free answer'),
});
const AskOption = AskOptionBase.extend({ followUp: AskFollowUp.optional().describe('Asked at once when the user picks this option (one level)') });
const AskQuestion = AskFollowUp.extend({
  options: z.array(AskOption).max(4).default([]).describe('2-4 options, or none for a free answer'),
  checked: z.string().max(600).optional().describe('Triage: what you checked before advising, one line - earlier cards, the call, code, '
    + 'database, schema, spec, git - and what you could not check and why'),
  severity: z.object({
    rank: z.number().int().min(1).describe('1 = worst in this Inbox'),
    of: z.number().int().min(1).optional().describe('How many cards / groups were ranked'),
    note: z.string().max(200).optional().describe('Why it ranks there: calls affected, spread, impact, the Acceptance item it blocks'),
  }).optional().describe('Triage: where the card ranks, worst first - the Inbox can sort by it'),
  group: z.array(z.number().int().min(1)).max(50).optional().describe('Triage: Inbox cards of the same root cause to merge into THIS card '
    + '(their numbers); offer an option labelled "Merge #14 #17 into #12"'),
});
const Kind = z.enum(['BUG', 'TASK', 'NOTE', 'QUESTION']);
const Status = z.enum(['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'DONE', 'CLOSED']);
const Flag = z.enum(['URGENT', 'RISK', 'BLOCKER', 'AFFECTS_PROJECT', 'NEEDS_DECISION']);
const Resolution = z.enum(['FINE', 'NOT_IN_FLOW', 'WONT_FIX']);
const MentionTypeSchema = z.enum(['call', 'stmt', 'log', 'redis', 'spec', 'code', 'cycle', 'spacer', 'card', 'rule']);
const Link = z.object({
  type: MentionTypeSchema,
  ref: z.string().min(1).max(1000).describe('As in contracts/mention-syntax.md, e.g. "in:<callId>", "<callId>/<seq>", "<cycleId>/spec.md#acceptance"'),
  label: z.string().min(1).max(200),
});
const Project = z.string().default('').describe('Project name; "" is "No project"');
const CardNumber = z.number().int().min(1);
/** specs/021: what every mention of the card reads - "All Agencies untested" → "All Agencies untested (#47)". */
const ShortName = z.string().max(60).optional().describe('A few words every mention of the card reads, e.g. "All Agencies untested" - give one');
const Expectation = z.object({
  kind: z.enum(['SQL_COUNT', 'STATUS', 'NO_LOG', 'DURATION', 'SAME_RESPONSE']),
  table: z.string().max(200).optional(),
  max: z.number().int().min(0).optional(),
  range: z.string().max(10).optional(),
  level: z.enum(['ERROR', 'WARN']).optional(),
  minCalls: z.number().int().min(1).max(50).optional(),
  path: z.string().max(200).optional(),
});
const ExpectList = z.array(Expectation).max(20).default([]);
/** What a step's call must send (specs/020): without it any call to the endpoint ticks the step, whatever it carried. */
const StepWhen = z.object({
  path: z.string().min(2).max(200).describe('Request JSON path: "$.branchIds", "$.branch*" (the one key starting so)'),
  shape: z.string().min(3).max(104).describe('none | one | list | list>=2 | present | has:<value> (e.g. "has:-11": the value, or a list holding it)'),
});
const StepList = z.array(z.object({
  text: z.string().min(1).max(500),
  endpoint: z.string().max(300).optional().describe('METHOD /path exactly as the app calls it - copy it from a recorded call (get_call), never guess'),
  request: z.array(StepWhen).max(4).optional().describe('What the call must send to count, e.g. [{path: "$.branchIds", shape: "has:-11"}]'),
})).max(20).default([]);

type RetestResultRow = { text: string; outcome: string; before: string | null; after: string[]; note: string | null };
type RetestCheckRow = { number: number; title: string; status: string; verdict: string; statusOnly: boolean; summary: string; newBuild: boolean;
  results: RetestResultRow[]; calls: { ref: string; label: string; passed: boolean; failed: string | null }[];
  steps: { text: string; endpoint: string | null; seen: boolean; calls: number; note?: string | null }[];
  beforeBuild?: number; emptyAnswers?: number; code?: CodeCheckRow | null };
/** Is the fix implemented (specs/026): Claude's latest look at the code since the fix. */
type CodeCheckRow = { verdict: string; commit: string | null; branch: string | null; layers: { team: string | null; where: string | null; ok: boolean; note?: string | null }[];
  tests: string | null; note: string | null; at: string };
type RetestPlanRow = { expectations: unknown[]; steps: unknown[]; updatedBy: string | null; warnings?: string[] };
type RetestRunRow = { at: string; verdict: string; calls: number; source: string; summary: string };

/** "implemented ✓ (a1b2c3d on feature/61813 · backend RefundSearchService.java:88)", "NOT_IN_BUILD - …", or not checked. */
export function implementedLine(code: CodeCheckRow | null | undefined): string {
  if (!code) return 'code not checked since the fix - check it (git, the task branch, the running build, each layer) and pass `implemented`';
  const where = [code.commit && `${code.commit}${code.branch ? ` on ${code.branch}` : ''}`,
    ...code.layers.map((l) => `${l.ok ? '' : 'MISSING '}${l.team ?? ''} ${l.where ?? ''}`.trim()), code.tests && `tests: ${code.tests}`].filter(Boolean).join(' · ');
  return `${code.verdict === 'IMPLEMENTED' ? 'implemented ✓' : code.verdict}${where ? ` (${where})` : ''}${code.note ? ` - ${code.note}` : ''}`;
}

/** What a Fixed card's two checks add up to (specs/026): ready for Verified only when it is implemented and it worked. */
export function readiness(c: RetestCheckRow): string {
  const impl = c.code?.verdict;
  if (impl && impl !== 'IMPLEMENTED' && impl !== 'UNKNOWN') {
    return impl === 'NOT_IN_BUILD' ? 'not ready - the running build does not carry the fix: restart / redeploy, then re-test (its calls ran the old code)'
      : impl === 'NOT_ON_BRANCH' ? 'not ready - the fix is not on the task branch: merge it'
        : `not ready - ${impl.toLowerCase().replace(/_/g, ' ')}: back to In progress`;
  }
  if (c.verdict === 'FAILS' || c.verdict === 'FLAKY') return 'not ready - it did not work: back to In progress';
  if (c.verdict !== 'PASSES') return `not ready - not re-tested yet (${c.verdict})`;
  if (!c.code) return 'worked ✓ - code not checked: check it before proposing Verified';
  return impl === 'UNKNOWN' ? 'worked ✓, code not reachable - propose Verified saying "code not checked"' : 'ready for Verified - implemented ✓ and worked ✓';
}

function retestLine(c: RetestCheckRow): Record<string, unknown> {
  return {
    card: `#${c.number} ${c.title} (${c.status}) - ${c.verdict}: ${c.summary}${c.newBuild ? ' · new build since the fix, not re-tested yet' : ''}`,
    ...(c.status === 'FIXED' ? { implemented: implementedLine(c.code), ready: readiness(c) } : {}),
    ...(c.statusOnly ? { note: 'No expectations - only the status was compared; board_retest_plan adds them' } : {}),
    results: c.results.map((r) => `${r.outcome} ${r.text}${r.before != null ? ` · before ${r.before}` : ''}${r.after.length ? ` · now ${r.after.slice(0, 5).join(', ')}` : ''}${r.note ? ` (${r.note})` : ''}`),
    ...(c.steps.length ? { steps: c.steps.map((s) => `${s.seen ? 'done' : 'not done'} - ${s.text}${s.endpoint ? ` [${s.endpoint}]` : ''}${s.note ? ` (${s.note})` : ''}`) } : {}),
    calls: c.calls.slice(0, 5).map((x) => `${x.passed ? 'pass' : `FAIL ${x.failed}`} ${serializeMention({ type: 'call', ref: x.ref, label: x.label })}`),
    ...(c.beforeBuild ? { beforeBuild: `${c.beforeBuild} calls before the app start that carries the fix - old code, not counted` } : {}),
    ...(c.calls.length && (c.emptyAnswers ?? 0) >= c.calls.length
      ? { emptyAnswers: 'Every answer was empty (0 rows): the fix was not seen working on data - say so, and never propose Verified on it; '
        + 'ask for a re-test with data' } : {}),
  };
}

/** The most closed cards Alfred answers for /board/closed-reasons (ListClosedReasonsUseCase.MAX_LIMIT). */
const CLOSED_MAX = 500;

/** One entry's text over this many characters is read in parts with board_get entry=<index>. */
const ENTRY_INLINE = 6000;

interface Proposal { status: string; resolution: string | null; reason: string; evidence: string; at: string; kind?: string; intoNumber?: number | null }

export interface CardRow {
  id: string; project: string; number: number; kind: string; title: string; status: string; resolution: string | null; reason: string | null;
  /** The few words every mention of the card reads (specs/021). */
  shortName?: string | null;
  flags: string[]; scope: string; author: string; cycleId: string | null; cycleDeleted: boolean; updatedAt: string; commentCount: number;
  similarClosed: { number: number; resolution: string; reason: string | null } | null; description?: string;
  links?: { type: string; ref: string; label: string }[]; proposal?: Proposal | null;
  waiting?: { who: string; since: string; setBy: string } | null;
  blockedBy?: { project: string; number: number; title: string; status: string }[];
  specItems?: { cycleId: string; fileName: string; itemKey: string; text: string | null }[];
  /** Ids of the teams the card is assigned to (board_teams lists them). */
  teams?: string[];
  createdAt?: string;
  /** Another card still open on this card's signature - on a card just created, so a finding already being worked on is seen at once. */
  similarOpen?: { number: number; title: string; status: string } | null;
  /** A board row's first few mentions (the list endpoint only). */
  mentionChips?: { type: string; ref: string; label: string }[];
}

interface TeamRow { id: string; name: string; icon: string; owns: string; hints: string[] }

/**
 * How Claude picks a card's teams - shared by board_teams, board_assign and board_add so the three say the same. The
 * evidence decides, not the endpoint's name: a 405 from a Java controller is Backend even when the page shows it.
 */
/** How board texts are written (docs/board.md "Rich text"); the skills' rules.md has the full guide. */
const WRITING = ' Texts are Markdown, HTML, or both mixed - HTML becomes board text (<table>, <details>, <aside data-callout="bug">, '
  + '<span data-color="red">), and HTML with <script>/<style>/<svg> or an animated style becomes an html live snippet. Markdown by default; HTML when Markdown cannot say it (colspan/rowspan, lists in a cell, nested callouts); script/style/SVG only for a view no fixed block gives. Shown formatted: a **bold** one-line summary first, ### headings, tables, fenced code with a language '
  + '(```sql, ```json, ```diff, ```log), > [!NEXT] / > [!WARNING] / > [!BUG] / > [!FIXED] callouts, +++ Details … +++ to fold long evidence, '
  + '- [ ] checklists, ==highlight==, [ok] [fail] [wait] pills, {{name}} for a global variable, a call mention alone on its line as a card. '
  + 'Write in the language the user writes in. Never a bare code a reader cannot open: say what a thing is in words, or mention it - '
  + 'AC8, #47, "calls #75, #81", [6] and call ids are written as their mentions with their meaning ("one-branch search (AC8)") before '
  + 'saving, and the reply lists any that could not be found.';

const TEAM_GUIDE = 'Pick teams from the evidence, using each team\'s "owns" (board_teams): the page or the request the browser sent → '
  + 'Frontend; a Java exception, a 5xx, missing error handling or log lines → Backend; a failed, slow or repeated SQL statement → '
  + 'Database; an outbound supplier call (Galileo, Sabre, NDC...) that errors, times out or is mapped wrong → Integrations; config, '
  + 'deploy, certificates, Redis/infrastructure → DevOps; test data, spec or acceptance gaps → QA. A problem that needs several teams is '
  + 'ONE card with all of them (e.g. Backend + Frontend: the API fails and the page hides it) - then write one short "### <Team>" '
  + 'section per team in the description saying what that team changes. Reassign (board_assign) whenever new evidence moves the work.';
const Teams = z.array(z.string().min(1).max(100)).max(20)
  .describe('Team ids or names from board_teams, e.g. ["backend", "frontend"]. ' + 'One card can have several.');

const WaitingOn = z.enum(['USER', 'CLAUDE', 'RETEST', 'NONE']).optional()
  .describe('Who the card waits on after this: USER (a question/decision), CLAUDE (your work), RETEST (a re-test cycle), NONE');

/** "2 d", "4 h", "12 min" - how long a card has waited. */
export function ago(iso: string, now = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

function waitingText(c: CardRow): string {
  if (!c.waiting || c.waiting.who === 'NONE') return '';
  const who = { USER: 'you', CLAUDE: 'Claude', RETEST: 'a re-test' }[c.waiting.who] ?? c.waiting.who;
  return ` · waiting on ${who === 'you' ? 'the user' : who} ${ago(c.waiting.since)}`;
}

export interface ActivityRow {
  id?: number; cardId?: string; actor: string; kind: string; text: string | null; oldValue: string | null; newValue: string | null; at: string;
  /** The thread this comment belongs to: its first comment (one level), or null. */
  replyTo?: number | null;
  /** The reply this one was written to, when that is itself a reply (the board shows replies as a tree), or null. */
  answers?: number | null;
}

export function isQuestion(e: ActivityRow): boolean {
  return e.kind === 'COMMENT' && e.actor === 'CLAUDE' && !!e.text && e.text.startsWith('**Question**');
}

/** One question of a question comment as the board keeps it (specs/019): OPEN, PENDING (a follow-up waiting on its option), LATER... */
export interface QuestionRow {
  entryId: number; idx: number; header: string; text: string; state: string; laterUntil: string | null;
  parentIdx: number | null; parentOption: string | null;
}

/** The questions of a card by the comment that asks them; an older backend without them gives none. */
export async function questionStates(client: AlfredClient, cardId: string): Promise<Map<number, QuestionRow[]>> {
  const rows = await client.get<QuestionRow[]>(`/board/cards/${seg(cardId)}/questions`).catch(() => [] as QuestionRow[]);
  const out = new Map<number, QuestionRow[]>();
  for (const q of Array.isArray(rows) ? rows : []) (out.get(q.entryId) ?? out.set(q.entryId, []).get(q.entryId)!).push(q);
  return out;
}

function stillOpen(q: QuestionRow): boolean {
  return q.state === 'OPEN' || (q.state === 'LATER' && q.laterUntil != null && Date.parse(q.laterUntil) <= Date.now());
}

/** " (questions: Steps OPEN · Plan waits on Steps = Rewrite)" after a question comment - or the old answered/OPEN for one without rows. */
export function questionNote(e: ActivityRow, states: ReadonlyMap<number, QuestionRow[]>, answered: ReadonlySet<number | null | undefined>): string {
  if (!isQuestion(e)) return '';
  const rows = e.id == null ? undefined : states.get(e.id);
  if (!rows?.length) return ` (question - ${answered.has(e.id) ? 'answered' : 'OPEN, waiting for the user'})`;
  const parentOf = (q: QuestionRow) => rows.find((r) => r.idx === q.parentIdx)?.header ?? '?';
  return ` (questions: ${rows.map((q) => q.state === 'PENDING' ? `${q.header} waits on ${parentOf(q)} = ${q.parentOption}`
    : q.state === 'LATER' ? `${q.header} ${stillOpen(q) ? 'OPEN again (was put off)' : `put off until ${q.laterUntil}`}`
    : q.state === 'DROPPED' ? `${q.header} not needed (${parentOf(q)} answered otherwise)`
    : `${q.header} ${q.state}`).join(' · ')})`;
}

/** Claude's questions on a card the user has not answered yet, as history indexes. */
export function openQuestionIndexes(entries: readonly ActivityRow[], states: ReadonlyMap<number, QuestionRow[]> = new Map()): number[] {
  const answered = new Set(entries.filter((e) => e.actor === 'USER' && e.replyTo != null).map((e) => e.replyTo));
  return entries.map((e, i) => {
    if (!isQuestion(e)) return -1;
    const rows = e.id == null ? undefined : states.get(e.id);
    return (rows?.length ? rows.some(stillOpen) : !answered.has(e.id)) ? i : -1;
  }).filter((i) => i >= 0);
}

/**
 * A ```questions / ```answers block on one line for Claude: its JSON compacted, and the option previews (Claude wrote them, the
 * user hovers them) cut to a mark - so a question comment does not spend the inline budget on what Claude already knows.
 */
export function compactBlocks(text: string): string {
  return text.replace(/^```(questions|answers)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (whole, lang: string, body: string) => {
    try {
      const json = JSON.parse(body, (key, value) => (key === 'preview' && typeof value === 'string' ? `(${value.length} chars)` : value));
      return `${lang}: ${JSON.stringify(json)}`;
    } catch {
      return whole;
    }
  });
}

/** A history index from board_get to the comment's id - a reply names the comment it answers by its index. */
async function commentIdAt(client: AlfredClient, card: CardRow, index: number): Promise<number> {
  const entries = await history(client, card.id);
  const e = entries[index];
  if (!e || e.kind !== 'COMMENT' || e.id == null) {
    throw invalid(`History entry [${index}] of card #${card.number} is not a comment - pass the [index] of a comment from board_get.`);
  }
  return e.id;
}

interface SearchHit extends CardRow { lastComment: ActivityRow | null }

export interface ChangeRow extends ActivityRow { project: string; number: number; title: string; status: string; cycleId: string | null }

export interface ChangesPage {
  entries: ChangeRow[];
  cycles: { cycleId: string; what: string; name: string | null; detail: string | null; at: string }[];
  /** specs/022: chat messages waiting for Claude, and what a cycle's chat sent its terminal (absent from older Alfreds) */
  chats?: { messageId: number; project: string; scope: string; kind: string; urgent: boolean; parentId: number | null; origin: string | null;
    text: string; at: string }[];
  fromChat?: { id: number; urgent: boolean; mirror: boolean; text: string; reason: string | null; state: string }[];
  cursor: string;
  more: boolean;
}

/** A chat message to take, urgent first (the backend lists them in time order). */
export function chatChangeLines(ctx: MaskContext, page: ChangesPage): string[] {
  const rows = [...(page.chats ?? [])].sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.messageId - b.messageId);
  return rows.map((c) => `${c.at} ${c.urgent ? '⚡ ' : ''}chat ${c.scope === 'project' ? `${c.project || '(No project)'} project` : `cycle ${c.scope}`} `
    + `#${c.messageId}${c.kind === 'TASK' ? ' (task)' : ''}${c.parentId ? ` ↳ thread #${c.parentId}` : ''}: `
    + `"${preview(maskText(ctx, c.text).replace(/\s+/g, ' '), 200, 'chat_take')}" → chat_take ${JSON.stringify({ project: c.project, scope: c.scope, messageId: c.messageId })}`);
}

export function line(c: CardRow): string {
  const flags = c.flags.length ? ` [${c.flags.join(', ')}]` : '';
  const state = c.resolution ? `${c.status} (${c.resolution}${c.reason ? `: ${c.reason}` : ''})` : c.status;
  const proposal = c.proposal ? ` · ✦ proposed ${target(c.proposal)} - waiting for the user` : '';
  const blocked = c.blockedBy?.length ? ` · 🔒 blocked by ${c.blockedBy.map((b) => `#${b.number}`).join(', ')}` : '';
  const teams = c.teams?.length ? ` {${c.teams.join(', ')}}` : '';
  return `#${c.number} ${c.kind}${flags}${teams} ${c.title} - ${state}${c.cycleId ? ` (cycle ${c.cycleId}${c.cycleDeleted ? ', deleted' : ''})` : ''}`
    + `${c.author === 'CLAUDE' ? ' ✦' : ''}${c.commentCount ? ` · ${c.commentCount} comments` : ''}${waitingText(c)}${blocked}${proposal}`;
}

function target(p: Proposal): string {
  if (p.kind === 'MERGE') return `merge into #${p.intoNumber}`;
  if (p.kind === 'REOPEN') return 'reopen';
  return p.status === 'CLOSED' && p.resolution ? `close as ${p.resolution}` : p.status;
}

/** What a new card says when another open card already has its signature - the finding joins that card or is merged into it. */
function similarOpenNote(card: CardRow): string | null {
  const s = card.similarOpen;
  return s ? `same signature as open #${s.number} "${s.title}" - link or board_propose MERGE` : null;
}

/** The calls among a board row's first mentions, compact: " · calls: in:3f2a9c1d… out:7b81e0aa…" (board_get has them all). */
function callsOf(c: CardRow): string {
  const calls = [...new Set((c.mentionChips ?? []).filter((m) => m.type.toLowerCase() === 'call')
    .map((m) => m.ref.replace(/^(in|out):([^@]+).*$/, (_, d: string, id: string) => `${d}:${id.slice(0, 8)}…`)))];
  return calls.length ? ` · calls: ${calls.join(' ')}` : '';
}

/** The call a card is about, for its signature: the first call link, else the first call in its description. */
function firstCallRef(links: readonly { type: string; ref: string }[], description: string): string | undefined {
  return links.find((l) => l.type.toLowerCase() === 'call')?.ref ?? mentionsIn(description).find((m) => m.type.toLowerCase() === 'call')?.ref;
}

/** A create the client stopped waiting for, or lost to a gateway error, may still have been saved. */
function outcomeUnknown(error: unknown): boolean {
  return error instanceof AlfredError && error.kind === 'unreachable';
}

const LANDED_WITHIN_MS = 60_000;

/**
 * After a create timed out: the card of this project with this title made in the last minute, if the backend finished it. A second
 * attempt would otherwise repeat the card, and "not added" would be a lie. `unreachable` is true when Alfred does not answer this
 * check either - nothing more can be written then.
 */
async function createdMeanwhile(client: AlfredClient, project: string, card: { title: string; links: readonly { type: string; ref: string }[]; description: string },
  exclude: ReadonlySet<number>): Promise<{ card: CardRow | null; unreachable: boolean }> {
  try {
    const similar = await client.get<{ why: string; card: CardRow }[]>('/board/similar',
      { query: { project, title: card.title, call: firstCallRef(card.links, card.description), limit: 50 } });
    const title = card.title.trim().toLowerCase();
    const found = similar.map((s) => s.card).find((c) => (c.project ?? '') === project && c.title.trim().toLowerCase() === title
      && !exclude.has(c.number) && (!c.author || c.author === 'CLAUDE')
      && c.createdAt !== undefined && Date.now() - Date.parse(c.createdAt) < LANDED_WITHIN_MS);
    return { card: found ?? null, unreachable: false };
  } catch (error) {
    return { card: null, unreachable: outcomeUnknown(error) };
  }
}

export function who(actor: string): string {
  return actor === 'CLAUDE' ? 'Claude' : 'User';
}

/** One history entry as one line; a comment in full (it is read in parts past `inline` characters). */
export function entryLine(ctx: MaskContext, e: ActivityRow, index: number, inline = ENTRY_INLINE): string {
  const text = maskText(ctx, compactBlocks(e.text ?? ''));
  const body = text.length > inline ? `${text.slice(0, inline)}… (${text.length} chars - read the rest with board_get entry=${index})` : text;
  if (e.kind === 'COMMENT') return `${e.at} ${who(e.actor)}: ${body}`;
  // ✅ from the user on your plan or question is the go-ahead (docs/board.md "Rich text")
  if (e.kind === 'REACTION') return `${e.at} ${who(e.actor)} reacted ${text}${text === '✅' ? ' = GO: the user approves - go ahead' : ''}`;
  if (e.kind === 'COMMENT_EDITED') return `${e.at} ${who(e.actor)} edited a comment; it now reads: ${body}`;
  const change = e.oldValue || e.newValue ? ` ${e.oldValue ?? ''} → ${e.newValue ?? ''}` : '';
  return `${e.at} ${who(e.actor)} ${e.kind}${change}${body ? ` (${body})` : ''}`;
}

/** A comment on a cycle's brief (specs/024). */
export interface BriefCommentRow {
  id: number; quote: string | null; actor: string; text: string; replyTo: number | null; asks: boolean;
  suggestFrom: string | null; suggestTo: string | null; createdAt: string; resolvedAt: string | null;
}

/** The brief's comment threads for a reply: open ones in full, resolved ones counted. */
export function briefThreads(rows: readonly BriefCommentRow[], mask: (t: string) => string): string[] {
  const plain = (t: string) => mask(t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  const roots = rows.filter((r) => r.replyTo == null);
  const out: string[] = [];
  for (const root of roots.filter((r) => !r.resolvedAt)) {
    const thread = [root, ...rows.filter((r) => r.replyTo === root.id)];
    const last = thread[thread.length - 1];
    const waits = thread.some((c) => c.asks) && last.actor === 'CLAUDE';
    out.push(`[${root.id}] on ${root.quote ? JSON.stringify(mask(root.quote)) : 'the whole brief'}${waits ? ' · you asked - waiting for the user' : ''}`);
    for (const c of thread) {
      out.push(`  ${c.actor === 'CLAUDE' ? 'you' : 'user'} (${c.id}): ${plain(c.text)}`
        + `${c.suggestTo ? ` · you suggested ${JSON.stringify(mask(c.suggestFrom ?? ''))} -> ${JSON.stringify(mask(c.suggestTo))}, not applied yet` : ''}`);
    }
  }
  const resolved = roots.length - roots.filter((r) => !r.resolvedAt).length;
  if (resolved) out.push(`(${resolved} resolved thread${resolved === 1 ? '' : 's'} not shown)`);
  return out;
}

interface StepRow { key: string; text: string; state: string; calls: number; cardNumber: number | null; note: string | null }

function stepLine(s: StepRow): string {
  const mark = s.state === 'SEEN' ? '✓' : s.state === 'FAILED' ? '✗' : '·';
  const detail = s.state === 'SEEN' ? ` (${s.calls} call${s.calls === 1 ? '' : 's'})` : s.state === 'FAILED' ? ` (${s.cardNumber ? `card #${s.cardNumber}` : 'failed'}${s.note ? `: ${s.note}` : ''})` : ' (not tested yet)';
  return `[${s.key}] ${mark} ${s.text}${detail}`;
}

/** How to open what a mention points at - the tool and its arguments. */
export function openWith(type: string, ref: string): string {
  switch (type) {
    case 'call': {
      const m = /^(in|out):([^@]+)(?:@(.+))?$/.exec(ref);
      if (!m) return 'get_call';
      const args = { callId: m[2], ...(m[3] ? { cycleId: m[3] } : {}) };
      return m[1] === 'in' ? `investigate_call ${JSON.stringify(args)}` : `get_call ${JSON.stringify({ ...args, source: 'external' })}`;
    }
    case 'stmt': return `db_statements ${JSON.stringify({ callId: ref.split('/')[0] })} (statement seq ${ref.split('/')[1] ?? '?'})`;
    case 'log': return `call_logs ${JSON.stringify({ callId: ref.split('/')[0] })}`;
    case 'redis': return `redis_commands ${JSON.stringify({ callId: ref.split('/')[0] })} (seq ${ref.split('/')[1] ?? '?'})`;
    case 'spec': {
      const slash = ref.indexOf('/');
      const rest = ref.slice(slash + 1);
      const hash = rest.indexOf('#');
      return `read_spec ${JSON.stringify({ cycleId: ref.slice(0, slash), name: hash < 0 ? rest : rest.slice(0, hash), ...(hash < 0 ? {} : { section: rest.slice(hash + 1) }) })}`;
    }
    case 'card': {
      const m = /^(.*)#(\d+)$/.exec(ref);
      return m ? `board_get ${JSON.stringify({ project: m[1], number: Number(m[2]) })}` : 'board_get';
    }
    case 'cycle': return `get_cycle ${JSON.stringify({ cycleId: ref })}`;
    case 'spacer': return `get_cycle ${JSON.stringify({ cycleId: ref.split('/')[0] })}`;
    case 'code': return `locate_source / read the file ${ref}`;
    case 'rule': return `get_rule ${JSON.stringify({ ruleId: ref })}`;
    default: return '';
  }
}

/** The writer that makes a card's texts readable (specs/021): its project, cycle and history for `#47`, `AC8`, `[6]`. */
function writerFor(client: AlfredClient, card: CardRow): ReadableWriter {
  return new ReadableWriter(client, { project: card.project, cycleId: card.cycleId, card: { id: card.id, number: card.number } });
}

/** A new card's short name, when Claude gave one; a failure is said, never a reason to call the card not added. */
async function nameCard(client: AlfredClient, card: CardRow, shortName: string | undefined): Promise<Record<string, string>> {
  if (!shortName?.trim()) return {};
  try {
    await client.put(`/board/cards/${seg(card.id)}/short-name`, { ...AS_CLAUDE, body: { shortName } });
    return { shortName: shortName.trim() };
  } catch (error) {
    return { shortNameNotSet: (error as Error).message };
  }
}

export async function cardByNumber(client: AlfredClient, project: string, number: number): Promise<CardRow> {
  return client.get<CardRow>(`/board/cards/by-number/${seg(number)}`, { query: { project }, notFound: `No card #${number} on the ${project || 'No project'} board.` });
}

/** The user's cards: "me" is the token owner (or the person picked as "This is me") of the first connection that knows. */
export async function myCards(client: AlfredClient): Promise<{ who: string; owned: CardRow[]; mentioning: CardRow[] }> {
  const conns = await client.get<{ id: string }[]>('/teamboards/connections').catch(() => [] as { id: string }[]);
  for (const c of conns) {
    const me = await client.get<{ person: { extId: string | null; name: string } } | null>(`/teamboards/connections/${seg(c.id)}/me`).catch(() => null);
    if (!me?.person?.extId) continue;
    const r = await client.get<{ owned: CardRow[]; mentioning: CardRow[] }>(`/board/people/${seg(c.id)}/${seg(me.person.extId)}/cards`, { query: { limit: 200 } });
    return { who: me.person.name, owned: r.owned, mentioning: r.mentioning };
  }
  throw invalid('Nobody is "me" yet - the user enters their token on the Team tab (or picks "This is me").');
}

export async function history(client: AlfredClient, cardId: string): Promise<ActivityRow[]> {
  const out: ActivityRow[] = [];
  for (;;) {
    const page = await client.get<{ entries: ActivityRow[]; total: number }>(`/board/cards/${seg(cardId)}/activity`, { query: { offset: out.length, limit: 1000 } });
    out.push(...page.entries);
    if (!page.entries.length || out.length >= page.total) return out;
  }
}

function hitLine(ctx: MaskContext, h: SearchHit): Record<string, unknown> {
  return {
    card: `${h.project || '(No project)'} ${line(h)}`,
    project: h.project,
    number: h.number,
    updatedAt: h.updatedAt,
    ...(h.lastComment ? { lastComment: entryLine(ctx, h.lastComment, -1, 1500).replace(/board_get entry=-1/, `board_get ${JSON.stringify({ project: h.project, number: h.number })}`) } : {}),
  };
}

function changeLine(ctx: MaskContext, e: ChangeRow, parents: ReadonlyMap<number, ActivityRow>): string {
  const parent = e.replyTo != null ? parents.get(e.replyTo) : undefined;
  const annotation = e.kind === 'REACTION' || e.kind === 'COMMENT_EDITED';
  const thread = parent && annotation ? `on ${who(parent.actor)}'s comment "${preview(stripLabel(parent.text), 120, 'board_get')}": `
    : parent
    ? (isQuestion(parent) && e.actor === 'USER' ? `ANSWERS your question "${preview(stripLabel(parent.text), 120, 'board_get')}": `
      : `↳ reply to ${who(parent.actor)} "${preview(stripLabel(parent.text), 120, 'board_get')}": `)
    : '';
  return `${e.project || '(No project)'} #${e.number} "${e.title}" (${e.status}) - ${thread}${entryLine(ctx, e, -1, 1500)
    .replace(/board_get entry=-1/, `board_get ${JSON.stringify({ project: e.project, number: e.number })}`)}`;
}

export function stripLabel(text: string | null): string {
  return (text ?? '').replace(/\n*```(questions|answers)[ \t]*\n[\s\S]*?\n```[ \t]*$/gm, '')
    .replace(/^\*\*(Did|Found|Next|Impact|Reply|Question|Answers|Withdrawn)\*\*\s*/, '').replace(/\s+/g, ' ').trim();
}

/** The comments the replies in a page of changes answer, read once per card. */
export async function parentsOf(client: AlfredClient, page: ChangesPage): Promise<Map<number, ActivityRow>> {
  const out = new Map<number, ActivityRow>();
  const cards = [...new Set(page.entries.filter((e) => e.replyTo != null && e.cardId).map((e) => e.cardId!))];
  for (const cardId of cards.slice(0, 20)) {
    for (const e of await history(client, cardId).catch(() => [] as ActivityRow[])) if (e.id != null) out.set(e.id, e);
  }
  return out;
}

export function changesReply(ctx: MaskContext, page: ChangesPage, parents: ReadonlyMap<number, ActivityRow>): Record<string, unknown> {
  const entries = page.entries.map((e) => changeLine(ctx, e, parents));
  const cycles = page.cycles.map((c) => `${c.at} cycle ${c.cycleId}: ${c.what}${c.name ? ` ${c.name}` : ''}${c.detail ? ` (${c.detail})` : ''}`);
  const chats = chatChangeLines(ctx, page);
  // Read by the terminal session: ⚡ act on it before the next step; the rest is context only.
  const fromChat = (page.fromChat ?? []).map((t) => `${t.urgent ? '⚡' : '💬'} ${preview(t.text, 1500, 'chat_read')}`);
  const fitted = fitItems(entries, 600 + JSON.stringify(cycles).length + JSON.stringify(chats).length + JSON.stringify(fromChat).length);
  const cut = fitted.cut || page.more;
  return {
    changes: fitted.items,
    cycleChanges: cycles,
    ...(chats.length ? { chats } : {}),
    ...(fromChat.length ? { fromChat } : {}),
    cursor: fitted.cut ? `${page.entries[fitted.items.length - 1].id}.${page.cursor.split('.').slice(1).join('.') || '0'}` : page.cursor,
    ...(cut ? { more: 'More changes - call again with this cursor.' } : {}),
    ...(entries.length === 0 && cycles.length === 0 && chats.length === 0 ? { nothing: 'No changes after the cursor.' } : {}),
    ...maskMeta(ctx),
  };
}

export function register(server: McpServer, client: AlfredClient): void {
  // ------------------------------------------------------------------------------------------------------------ reading

  server.registerTool('board_short_name', {
    description: 'Give a card or an Acceptance item the few words every mention of it reads (specs/021): "All Agencies untested" makes '
      + 'each mention of card #47 read "All Agencies untested (#47)"; "one-branch search" makes AC8 read "one-branch search (AC8)". '
      + 'Without one, a mention reads the title / item text cut to its first words. You may name only what has no short name yet - the '
      + 'user changes it after that. Name each card you add (board_add shortName) and each Acceptance item you write evidence for.',
    inputSchema: {
      project: Project,
      number: CardNumber.optional().describe('A card'),
      cycleId: z.string().optional().describe('The cycle of the Acceptance item'),
      ac: z.number().int().min(1).optional().describe('The Acceptance item: AC<n> as board_requirements lists them'),
      shortName: z.string().min(1).max(60),
    },
  }, (input) => run(async () => {
    if ((input.number === undefined) === (input.ac === undefined)) throw invalid('Name either a card (number) or an Acceptance item (cycleId + ac).');
    if (input.number !== undefined) {
      const card = await cardByNumber(client, input.project, input.number);
      const named = await client.put<CardRow>(`/board/cards/${seg(card.id)}/short-name`, { ...AS_CLAUDE, body: { shortName: input.shortName } });
      return ok({ named: `#${named.number}`, mentionedAs: `${input.shortName.trim()} (#${named.number})` });
    }
    if (!input.cycleId) throw invalid('An Acceptance item needs its cycleId.');
    const items = (await client.get<{ items: { fileName: string; itemKey: string; text: string }[] }>(`/board/cycles/${seg(input.cycleId)}/requirements`)).items;
    const item = items[input.ac! - 1];
    if (!item) throw invalid(`There is no AC${input.ac} - the cycle has ${items.length} Acceptance items.`);
    await client.put(`/board/cycles/${seg(input.cycleId)}/requirements/short-name`, { ...AS_CLAUDE, body: { fileName: item.fileName, itemKey: item.itemKey,
      shortName: input.shortName } });
    return ok({ named: `AC${input.ac}`, mentionedAs: `${input.shortName.trim()} (AC${input.ac})` });
  }));

  server.registerTool('board_list', {
    description: 'Cards on one project\'s task board (or one cycle\'s): "#n KIND [flags] {teams} title - status (cycle) · calls: in:<id8>…" (the calls '
      + 'among its first mentions, ids shortened - board_get has them all). Use board_search to look across every board.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional().describe('Only this session cycle\'s cards (any project)'),
      status: z.array(Status).optional(),
      kind: z.array(Kind).optional(),
      flag: z.array(Flag).optional(),
      team: z.array(z.string()).optional().describe('Only cards of any of these team ids; "-" for cards with no team'),
      limit: z.number().int().min(1).max(500).default(200),
    },
  }, (input) => run(async () => {
    const page = await client.get<{ cards: CardRow[]; total: number; counts: { open: number; fixed: number; done: number } }>('/board/cards', {
      query: { project: input.project, cycleId: input.cycleId, status: input.status?.join(','), kind: input.kind?.join(','),
        flag: input.flag?.join(','), team: input.team?.join(','), limit: input.limit },
    });
    const fitted = fitItems(page.cards.map((c) => `${line(c)}${callsOf(c)}`), 300);
    return ok({ cards: fitted.items, total: page.total, progress: page.counts, ...(fitted.cut ? { more: 'Narrow it with status/kind/flag.' } : {}) });
  }));

  server.registerTool('board_search', {
    description: 'Cards across EVERY board (or one project / cycle), each with its latest comment - start here in a new session: '
      + 'mine=true with status [TO_DO, IN_PROGRESS] is "what was I working on". Filters: text, status, kind, flag, team, author, changed since.',
    inputSchema: {
      project: z.string().optional().describe('One project; omit for every board'),
      cycleId: z.string().optional(),
      text: z.string().max(300).optional().describe('Words in the title or description'),
      status: z.array(Status).optional(),
      kind: z.array(Kind).optional(),
      flag: z.array(Flag).optional(),
      team: z.array(z.string()).optional().describe('Only cards of any of these team ids; "-" for cards with no team'),
      author: z.enum(['USER', 'CLAUDE']).optional(),
      mine: z.boolean().default(false).describe('Only cards Claude created or wrote on'),
      me: z.boolean().default(false).describe('Only cards the user ("me" on the Team tab) owns or is mentioned on'),
      since: z.string().optional().describe('ISO time: only cards changed since'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    if (input.me) {
      const mine = await myCards(client);
      const keep = (c: CardRow) => (!input.project || c.project === input.project) && (!input.status?.length || input.status.includes(c.status as never));
      return ok({ me: mine.who, owned: mine.owned.filter(keep).map(line), mentioning: mine.mentioning.filter(keep).map(line) });
    }
    const page = await client.get<{ cards: SearchHit[]; total: number }>('/board/search', {
      query: { project: input.project, cycleId: input.cycleId, q: input.text, status: input.status?.join(','), kind: input.kind?.join(','),
        flag: input.flag?.join(','), team: input.team?.join(','), author: input.author, claudeTouched: input.mine || undefined,
        since: input.since, offset: input.offset, limit: input.limit },
    });
    const rows = page.cards.map((h) => hitLine(ctx, h));
    const fitted = fitItems(rows, 300);
    const next = input.offset + fitted.items.length;
    return ok({ cards: fitted.items, total: page.total, ...(next < page.total ? { nextOffset: next } : {}), ...maskMeta(ctx) });
  }));

  server.registerTool('board_get', {
    description: 'One card in full: description, Linked list, every mention with the tool that opens it, the open proposal, and the history '
      + 'oldest first with every comment complete; a reply shows "↳ reply to [i]" (the comment it answers) and a question of yours shows '
      + 'whether the user answered it (openQuestions lists the open ones). Long history continues at nextHistoryOffset; a comment longer than 6000 characters is read '
      + 'in parts with entry=<its index> (and entryOffset). Read it before you continue work on a card.',
    inputSchema: {
      project: Project,
      number: CardNumber,
      offset: z.number().int().min(0).default(0).describe('Where to continue a long description'),
      historyOffset: z.number().int().min(0).default(0).describe('First history entry to show'),
      entry: z.number().int().min(0).optional().describe('Read just this history entry\'s text (its index), in parts'),
      entryOffset: z.number().int().min(0).default(0),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const card = await cardByNumber(client, input.project, input.number);
    const [entries, states] = await Promise.all([history(client, card.id), questionStates(client, card.id)]);
    if (input.entry !== undefined) {
      const e = entries[input.entry];
      if (!e) throw invalid(`Card #${card.number} has ${entries.length} history entries (0 to ${entries.length - 1}).`);
      return ok({ card: line(card), entry: input.entry, at: e.at, by: who(e.actor), kind: e.kind, text: chunkText(maskText(ctx, e.text ?? ''), input.entryOffset, 12_000) });
    }
    const description = chunkText(maskText(ctx, card.description ?? ''), input.offset, 5000);
    const seen = new Map<string, { type: string; ref: string; label: string }>();
    for (const m of [...mentionsIn(card.description), ...(card.links ?? []), ...entries.flatMap((e) => mentionsIn(e.text))]) {
      const key = `${m.type.toLowerCase()}:${m.ref}`;
      if (!seen.has(key)) seen.set(key, { type: m.type.toLowerCase(), ref: m.ref, label: m.label });
    }
    const mentions = [...seen.values()].map((m) => `${m.type} ${m.ref} - ${maskText(ctx, m.label)} → ${openWith(m.type, m.ref)}`);
    const shownMentions = mentions.slice(0, 40);
    const owner = await client.get<{ owner: string | null }>(`/board/cards/${seg(card.id)}/owner`).then((o) => o.owner).catch(() => null);
    const head = {
      card: line(card),
      scope: card.scope,
      ...(owner ? { owner: `${owner.slice(owner.indexOf('|') + 1)} (${owner.slice(0, owner.indexOf('|'))})` } : {}),
      ...(card.proposal ? { proposal: `${target(card.proposal)}: ${maskText(ctx, card.proposal.reason)}${card.proposal.evidence ? ` - ${maskText(ctx, card.proposal.evidence)}` : ''}` } : {}),
      description,
      links: (card.links ?? []).map((l) => `${l.type.toLowerCase()} ${l.ref} - ${maskText(ctx, l.label)}`),
      mentions: shownMentions,
      ...(mentions.length > shownMentions.length ? { moreMentions: `${mentions.length - shownMentions.length} more - board_evidence lists them all` } : {}),
      ...(openQuestionIndexes(entries, states).length ? { openQuestions: openQuestionIndexes(entries, states) } : {}),
      ...(card.specItems?.length ? { specItems: card.specItems.map((i) => `${i.fileName} [${i.itemKey}] ${i.text ?? '(item gone)'}`) } : {}),
    };
    const indexOf = new Map(entries.map((e, i) => [e.id, i]));
    const answered = new Set(entries.filter((e) => e.actor === 'USER' && e.replyTo != null).map((e) => e.replyTo));
    const lines = entries.slice(input.historyOffset).map((e, n) => {
      const i = input.historyOffset + n;
      const under = e.answers != null && e.answers !== e.replyTo ? ` answering [${indexOf.get(e.answers) ?? '?'}]` : '';
      const thread = e.replyTo != null ? `↳ reply to [${indexOf.get(e.replyTo) ?? '?'}]${under} ` : '';
      const state = questionNote(e, states, answered);
      return `[${i}] ${thread}${entryLine(ctx, e, i)}${state}`;
    });
    const fitted = fitItems(lines, JSON.stringify(head).length + 400);
    const next = input.historyOffset + fitted.items.length;
    return ok({ ...head, history: fitted.items, historyTotal: entries.length,
      ...(next < entries.length ? { nextHistoryOffset: next } : {}), ...maskMeta(ctx) });
  }));

  server.registerTool('board_evidence', {
    description: 'Opens every mention on a card (description, comments, links) in one call: the call\'s method/url/status, the SQL of a '
      + 'statement, a log line, a Redis command, a spec section, a card\'s state. Gone items say so.',
    inputSchema: { project: Project, number: CardNumber, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(40).default(20), mask: MaskSchema },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const card = await cardByNumber(client, input.project, input.number);
    const entries = await history(client, card.id);
    const seen = new Map<string, { type: string; ref: string; label: string }>();
    for (const m of [...mentionsIn(card.description), ...(card.links ?? []), ...entries.flatMap((e) => mentionsIn(e.text))]) {
      const key = `${m.type.toLowerCase()}:${m.ref}`;
      if (!seen.has(key)) seen.set(key, { type: m.type.toLowerCase(), ref: m.ref, label: m.label });
    }
    const all = [...seen.values()];
    const page = all.slice(input.offset, input.offset + input.limit);
    const resolved = [];
    for (const m of page) resolved.push({ mention: serializeMention(m as never), ...(await resolve(client, ctx, m.type, m.ref)), open: openWith(m.type, m.ref) });
    const fitted = fitItems(resolved, 400);
    const next = input.offset + fitted.items.length;
    return ok({ card: line(card), evidence: fitted.items, total: all.length, ...(next < all.length ? { nextOffset: next } : {}), ...maskMeta(ctx) });
  }));

  server.registerTool('board_for_call', {
    description: 'The cards that already mention a call - check before board_add, and to find the work related to a call you are investigating.',
    inputSchema: { callIds: z.array(z.string().min(1)).min(1).max(100).describe('Call ids (live or captured in a cycle)') },
  }, (input) => run(async () => {
    const badges = await client.get<Record<string, { project: string; number: number; kind: string; status: string; resolution: string | null; title?: string }[]>>(
      '/board/call-badges', { query: { callIds: input.callIds.join(',') } });
    const calls = input.callIds.map((id) => ({
      callId: id,
      cards: (badges[id] ?? []).map((b) => `${b.project || '(No project)'} #${b.number} ${b.kind} ${b.title ?? ''} - ${b.status}${b.resolution ? ` (${b.resolution})` : ''}`.replace(/\s+-/, ' -')),
    }));
    return ok({ calls });
  }));

  server.registerTool('board_similar', {
    description: 'Cards (open or closed, any board unless project is given) with the same signature as a call, or sharing words with a title - '
      + 'read before board_add so a finding joins the card it belongs to instead of repeating it.',
    inputSchema: {
      project: z.string().optional(),
      title: z.string().max(300).optional(),
      call: z.string().max(1000).optional().describe('A call ref: in:<id>, out:<id>, in:<id>@<cycleId>'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  }, (input) => run(async () => {
    if (!input.title && !input.call) throw invalid('Give a title, a call or both.');
    const similar = await client.get<{ why: string; card: CardRow }[]>('/board/similar', { query: { project: input.project, title: input.title, call: input.call, limit: input.limit } });
    return ok({ similar: similar.map((s) => `${s.card.project || '(No project)'} ${line(s.card)} - ${s.why}`), ...(similar.length ? {} : { none: 'No similar card.' }) });
  }));

  server.registerTool('board_changes', {
    description: 'What changed after a cursor: every comment, move, flag, link and proposal with its card, plus briefs, spec files and '
      + 'checklist marks written in cycles. cursor "claude" = since your own last entry (how a new session catches up); "now" = start here. '
      + 'by USER shows only what the user did. Pass the returned cursor next time.',
    inputSchema: {
      cursor: z.string().max(100).default('claude'),
      project: z.string().optional(),
      cycleId: z.string().optional(),
      by: z.enum(['USER', 'CLAUDE']).optional(),
      limit: z.number().int().min(1).max(500).default(200),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const page = await client.get<ChangesPage>('/board/changes', { query: { cursor: input.cursor, project: input.project, cycleId: input.cycleId, actor: input.by, limit: input.limit } });
    const live = await liveAnswerer(client, input.project);
    return ok({ ...changesReply(ctx, page, await parentsOf(client, page)),
      ...(live ? { live: `${answererText(live)} - only note these changes; do not reply to them` } : {}) });
  }));

  server.registerTool('board_wait', {
    description: 'Waits (up to timeoutSeconds, at most 50) until the board changes after the cursor - the user comments, moves a card, answers a '
      + 'question, accepts a proposal - then returns what changed. Woken by the board\'s own change signal, no polling. Call it again with the '
      + 'returned cursor to keep listening; with wait_for_calls you can listen to a cycle and to the user at once.',
    inputSchema: {
      cursor: z.string().max(100).default('now'),
      project: z.string().optional(),
      cycleId: z.string().optional(),
      by: z.enum(['USER', 'CLAUDE']).default('USER'),
      timeoutSeconds: z.number().int().min(1).max(50).default(45),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const page = await client.get<ChangesPage>('/board/changes/wait', {
      query: { cursor: input.cursor, project: input.project, cycleId: input.cycleId, actor: input.by, timeoutSeconds: input.timeoutSeconds },
      timeoutMs: (input.timeoutSeconds + 10) * 1000,
    });
    const live = await liveAnswerer(client, input.project);
    return ok({ ...changesReply(ctx, page, await parentsOf(client, page)),
      ...(live ? { live: `${answererText(live)} - only note these changes; do not reply to them` } : {}) });
  }));

  server.registerTool('board_closed_reasons', {
    description: 'What the user already dismissed on this project\'s board - closed cards with their resolution, reason and signature. Read before reporting, '
      + 'and do not raise an issue closed as FINE or NOT_IN_FLOW again. A long list comes in pages: call again with nextOffset as offset.',
    inputSchema: {
      project: Project,
      offset: z.number().int().min(0).default(0).describe('Where to continue a long list (the nextOffset of the last page)'),
      limit: z.number().int().min(1).max(500).default(200).describe('At most this many per page; fewer when they would not fit one reply'),
    },
  }, (input) => run(async () => {
    // The backend takes no offset: it answers up to 500 closed cards and the pages are cut here.
    const reasons = await client.get<{ number: number; title: string; signature: string | null; resolution: string; reason: string | null }[]>(
      '/board/closed-reasons', { query: { project: input.project, limit: CLOSED_MAX } });
    const rows = reasons.slice(input.offset, input.offset + input.limit)
      .map((r) => `#${r.number} ${r.title} - ${r.resolution}${r.reason ? `: ${r.reason}` : ''}${r.signature ? ` [${r.signature}]` : ''}`);
    const fitted = fitItems(rows, 400);
    const next = input.offset + fitted.items.length;
    return ok({ closed: fitted.items, total: reasons.length, ...(next < reasons.length ? { nextOffset: next } : {}),
      ...(reasons.length >= CLOSED_MAX ? { note: `Alfred answers at most ${CLOSED_MAX} closed cards; older ones are not listed here.` } : {}) });
  }));

  server.registerTool('get_brief', {
    description: 'A session cycle\'s brief (what it is for, the task, the steps), its spec files, and its cards with each one\'s latest comment.',
    inputSchema: { cycleId: z.string().min(1), mask: MaskSchema },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const [brief, specs, cards, steps] = await Promise.all([
      client.get<{ text: string; updatedAt: string | null; updatedBy?: string }>(`/board/cycles/${seg(input.cycleId)}/brief`),
      client.get<{ name: string; size: number; uploadedAt: string }[]>(`/board/cycles/${seg(input.cycleId)}/specs`),
      client.get<{ cards: SearchHit[]; total: number }>('/board/search', { query: { cycleId: input.cycleId, limit: 100 } }).catch(() => ({ cards: [], total: 0 })),
      client.get<StepRow[]>(`/board/cycles/${seg(input.cycleId)}/steps`).catch(() => [] as StepRow[]),
    ]);
    const comments = await client.get<BriefCommentRow[]>(`/board/cycles/${seg(input.cycleId)}/brief/comments`).catch(() => [] as BriefCommentRow[]);
    const briefText = chunkText(maskText(ctx, brief.text || '(no brief yet)'), 0, 6000);
    const rows = cards.cards.map((h) => hitLine(ctx, h));
    const fitted = fitItems(rows, JSON.stringify(briefText).length + 800);
    return ok({
      brief: briefText.nextOffset === null ? briefText.text : `${briefText.text}… (${briefText.totalLength} chars; the rest is in the cycle's Brief tab)`,
      updatedAt: brief.updatedAt,
      ...(brief.updatedBy === 'CLAUDE' ? { writtenBy: 'Claude (the user can Restore previous)' } : {}),
      ...(steps.length ? { testSteps: steps.map(stepLine) } : {}),
      ...(comments.length ? { comments: briefThreads(comments, (t) => maskText(ctx, t)) } : {}),
      specFiles: specs.map((s) => `${s.name} (${s.size} bytes)`),
      cards: fitted.items,
      cardsTotal: cards.total,
      ...(fitted.cut || cards.total > rows.length ? { moreCards: `board_search ${JSON.stringify({ cycleId: input.cycleId, offset: fitted.items.length })}` } : {}),
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('board_brief_comment', {
    description: 'Comments on a cycle\'s brief (specs/024; the user reads them in the Task tab\'s Brief margin). Comment on a passage (quote: '
      + 'the exact words of the brief) or on the whole brief; reply to a thread (replyTo: any comment id of it - get_brief lists them); '
      + 'ask the user (asks: true - shown as a question in Needs you); or suggest a rewording of a passage (suggestFrom: the exact words '
      + 'as the brief holds them, suggestTo: the new wording) - the brief changes only when the user clicks Apply. You never resolve, '
      + 'apply or dismiss: those are the user\'s.',
    inputSchema: {
      cycleId: z.string().min(1),
      text: z.string().min(1).max(16_000),
      quote: z.string().max(2000).optional().describe('The passage this comment is about, exactly as the brief has it; leave out for the whole brief'),
      replyTo: z.number().int().optional(),
      asks: z.boolean().default(false),
      suggestFrom: z.string().max(2000).optional(),
      suggestTo: z.string().max(2000).optional(),
    },
  }, (input) => run(async () => {
    if ((input.suggestFrom == null) !== (input.suggestTo == null)) {
      return ok({ error: 'A suggestion needs both suggestFrom (the words as written) and suggestTo (the new wording).' });
    }
    const out = await client.post<{ comment: BriefCommentRow }>(`/board/cycles/${seg(input.cycleId)}/brief/comments`, { ...WRITE, body: {
      quote: input.quote ?? null, text: input.text, replyTo: input.replyTo ?? null, asks: input.asks,
      suggestFrom: input.suggestFrom ?? null, suggestTo: input.suggestTo ?? null,
    } });
    return ok({ comment: out.comment.id, thread: out.comment.replyTo ?? out.comment.id,
      ...(out.comment.suggestTo ? { note: 'The user applies or dismisses the suggestion in the Brief tab.' } : {}) });
  }));

  server.registerTool('read_spec', {
    description: 'A spec file of a cycle, or one section of it (the heading\'s text or slug), plus the acceptance checklist: the user\'s marks and your suggestions.',
    inputSchema: {
      cycleId: z.string().min(1),
      name: z.string().min(1),
      section: z.string().optional(),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => run(async () => {
    const text = await client.get<string>(`/board/cycles/${seg(input.cycleId)}/specs/${seg(input.name)}`, { text: true, notFound: `No spec file ${input.name} in this cycle.` });
    const checklist = await client.get<{ fileName: string; items: { key: string; text: string; mark: { mark: string; evidence: string } | null; suggestion?: { mark: string; evidence: string } | null; cards?: { number: number }[] }[] }[]>(
      `/board/cycles/${seg(input.cycleId)}/checklist`).catch(() => []);
    const body = input.section ? sectionOf(text, input.section) : text;
    const items = checklist.find((f) => f.fileName === input.name)?.items ?? [];
    return ok({
      spec: chunkText(body, input.offset, 10_000),
      checklist: items.map((i) => `[${i.key}] ${i.mark ? i.mark.mark : 'UNMARKED'} - ${i.text}${i.mark?.evidence ? ` (evidence: ${i.mark.evidence})` : ''}`
        + `${i.cards?.length ? ` · cards ${i.cards.map((c) => `#${c.number}`).join(', ')}` : ''}`
        + `${i.suggestion ? ` · you suggested ${i.suggestion.mark}, waiting for the user` : ''}`),
    });
  }));

  server.registerTool('board_verify', {
    description: 'Re-tests Fixed cards (specs/016): every call to a card\'s endpoint since its fix - or only a re-test cycle\'s calls when you '
      + 'pass cycleId - checked against the card\'s expectations (SQL count, status, log lines, duration, response), with the original call\'s '
      + 'value beside each. Verdicts: PASSES, PARTIAL (a step not done yet, or a duration needs more calls), FLAKY, FAILS, NO_CALLS, '
      + 'NOT_CHECKABLE. All Fixed cards, or only numbers. record=true keeps each card\'s re-test in its history and returns the report '
      + '(Markdown). apply=true also proposes Verified on PASSES and comments on FAILS / FLAKY - the user accepts. With a task\'s cycleId '
      + 'the reply also has the task\'s requirement verdicts by the calls (specs/018): a task is not done while an item is MISSING or WRONG, '
      + 'whatever the cards say.',
    inputSchema: {
      project: Project,
      numbers: z.array(CardNumber).max(100).default([]).describe('Only these cards; empty = every Fixed card'),
      cycleId: z.string().optional().describe('A re-test cycle; omit to use the live calls since each fix'),
      record: z.boolean().default(false),
      apply: z.boolean().default(false),
      implemented: z.array(z.object({
        number: CardNumber,
        verdict: z.enum(['implemented', 'not_on_branch', 'not_in_build', 'layer_missing', 'reverted', 'tests_fail', 'unknown']),
        commit: z.string().max(200).optional().describe('The fix\'s commit (from board_fix)'),
        branch: z.string().max(200).optional().describe('The task branch you checked it on'),
        layers: z.array(z.object({ team: z.string().max(80), where: z.string().max(400).describe('file:line of its change, or what is missing'),
          ok: z.boolean(), note: z.string().max(400).optional() })).max(12).optional(),
        tests: z.string().max(400).optional().describe('The fix\'s tests you ran and their result'),
        note: z.string().max(1000).optional(),
      })).max(100).optional().describe('Is each fix implemented (specs/026) - what YOU found in the code and git before judging the calls: the '
        + 'commit on the task branch, in the running build (app started after it), every layer of the card\'s teams changed, nothing '
        + 'reverted, its tests. Recorded on the card beside the calls\' verdict; a card is ready for Verified only when it is implemented AND worked.'),
    },
  }, (input) => run(async () => {
    for (const code of input.implemented ?? []) {
      const card = await cardByNumber(client, input.project, code.number);
      await client.put(`/board/cards/${seg(card.id)}/code-check`, { ...AS_CLAUDE, body: { ...code, verdict: code.verdict.toUpperCase() } });
    }
    let checks: RetestCheckRow[];
    let report: string | undefined;
    if (input.record || input.apply) {
      const r = await client.post<{ checks: RetestCheckRow[]; markdown: string }>('/board/retest/run', { ...AS_CLAUDE,
        body: { project: input.project, numbers: input.numbers, cycleId: input.cycleId } });
      checks = r.checks;
      report = r.markdown;
    } else {
      const r = await client.get<{ checks: RetestCheckRow[] }>('/board/retest', { query: { project: input.project,
        numbers: input.numbers.join(','), ...(input.cycleId ? { cycleId: input.cycleId } : {}) } });
      checks = r.checks;
    }
    const source = input.cycleId ? `re-test cycle ${input.cycleId}` : 'live calls since the fix';
    const done: string[] = [];
    if (input.apply) {
      for (const c of checks) {
        const card = await cardByNumber(client, input.project, c.number);
        const evidence = c.calls.slice(0, 10).map((x) => serializeMention({ type: 'call', ref: x.ref, label: x.label })).join(' ');
        const impl = c.code?.verdict;
        if (impl && impl !== 'IMPLEMENTED' && impl !== 'UNKNOWN') {
          await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: {
            did: `Checked the code and re-tested from ${source}`, found: `Not implemented: ${implementedLine(c.code)}\n\nCalls: ${c.verdict} - ${c.summary}`,
            next: readiness(c), waitingOn: impl === 'NOT_IN_BUILD' || impl === 'NOT_ON_BRANCH' ? 'USER' : 'CLAUDE' } });
          done.push(`#${c.number} commented not implemented (${impl})`);
        } else if (c.verdict === 'PASSES') {
          const unchecked = !c.code || impl === 'UNKNOWN';
          await client.put(`/board/cards/${seg(card.id)}/proposal`, { ...AS_CLAUDE, body: { status: 'VERIFIED',
            reason: `${unchecked ? 'Worked - code not checked' : 'Implemented and worked'}. Re-test from ${source}: ${c.summary}`
              + `${c.code ? ` · ${implementedLine(c.code)}` : ''}`, evidence } });
          done.push(`#${c.number} proposed Verified${unchecked ? ' (code not checked)' : ''}`);
        } else if (c.verdict === 'FAILS' || c.verdict === 'FLAKY') {
          await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: {
            did: `Re-tested from ${source}`, found: `${c.verdict === 'FLAKY' ? 'Flaky' : 'Still failing'}: ${c.summary}\n\n${evidence}`,
            next: 'Investigate the failing call and fix again', waitingOn: 'CLAUDE' } });
          done.push(`#${c.number} commented ${c.verdict === 'FLAKY' ? 'flaky' : 'still failing'}`);
        }
      }
    }
    const rows = checks.map(retestLine);
    const task = input.cycleId ? await taskVerdict(client, input.cycleId) : null;
    const fitted = fitItems(rows, 400 + JSON.stringify(done).length + (report?.length ?? 0) + (task?.length ?? 0));
    return ok({ source, checks: fitted.items, total: checks.length, ...(checks.length ? {} : { none: 'No Fixed card was re-tested - verify covers Fixed cards' }),
      ...(task ? { task } : {}), ...(report ? { report } : {}), ...(input.apply ? { applied: done } : {}),
      ...(fitted.cut ? { more: 'Some checks did not fit - pass numbers.' } : {}) });
  }));

  /** The task's state by the calls, in one line: "not done - 5 missing, 2 no data, …" (null when the cycle has no requirement check). */
  async function taskVerdict(c: AlfredClient, cycleId: string): Promise<string | null> {
    const view = await readRequirements(c, cycleId).catch(() => null);
    if (!view || !view.items.length) return null;
    const open = (view.counts.MISSING ?? 0) + (view.counts.WRONG ?? 0);
    const unproven = view.items.length - (view.counts.MET ?? 0);
    return `${open ? 'NOT DONE' : unproven ? 'not proven yet' : 'every item met by the calls'} - ${countsLine(view)} (board_requirements has each item)`;
  }

  server.registerTool('board_retest', {
    description: 'One card\'s re-test: its plan (expectations and steps, who wrote it), its check against the live calls since the fix (or a '
      + 're-test cycle), and its re-test history. Works for any status - a Verified / Done card with expectations is a guard.',
    inputSchema: { project: Project, number: CardNumber, cycleId: z.string().optional() },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const r = await client.get<{ plan: RetestPlanRow; check: RetestCheckRow; history: RetestRunRow[]; lastStart: string | null }>(
      `/board/cards/${seg(card.id)}/retest`, { query: input.cycleId ? { cycleId: input.cycleId } : {} });
    return ok({
      check: retestLine(r.check),
      plan: { expectations: r.plan.expectations, steps: r.plan.steps, ...(r.plan.updatedBy ? { by: who(r.plan.updatedBy) } : { none: 'No plan - board_retest_plan writes one' }) },
      history: r.history.map((h) => `${h.at} ${h.verdict} · ${h.calls} calls · ${h.source} · ${h.summary}`),
      ...(r.lastStart ? { appStarted: r.lastStart } : {}),
    });
  }));

  server.registerTool('board_retest_plan', {
    description: 'Write how a card\'s fix is re-tested (replaces the plan): expectations every call to its endpoint is checked against, and the '
      + 'steps a person follows. Kinds: SQL_COUNT {table, max} (an N+1), STATUS {range: "2xx" | "200" | "!405" | "!5xx"}, NO_LOG {level: '
      + 'ERROR | WARN}, DURATION {max ms, minCalls (default 3)}, SAME_RESPONSE {path: "$.countries.length"} (the value the original call '
      + 'had). A step names the endpoint ("POST /Admin2/agency/by-branch") whose call shows it was done - exactly as a recorded call '
      + 'has it, never guessed - or none for the card\'s own; `request` says what that call must send for the step to count '
      + '({path: "$.branchIds", shape: "has:-11"}), so an old call that hit the path with another body does not tick it. A step naming '
      + 'an endpoint no recorded call ever hit comes back in `warnings` with the closest recorded one - fix it.',
    inputSchema: { project: Project, number: CardNumber, expect: ExpectList, steps: StepList },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const plan = await client.put<RetestPlanRow>(`/board/cards/${seg(card.id)}/retest-plan`, { ...AS_CLAUDE, body: { expectations: input.expect, steps: input.steps } });
    return ok({ saved: `#${card.number}`, expectations: plan.expectations.length, steps: plan.steps.length,
      ...(plan.warnings?.length ? { warnings: plan.warnings, next: 'Correct those endpoints with board_retest_plan' } : {}) });
  }));

  // ------------------------------------------------------------------------------------------------------------ writing

  server.registerTool('board_add', {
    description: 'Put a finding on the board. It always lands in the Inbox for the user to sort. Mention evidence in the description as '
      + '@[type:ref|label] (e.g. @[call:in:<id>|POST /orders · 500], @[stmt:<callId>/<seq>|INSERT ORDERS #88]) and pass the main call in links. '
      + 'Check board_similar / board_for_call first. Refused while the user paused the board, and when the user already closed the same problem '
      + 'as Fine or Not in this flow - the refusal says which card and why. When another open card has the same signature, the reply says so '
      + '(similarOpen): link your evidence to that card or board_propose MERGE. Always pass teams. ' + TEAM_GUIDE + WRITING,
    inputSchema: {
      project: Project,
      kind: Kind,
      title: z.string().min(1).max(300),
      description: z.string().max(256 * 1024).default(''),
      flags: z.array(Flag).default([]),
      teams: Teams.default([]),
      cycleId: z.string().optional(),
      links: z.array(Link).max(100).default([]),
      shortName: ShortName,
    },
  }, (input) => run(async () => {
    const w = new ReadableWriter(client, { project: input.project, cycleId: input.cycleId });
    const description = boardText(await w.text(input.description));
    const card = await client.post<CardRow>('/board/cards', {
      ...WRITE,
      body: { project: input.project, kind: input.kind, title: input.title, description: description.text, flags: input.flags,
        teams: input.teams, cycleId: input.cycleId, links: input.links },
    });
    const named = await nameCard(client, card, input.shortName);
    const similarOpen = similarOpenNote(card);
    return ok({ added: `#${card.number}`, status: card.status, card: line(card), ...snippetNote(description.snippets), ...named,
      ...(card.teams?.length ? {} : { teams: 'none - pick them with board_assign (board_teams lists the teams)' }),
      ...(similarOpen ? { similarOpen } : {}), ...w.report() });
  }));

  server.registerTool('board_add_many', {
    description: 'Several findings from one scan, each like board_add (Inbox, duplicate check, teams). Each one says added or why it was refused; '
      + 'a card another open card repeats says "same signature as open #N" (link to it or board_propose MERGE). When the board is paused the '
      + 'rest are "not attempted"; a create that timed out is looked up on the board before it is called "not added". '
      + 'In the same call, each card can take its first state comment (firstComment: did / found / next / waitingOn - as board_comment) and the '
      + 'Acceptance item it breaks (specItem: fileName + itemKey from read_spec / task_context, in cycleId - as board_link_spec), so a batch of '
      + 'findings is one call instead of three per card.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional(),
      cards: z.array(z.object({
        kind: Kind, title: z.string().min(1).max(300), description: z.string().max(64 * 1024).default(''), flags: z.array(Flag).default([]),
        teams: Teams.default([]), links: z.array(Link).max(50).default([]), shortName: ShortName,
        firstComment: z.object({
          did: z.string().min(1).max(64 * 1024), found: z.string().min(1).max(64 * 1024), next: z.string().min(1).max(64 * 1024), waitingOn: WaitingOn,
        }).optional().describe('The card\'s first state comment, written right after it is added'),
        specItem: z.object({ fileName: z.string().min(1), itemKey: z.string().min(1) }).optional()
          .describe('The Acceptance item this card is about (needs cycleId)'),
      })).min(1).max(30),
    },
  }, (input) => run(async () => {
    const results: string[] = [];
    const addedNow = new Set<number>();
    const w = new ReadableWriter(client, { project: input.project, cycleId: input.cycleId });
    for (let i = 0; i < input.cards.length; i++) {
      const { firstComment: rawFirst, specItem, shortName, ...rawCard } = input.cards[i];
      const c = { ...rawCard, description: boardText(await w.text(rawCard.description)).text };
      const firstComment = rawFirst && boardTexts({ ...rawFirst, did: await w.text(rawFirst.did), found: await w.text(rawFirst.found),
        next: await w.text(rawFirst.next) }, ['did', 'found', 'next']).body;
      const extra: string[] = [];
      let card: CardRow | undefined;
      try {
        card = await client.post<CardRow>('/board/cards', { ...WRITE, body: { project: input.project, cycleId: input.cycleId, ...c } });
      } catch (error) {
        let message = (error as Error).message;
        let down = false;
        if (outcomeUnknown(error)) {
          // The backend may have finished a create the client stopped waiting for: look before saying "not added" (a retry would repeat it).
          const check = await createdMeanwhile(client, input.project, c, addedNow);
          if (check.card) {
            card = check.card;
            extra.push('the create timed out, but the card is on the board');
          } else if (check.unreachable) {
            down = true;
            message += ' (could not check whether it was saved)';
          } else {
            message += ' (checked the board: no card with this title was saved)';
          }
        }
        if (!card) {
          results.push(`not added "${c.title}": ${message}`);
          // The code decides, not the words: a title that says "paused" must not end the batch.
          const why = error instanceof AlfredError && error.code === 'paused' ? 'board paused' : down ? 'Alfred is not answering' : null;
          if (why) {
            results.push(...input.cards.slice(i + 1).map((rest) => `not attempted: ${why} - "${rest.title}"`));
            break;
          }
          continue;
        }
      }
      addedNow.add(card.number);
      const named = await nameCard(client, card, shortName);
      if (named.shortName) extra.push(`mentioned as "${named.shortName}"`);
      // The card is added: a failed comment or link is said, never a reason to call it not added.
      if (firstComment) {
        await client.post(`/board/cards/${seg(card.id)}/comments`, { ...WRITE, body: firstComment })
          .then(() => extra.push('commented'), (e) => extra.push(`comment not written: ${(e as Error).message}`));
      }
      if (specItem) {
        if (!input.cycleId) extra.push('spec item not linked: give cycleId');
        else await client.post(`/board/cards/${seg(card.id)}/spec-items`, { ...WRITE, body: { cycleId: input.cycleId, ...specItem } })
          .then(() => extra.push(`linked to ${specItem.itemKey}`), (e) => extra.push(`spec item not linked: ${(e as Error).message}`));
      }
      const similarOpen = similarOpenNote(card);
      if (similarOpen) extra.push(similarOpen);
      results.push(`added #${card.number} ${c.title}${card.teams?.length ? ` {${card.teams.join(', ')}}` : ' - no team yet'}${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
    }
    return ok({ results, ...w.report() });
  }));

  server.registerTool('board_comment', {
    description: 'Record progress on a card: what you did, what you found, what comes next, and (when a change touches shared code) its impact. '
      + 'All of did/found/next are needed - another session or the user picks the work up from these. To answer the user use board_reply; to ask, board_ask.' + WRITING,
    inputSchema: {
      project: Project,
      number: CardNumber,
      did: z.string().min(1).max(64 * 1024),
      found: z.string().min(1).max(64 * 1024),
      next: z.string().min(1).max(64 * 1024),
      impact: z.string().max(64 * 1024).optional(),
      replyTo: z.number().int().min(0).optional().describe('Put it under this comment ([index] from board_get), e.g. the user\'s request it reports on'),
      waitingOn: WaitingOn,
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const replyTo = input.replyTo === undefined ? undefined : await commentIdAt(client, card, input.replyTo);
    const w = writerFor(client, card);
    const parts = boardTexts({ did: await w.text(input.did), found: await w.text(input.found), next: await w.text(input.next),
      impact: input.impact === undefined ? undefined : await w.text(input.impact) }, ['did', 'found', 'next', 'impact']);
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...WRITE,
      body: { ...parts.body, ...(replyTo != null ? { replyTo } : {}), ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}) } });
    return ok({ commented: `#${card.number}`, ...snippetNote(parts.snippets), ...w.report() });
  }));

  server.registerTool('board_reply', {
    description: 'Answer the user on a card in your own words (shown as "Reply" in the history). With replyTo (a comment\'s [index] from '
      + 'board_get) it goes under that comment, in its thread - use it to answer one exact comment. Mentions work: @[call:in:<id>|label].' + WRITING,
    inputSchema: {
      project: Project, number: CardNumber, text: z.string().min(1).max(64 * 1024),
      replyTo: z.number().int().min(0).optional().describe('The [index] of the comment you answer, from board_get'),
      waitingOn: WaitingOn,
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const replyTo = input.replyTo === undefined ? undefined : await commentIdAt(client, card, input.replyTo);
    const w = writerFor(client, card);
    const reply = boardText(await w.text(input.text));
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { reply: reply.text, ...(replyTo != null ? { replyTo } : {}),
      ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}) } });
    return ok({ replied: `#${card.number}`, ...(input.replyTo !== undefined ? { under: `[${input.replyTo}]` } : {}), ...snippetNote(reply.snippets),
      ...w.report() });
  }));

  server.registerTool('board_ask', {
    description: 'Ask the user on a card - the card is flagged Needs decision while any question is open, and the tile says how many. '
      + 'Prefer `questions` (1-4, each with a short header and 2-4 options; "Something else" is always added for the user): for each '
      + 'option say what you will do if it is picked (`then`), mark the one you advise `recommended`, and give a `preview` the user sees '
      + 'on hover - what changes, what it does to the recorded calls, which acceptance items it covers, why. An option\'s `followUp` is '
      + 'asked at once when the user picks it. The user may answer some and leave the rest open or "later": act only on the answered '
      + 'ones. A question already open on the card is not asked twice. `about` / `because` tie the question to a comment (an answer '
      + 'that raised it). Answers arrive in board_wait / board_changes / board_live as an answers block; take a question back with '
      + 'board_withdraw_question.',
    inputSchema: {
      project: Project, number: CardNumber,
      question: z.string().min(1).max(16 * 1024).optional().describe('One free question (no options) - or use `questions`'),
      questions: z.array(AskQuestion).min(1).max(4).optional(),
      about: z.number().int().min(0).optional().describe('The [index] of the comment the questions are about'),
      because: z.object({ entry: z.number().int().min(0).describe('The [index] of the user\'s answer that raised these questions'),
        header: z.string().max(40).optional().describe('Which of its answers') }).optional(),
    },
  }, (input) => run(async () => {
    if (!input.question === !input.questions) throw invalid('Pass either `question` (one free question) or `questions` (with options).');
    const card = await cardByNumber(client, input.project, input.number);
    const entries = input.about !== undefined || input.because ? await history(client, card.id) : [];
    const idAt = (i: number, what: string) => {
      const id = entries[i]?.id;
      if (id == null || entries[i].kind !== 'COMMENT') throw invalid(`${what}: history entry [${i}] of card #${card.number} is not a comment - pass its [index] from board_get.`);
      return id;
    };
    let text: string;
    let snippets = 0;
    const w = writerFor(client, card);
    if (input.questions) {
      const headers = new Set<string>();
      // Every text of the questions made readable first (specs/021) - the building below stays synchronous
      const readableTexts = new Map<string, string>();
      const texts = (q: z.infer<typeof AskFollowUp>): string[] => [q.question, q.why ?? '', ...q.options.flatMap((o) => [o.description ?? '', o.then ?? '',
        o.preview ?? '', ...((o as z.infer<typeof AskOption>).followUp ? texts((o as z.infer<typeof AskOption>).followUp!) : [])])];
      for (const s of input.questions.flatMap((q) => texts(q))) if (s && !readableTexts.has(s)) readableTexts.set(s, await w.text(s));
      const conv = (s: string | undefined) => {
        if (s == null) return undefined;
        const t = boardText(readableTexts.get(s) ?? s);
        snippets += t.snippets;
        return t.text;
      };
      const question = (q: z.infer<typeof AskFollowUp>, followUps: boolean): Record<string, unknown> => {
        const key = q.header.toLowerCase();
        if (headers.has(key)) throw invalid(`Two questions share the header "${q.header}" - give each its own.`);
        headers.add(key);
        if (q.options.length === 1) throw invalid(`Question "${q.header}" has one option - give 2 to 4, or none for a free answer.`);
        if (q.options.filter((o) => o.recommended).length > 1) throw invalid(`Question "${q.header}": mark one option recommended, not more.`);
        if (q.options.some((o) => o.confidence && !o.recommended)) throw invalid(`Question "${q.header}": confidence goes on the recommended option.`);
        const t = q as z.infer<typeof AskQuestion>;
        if (t.group?.includes(card.number)) throw invalid(`Question "${q.header}": group lists the other cards - not #${card.number} itself.`);
        return {
          header: q.header, question: conv(q.question), ...(q.why ? { why: conv(q.why) } : {}), ...(q.multiSelect ? { multiSelect: true } : {}),
          options: q.options.map((o) => ({
            label: o.label, ...(o.description ? { description: conv(o.description) } : {}), ...(o.then ? { then: conv(o.then) } : {}),
            ...(o.recommended ? { recommended: true } : {}), ...(o.recommended && o.confidence ? { confidence: o.confidence } : {}),
            ...(o.preview ? { preview: conv(o.preview) } : {}),
            ...(followUps && (o as z.infer<typeof AskOption>).followUp ? { followUp: question((o as z.infer<typeof AskOption>).followUp!, false) } : {}),
          })),
          ...(followUps && t.checked ? { checked: t.checked } : {}),
          ...(followUps && t.severity ? { severity: t.severity } : {}),
          ...(followUps && t.group?.length ? { group: t.group } : {}),
        };
      };
      const block = {
        ...(input.about !== undefined ? { about: idAt(input.about, 'about') } : {}),
        ...(input.because ? { because: { entry: idAt(input.because.entry, 'because'), ...(input.because.header ? { header: input.because.header } : {}) } } : {}),
        questions: input.questions.map((q) => question(q, true)),
      };
      // An Alfred before specs/019 has no question index and its board would show the block as raw JSON: ask in words there.
      const indexed = await client.get(`/board/cards/${seg(card.id)}/questions`).then(() => true, (e: unknown) => !(e instanceof AlfredError && e.status === 404));
      text = indexed ? `${(block.questions[0].question as string).split('\n')[0]}\n\n\`\`\`questions\n${JSON.stringify(block, null, 2)}\n\`\`\``
        : plainQuestions(block.questions as unknown as PlainQuestion[]);
    } else {
      const t = boardText(await w.text(input.question!));
      snippets += t.snippets;
      text = t.text;
    }
    const saved = await client.post<{ note?: string; entry?: { id?: number } }>(`/board/cards/${seg(card.id)}/comments`, { ...WRITE, body: { question: text } });
    if (saved?.note) return ok({ notAsked: `#${card.number}`, why: saved.note });
    return ok({ asked: `#${card.number}`, questions: input.questions?.length ?? 1, flagged: 'NEEDS_DECISION',
      next: `board_wait ${JSON.stringify({ project: input.project, cursor: 'now' })}`, ...snippetNote(snippets), ...w.report() });
  }));

  server.registerTool('board_withdraw_question', {
    description: 'Take back questions you asked on a card that no longer need an answer - the evidence settled it, another answer covers '
      + 'it, or it repeats one. `reason` is required and shown to the user. Without `headers` every open question of that comment goes; '
      + 'their follow-ups go with them. Needs decision is cleared when nothing is left open.',
    inputSchema: {
      project: Project, number: CardNumber,
      entry: z.number().int().min(0).describe('The [index] of your question comment in board_get'),
      headers: z.array(z.string().min(1).max(40)).max(12).optional(),
      reason: z.string().min(1).max(2000),
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const entries = await history(client, card.id);
    const e = entries[input.entry];
    if (!e || e.id == null || !isQuestion(e)) throw invalid(`History entry [${input.entry}] of card #${card.number} is not one of your questions - pass its [index] from board_get.`);
    await client.post(`/board/cards/${seg(card.id)}/questions/${e.id}/withdraw`, { ...WRITE, body: { headers: input.headers ?? [], reason: input.reason } });
    return ok({ withdrawn: `#${card.number} [${input.entry}]`, ...(input.headers?.length ? { headers: input.headers } : { headers: 'every open one' }) });
  }));

  server.registerTool('board_teams', {
    description: 'The teams cards are assigned to (Settings → Teams): id, name, what each one owns and its hints. Read it before board_add '
      + 'or board_assign - the user can rename, add or delete teams, so never assume the defaults. ' + TEAM_GUIDE,
    inputSchema: {},
  }, () => run(async () => {
    const teams = await client.get<TeamRow[]>('/board/teams');
    return ok({ teams: teams.map((t) => `${t.id}: ${t.icon ? `${t.icon} ` : ''}${t.name} - owns: ${t.owns || '(not described)'}`
      + `${t.hints.length ? ` · hints: ${t.hints.join(', ')}` : ''}`), noTeam: '"-" in a team filter means cards with no team' });
  }));

  server.registerTool('board_image', {
    description: 'A picture shown in a board text - ![alt](/board/images/<id>) in a description, comment, brief or spec - so you can see it '
      + '(a screenshot the user pasted, often marked with boxes and arrows). Pass the id or the whole /board/images/<id> path.',
    inputSchema: { id: z.string().min(8).max(200).describe('The picture id, or its /board/images/<id> path') },
  }, (input) => run(async () => {
    const id = /([A-Za-z0-9-]{8,64})\s*\)?\s*$/.exec(input.id.trim())?.[1];
    if (!id) throw invalid('Not a picture id - pass the <id> of /board/images/<id>.');
    const image = await client.bytes(`/board/images/${seg(id)}`);
    if (!image.mime.startsWith('image/')) throw invalid('That is not a picture.');
    return { content: [{ type: 'image', data: image.data.toString('base64'), mimeType: image.mime }] } as unknown as ToolReply;
  }));

  server.registerTool('board_assign', {
    description: 'Set the teams a card is assigned to - replaces them (pass [] for none). Works on any card, any time: reassign when new '
      + 'evidence moves the work (the SQL is the problem, not the controller). reason is required and goes into the card\'s history, '
      + 'e.g. "INSERT on TT_BOOKING fails - Database". When a card gains a team, add a short "### <Team>" section to its description '
      + '(board_edit, your own Inbox cards) or a comment saying what that team changes. ' + TEAM_GUIDE,
    inputSchema: { project: Project, number: CardNumber, teams: Teams, reason: z.string().min(1).max(2000) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const updated = await client.put<CardRow>(`/board/cards/${seg(card.id)}/teams`, { ...AS_CLAUDE, body: { teams: input.teams, reason: input.reason } });
    return ok({ assigned: `#${updated.number}`, teams: updated.teams?.length ? updated.teams : 'none', card: line(updated) });
  }));

  server.registerTool('board_link', {
    description: 'Add evidence to a card\'s Linked list (a call, statement, log line, spec section, code line, other card...).',
    inputSchema: { project: Project, number: CardNumber, links: z.array(Link).min(1).max(50) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    for (const l of input.links) await client.post(`/board/cards/${seg(card.id)}/links`, { ...WRITE, body: l });
    return ok({ linked: `#${card.number}`, count: input.links.length });
  }));

  server.registerTool('board_unlink', {
    description: 'Remove a link you or the user added directly to a card (a mention in text stays until the text changes).',
    inputSchema: { project: Project, number: CardNumber, type: MentionTypeSchema, ref: z.string().min(1).max(1000) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    await client.del(`/board/cards/${seg(card.id)}/links`, { ...AS_CLAUDE, body: { type: input.type, ref: input.ref } });
    return ok({ unlinked: `#${card.number}` });
  }));

  server.registerTool('board_edit', {
    description: 'Rewrite the title, description, kind or owner of one of YOUR cards while it is still in the Inbox. After the user sorts it, comment instead. '
      + 'owner: "<conn>/<person id>|<name>" from team_people, or "" for none.',
    inputSchema: {
      project: Project, number: CardNumber, title: z.string().min(1).max(300).optional(), description: z.string().max(256 * 1024).optional(),
      kind: Kind.optional(), owner: z.string().max(300).optional(),
    },
  }, (input) => run(async () => {
    if (input.title === undefined && input.description === undefined && input.kind === undefined && input.owner === undefined) {
      throw invalid('Nothing to change - give a title, description, kind or owner.');
    }
    const card = await cardByNumber(client, input.project, input.number);
    if (input.owner !== undefined) await client.put(`/board/cards/${seg(card.id)}/owner`, { ...AS_CLAUDE, body: { owner: input.owner || null } });
    if (input.title === undefined && input.description === undefined && input.kind === undefined) return ok({ edited: line(card), owner: input.owner || 'none' });
    const w = writerFor(client, card);
    const description = input.description === undefined ? undefined : boardText(await w.text(input.description)).text;
    const updated = await client.patch<CardRow>(`/board/cards/${seg(card.id)}`, { ...AS_CLAUDE, body: { title: input.title, description, kind: input.kind } });
    return ok({ edited: line(updated), ...w.report() });
  }));

  server.registerTool('board_move', {
    description: 'Move a card to To do, In progress or Fixed. Verified, Done and closing are the user\'s - propose them with board_propose.',
    inputSchema: { project: Project, number: CardNumber, status: z.enum(['TO_DO', 'IN_PROGRESS', 'FIXED']) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const moved = await client.post<CardRow>(`/board/cards/${seg(card.id)}/move`, { ...AS_CLAUDE, body: { status: input.status } });
    return ok({ moved: line(moved) });
  }));

  server.registerTool('board_fix', {
    description: 'Record a fix on a card and move it to Fixed: what you changed (files and lines become code mentions), the root cause, the '
      + 'commit, the tests you ran, how to verify it, and the impact on shared code.',
    inputSchema: {
      project: Project,
      number: CardNumber,
      summary: z.string().min(1).max(16 * 1024).describe('What you changed'),
      rootCause: z.string().min(1).max(16 * 1024),
      files: z.array(z.object({ path: z.string().min(1).max(500), line: z.number().int().min(1).optional(), note: z.string().max(500).optional() })).max(50).default([]),
      commit: z.string().max(100).optional(),
      tests: z.string().max(8 * 1024).optional().describe('Tests run and their result'),
      verify: z.string().min(1).max(8 * 1024).describe('How the user (or a re-test cycle) confirms it'),
      impact: z.string().max(16 * 1024).optional(),
      expect: ExpectList.describe('What "fixed" means, checked on every call after the fix (see board_retest_plan). Always give at least one.'),
      steps: StepList.describe('What the user does in the app to re-test it'),
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    let plan = '';
    if (input.expect.length || input.steps.length) {
      const saved = await client.put<RetestPlanRow>(`/board/cards/${seg(card.id)}/retest-plan`, { ...AS_CLAUDE, body: { expectations: input.expect, steps: input.steps } });
      plan = `${input.expect.length} expectations, ${input.steps.length} steps${saved?.warnings?.length ? ` - WARNING: ${saved.warnings.join(' ')}` : ''}`;
    }
    const files = input.files.map((f) => {
      const ref = f.line ? `${f.path}:${f.line}` : f.path;
      const name = f.path.split(/[\\/]/).pop() ?? f.path;
      return `${serializeMention({ type: 'code', ref, label: f.line ? `${name}:${f.line}` : name })}${f.note ? ` ${f.note}` : ''}`;
    });
    const w = writerFor(client, card);
    const did = [await w.text(input.summary), files.length ? `Changed: ${files.join(', ')}` : '', input.commit ? `Commit: ${input.commit}` : '',
      input.tests ? `Tests: ${input.tests}` : ''].filter(Boolean).join('\n\n');
    const parts = boardTexts({ did, found: await w.text(input.rootCause), next: `Verify: ${await w.text(input.verify)}`,
      impact: input.impact === undefined ? undefined : await w.text(input.impact) }, ['did', 'found', 'next', 'impact']);
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: parts.body });
    let moved = card.status === 'FIXED' ? 'already Fixed' : '';
    if (!moved) {
      try {
        if (card.status === 'INBOX') throw invalid(`#${card.number} is still in the Inbox - the user sorts it first; the fix is recorded as a comment.`);
        const after = await client.post<CardRow>(`/board/cards/${seg(card.id)}/move`, { ...AS_CLAUDE, body: { status: 'FIXED' } });
        moved = line(after);
      } catch (error) {
        moved = `not moved: ${(error as Error).message}`;
      }
    }
    return ok({ recorded: `#${card.number}`, moved, retestPlan: plan || 'none - add expect so the re-test checks more than the status', ...w.report() });
  }));

  server.registerTool('board_flag', {
    description: 'Add or remove flags on a card (URGENT, RISK, BLOCKER, AFFECTS_PROJECT, NEEDS_DECISION).',
    inputSchema: { project: Project, number: CardNumber, add: z.array(Flag).default([]), remove: z.array(Flag).default([]) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const flags = [...new Set([...card.flags.filter((f) => !input.remove.includes(f as never)), ...input.add])];
    const updated = await client.patch<CardRow>(`/board/cards/${seg(card.id)}`, { ...AS_CLAUDE, body: { flags } });
    return ok({ flagged: line(updated) });
  }));

  server.registerTool('board_propose', {
    description: 'Propose a step only the user takes: VERIFIED (a Fixed card), DONE (Fixed or Verified), CLOSED with a resolution '
      + '(FINE, NOT_IN_FLOW, WONT_FIX), MERGE this card into card intoNumber (a duplicate: its history and links move there), or REOPEN '
      + 'a Verified/Done/closed card (a regression). The card shows it with Accept / Dismiss; a new proposal replaces the open one. '
      + 'Give the evidence as mentions.',
    inputSchema: {
      project: Project, number: CardNumber, status: z.enum(['VERIFIED', 'DONE', 'CLOSED', 'MERGE', 'REOPEN']), resolution: Resolution.optional(),
      intoNumber: CardNumber.optional().describe('For MERGE: the card this one is a duplicate of'),
      reason: z.string().max(2000).default(''), evidence: z.string().max(8 * 1024).default(''),
    },
  }, (input) => run(async () => {
    if (input.status === 'CLOSED' && !input.resolution) throw invalid('A close needs a resolution: FINE, NOT_IN_FLOW or WONT_FIX.');
    if (input.status === 'MERGE' && !input.intoNumber) throw invalid('A merge needs intoNumber: the card this one duplicates.');
    const card = await cardByNumber(client, input.project, input.number);
    const w = writerFor(client, card);
    const reason = await w.text(input.reason, 2000);
    const evidence = await w.text(input.evidence, 8 * 1024);
    const body = input.status === 'MERGE' ? { kind: 'MERGE', intoNumber: input.intoNumber, reason, evidence }
      : input.status === 'REOPEN' ? { kind: 'REOPEN', reason, evidence }
        : { status: input.status, resolution: input.status === 'CLOSED' ? input.resolution : null, reason, evidence };
    const updated = await client.put<CardRow>(`/board/cards/${seg(card.id)}/proposal`, { ...AS_CLAUDE, body });
    return ok({ proposed: line(updated), next: 'The user accepts or dismisses it; board_wait tells you which.', ...w.report() });
  }));

  server.registerTool('board_suggest_mark', {
    description: 'Suggest a mark (PASS, FAIL, CANT_TELL) on an acceptance item of a cycle\'s spec, with evidence as mentions. It shows grey '
      + 'until the user accepts it - the marks stay the user\'s. Item keys are in read_spec\'s checklist ([key]).',
    inputSchema: {
      cycleId: z.string().min(1), fileName: z.string().min(1), itemKey: z.string().min(1), mark: z.enum(['PASS', 'FAIL', 'CANT_TELL']),
      evidence: z.string().max(8 * 1024).default(''),
    },
  }, (input) => run(async () => {
    const item = await client.put<{ text: string }>(`/board/cycles/${seg(input.cycleId)}/checklist/${seg(input.fileName)}/${seg(input.itemKey)}/suggestion`,
      { ...AS_CLAUDE, body: { mark: input.mark, evidence: input.evidence } });
    return ok({ suggested: `${input.mark} - ${item.text}`, next: 'Waiting for the user to accept it.' });
  }));

  // ------------------------------------------------------------------------------------- brief, spec files (specs/015)

  server.registerTool('board_set_brief', {
    description: 'Write a session cycle\'s brief (Markdown with mentions): what the cycle is for, the steps to test under a "## Test steps" '
      + 'heading (numbered), the data needed. Replaces the whole brief; the user can Restore previous. ALWAYS show the user the text and '
      + 'get their OK in chat before calling this.',
    inputSchema: { cycleId: z.string().min(1), text: z.string().max(256 * 1024) },
  }, (input) => run(async () => {
    const brief = await client.put<{ updatedAt: string }>(`/board/cycles/${seg(input.cycleId)}/brief`, { ...AS_CLAUDE, body: { text: boardText(input.text).text } });
    return ok({ saved: 'brief', cycleId: input.cycleId, updatedAt: brief.updatedAt, undo: 'The user can Restore previous in the Brief tab.' });
  }));

  server.registerTool('board_put_spec', {
    description: 'Create or replace a spec file (.md or .txt) of a cycle. Put the testable requirements under "## Acceptance" as a list (one '
      + 'line each) - that list is the checklist. A replaced file is kept once (Restore previous). ALWAYS show the user the text (or the '
      + 'diff) and get their OK in chat before calling this.',
    inputSchema: { cycleId: z.string().min(1), name: z.string().min(1).max(200), text: z.string().max(5 * 1024 * 1024) },
  }, (input) => run(async () => {
    const saved = await client.put<{ name: string; size: number; replaced: boolean }>(`/board/cycles/${seg(input.cycleId)}/specs/${seg(input.name)}`,
      { ...AS_CLAUDE, rawBody: input.text });
    return ok({ saved: saved.name, size: saved.size, replaced: saved.replaced });
  }));

  server.registerTool('board_edit_spec', {
    description: 'Change part of a spec file or the brief: replace the exact text `find` with `replace` (it must occur once, or set all). '
      + 'name "brief" edits the cycle brief. Show the user the before/after and get their OK first.',
    inputSchema: {
      cycleId: z.string().min(1), name: z.string().min(1).max(200), find: z.string().min(1).max(64 * 1024), replace: z.string().max(64 * 1024),
      all: z.boolean().default(false),
    },
  }, (input) => run(async () => {
    const isBrief = input.name === 'brief';
    const current = isBrief
      ? (await client.get<{ text: string }>(`/board/cycles/${seg(input.cycleId)}/brief`)).text
      : await client.get<string>(`/board/cycles/${seg(input.cycleId)}/specs/${seg(input.name)}`, { text: true, notFound: `No spec file ${input.name} in this cycle.` });
    const count = current.split(input.find).length - 1;
    if (count === 0) throw invalid(`"${preview(input.find, 80, '')}" is not in ${input.name}.`);
    if (count > 1 && !input.all) throw invalid(`"${preview(input.find, 80, '')}" occurs ${count} times in ${input.name} - give more of the text, or set all.`);
    const next = input.all ? current.split(input.find).join(input.replace) : current.replace(input.find, input.replace);
    if (isBrief) {
      await client.put(`/board/cycles/${seg(input.cycleId)}/brief`, { ...AS_CLAUDE, body: { text: next } });
    } else {
      await client.put(`/board/cycles/${seg(input.cycleId)}/specs/${seg(input.name)}`,
        { ...AS_CLAUDE, rawBody: next });
    }
    return ok({ edited: input.name, replacements: input.all ? count : 1 });
  }));

  // ------------------------------------------------------------------------------- next steps, log, steps, links

  server.registerTool('board_next_steps', {
    description: 'What one board waits on: the cards waiting on the user (oldest first, why: question / proposal / inbox), and how many wait '
      + 'on Claude, are To do, In progress, Fixed (need a re-test) or in the Inbox. /alfred-status and /alfred-guide "what next" start here.',
    inputSchema: { project: Project, cycleId: z.string().optional() },
  }, (input) => run(async () => {
    const n = await client.get<{ waitingOnUser: { project: string; number: number; title: string; status: string; why: string; since: string }[];
      waitingOnClaude: number; toDo: number; inProgress: number; fixed: number; inbox: number }>('/board/next-steps', { query: { project: input.project, cycleId: input.cycleId } });
    return ok({
      waitingOnUser: n.waitingOnUser.map((i) => `#${i.number} ${i.title} - ${i.why} · ${ago(i.since)}`),
      waitingOnClaude: n.waitingOnClaude, toDo: n.toDo, inProgress: n.inProgress, fixedNeedRetest: n.fixed, inbox: n.inbox,
    });
  }));

  server.registerTool('board_session_log', {
    description: 'End every skill run with one entry on the cycle\'s session log: which skill, what you did, what you found, what comes next '
      + '(who it waits on). The user reads the cycle\'s history of your runs there.',
    inputSchema: {
      cycleId: z.string().min(1), skill: z.string().min(1).max(100), did: z.string().min(1).max(16 * 1024), found: z.string().min(1).max(16 * 1024),
      next: z.string().min(1).max(16 * 1024),
      project: z.string().max(100).optional().describe('The project the cycle is about - lets #N card numbers in the text become card mentions'),
    },
  }, (input) => run(async () => {
    const w = new ReadableWriter(client, { project: input.project ?? '', cycleId: input.cycleId });
    const max = 16 * 1024;
    await client.post(`/board/cycles/${seg(input.cycleId)}/log`, { ...AS_CLAUDE, body: { skill: input.skill, ...boardTexts({ did: await w.text(input.did, max),
      found: await w.text(input.found, max), next: await w.text(input.next, max) }, ['did', 'found', 'next']).body } });
    return ok({ logged: input.skill, cycleId: input.cycleId, ...w.report() });
  }));

  server.registerTool('board_steps', {
    description: 'The test steps of a cycle (the numbered list under the brief\'s "Test steps" heading) and what the cycle showed for each: '
      + 'UNTESTED, SEEN (with its call count) or FAILED (with its card). Keys are in [brackets].',
    inputSchema: { cycleId: z.string().min(1) },
  }, (input) => run(async () => {
    const steps = await client.get<StepRow[]>(`/board/cycles/${seg(input.cycleId)}/steps`);
    return ok({ steps: steps.map(stepLine), ...(steps.length ? {} : { none: 'The brief has no "Test steps" list - add one with board_edit_spec name "brief" or board_set_brief.' }) });
  }));

  server.registerTool('board_mark_step', {
    description: 'Record what the cycle showed for a test step: SEEN (its calls happened and worked), FAILED (with the card it failed into) '
      + 'or UNTESTED. listen and review tick the steps as calls arrive.',
    inputSchema: {
      cycleId: z.string().min(1), stepKey: z.string().min(1), state: z.enum(['UNTESTED', 'SEEN', 'FAILED']),
      calls: z.number().int().min(0).default(0), cardNumber: z.number().int().min(1).optional(), note: z.string().max(1000).optional(),
    },
  }, (input) => run(async () => {
    const step = await client.put<StepRow>(`/board/cycles/${seg(input.cycleId)}/steps/${seg(input.stepKey)}`, { ...AS_CLAUDE,
      body: { state: input.state, calls: input.calls, cardNumber: input.cardNumber, note: input.note } });
    return ok({ marked: stepLine(step) });
  }));

  server.registerTool('board_link_spec', {
    description: 'Say which Acceptance item a card is about (the [key] from read_spec), so the checklist shows the cards per item and the card '
      + 'shows the requirement it breaks. remove: true takes the link off.',
    inputSchema: {
      project: Project, number: CardNumber, cycleId: z.string().min(1), fileName: z.string().min(1), itemKey: z.string().min(1),
      remove: z.boolean().default(false),
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const body = { cycleId: input.cycleId, fileName: input.fileName, itemKey: input.itemKey };
    if (input.remove) await client.del(`/board/cards/${seg(card.id)}/spec-items`, { ...AS_CLAUDE, body });
    else await client.post(`/board/cards/${seg(card.id)}/spec-items`, { ...AS_CLAUDE, body });
    return ok({ [input.remove ? 'unlinked' : 'linked']: `#${card.number}`, item: input.itemKey });
  }));

  server.registerTool('board_block', {
    description: 'Mark a card as blocked by another card of the same project (it waits for that one to be fixed); remove: true unblocks. '
      + '/alfred-fix skips blocked cards until their blocker is Fixed.',
    inputSchema: { project: Project, number: CardNumber, blockedBy: CardNumber, remove: z.boolean().default(false) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const updated = input.remove
      ? await client.del<CardRow>(`/board/cards/${seg(card.id)}/blocked-by/${seg(input.blockedBy)}`, { ...AS_CLAUDE })
      : await client.post<CardRow>(`/board/cards/${seg(card.id)}/blocked-by`, { ...AS_CLAUDE, body: { number: input.blockedBy } });
    return ok({ card: line(updated) });
  }));

  server.registerTool('board_regressions', {
    description: 'Verified / Done cards of a project whose endpoint failed again, the way the card\'s call did, in recent live calls - and '
      + 'guards that failed (a Verified / Done card\'s expectations broken by a later call). '
      + 'For each, propose REOPEN with board_propose (the calls as evidence) - the user accepts.',
    inputSchema: { project: Project },
  }, (input) => run(async () => {
    const found = await client.get<{ number: number; title: string; status: string; signature: string; calls: { ref: string; label: string }[] }[]>(
      '/board/regressions', { query: { project: input.project } });
    const guards = (await client.get<RetestCheckRow[]>('/board/retest/guards', { query: { project: input.project } }))
      .filter((g) => g.verdict === 'FAILS' || g.verdict === 'FLAKY');
    return ok({ regressions: found.map((r) => `#${r.number} ${r.title} (${r.status}) [${r.signature}] - again: ${r.calls.slice(0, 5)
      .map((c) => serializeMention({ type: 'call', ref: c.ref, label: c.label })).join(' ')}${r.calls.length > 5 ? ` +${r.calls.length - 5}` : ''}`),
    guardsFailed: guards.map(retestLine),
    ...(found.length || guards.length ? {} : { none: 'No regression in recent live calls, and every guard holds.' }) });
  }));

  server.registerTool('board_status', {
    description: 'Tell the board what you are doing (the live strip): WATCHING a cycle with counts, or STOPPED. Returns paused: true when the user paused you - stop adding cards then.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional(),
      state: z.enum(['WATCHING', 'STOPPED']).default('WATCHING'),
      callsChecked: z.number().int().min(0).default(0),
      cardsAdded: z.number().int().min(0).default(0),
      step: z.string().max(200).optional().describe('What you are doing now, shown on the strip: "reviewing ODY-482 · 34/120 calls", "fixing #11 · running tests"'),
    },
  }, (input) => run(async () => {
    const status = await client.put<{ state: string }>('/board/agent-status', { ...AS_CLAUDE, body: input });
    return ok({ state: status.state, paused: status.state === 'PAUSED' });
  }));
}

/** What a mention points at, read from Alfred - or that it is gone. */
async function resolve(client: AlfredClient, ctx: MaskContext, type: string, ref: string): Promise<Record<string, unknown>> {
  const gone = (why = 'gone - only its saved label is left') => ({ found: false, note: why });
  try {
    switch (type) {
      case 'call': {
        const m = /^(in|out):([^@]+)(?:@(.+))?$/.exec(ref);
        if (!m) return gone('not a call ref');
        const kind = m[1] === 'in' ? 'internal-calls' : 'calls';
        const c = await client.get<{ method?: string; url?: string; status?: number | null; error?: string | null; timestamp?: string; durationMs?: number | null;
          response?: { status?: number } | null }>(m[3] ? `/session-cycles/${seg(m[3])}/${kind}/${seg(m[2])}/detail` : `/${kind}/${seg(m[2])}/summary`);
        const status = c.status ?? c.response?.status ?? null;
        return { found: true, call: `${c.method ?? ''} ${maskText(ctx, c.url ?? '')} → ${status ?? `error ${c.error ?? ''}`}`.trim(),
          at: c.timestamp, ...(c.durationMs != null ? { ms: c.durationMs } : {}), where: m[3] ? `cycle ${m[3]}` : 'live' };
      }
      case 'stmt': {
        const [callId, seq] = ref.split('/');
        const page = await client.get<{ statements: { seq: number; sql: string; durationMicros: number; error?: string | null; rowCount?: number | null }[] }>(
          `/db-capture/calls/${seg(callId)}/statements`, { query: { afterSeq: Math.max(0, Number(seq) - 1), limit: 1 } });
        const st = page.statements.find((s) => String(s.seq) === seq);
        return st ? { found: true, sql: preview(maskText(ctx, st.sql), 2000, `db_statements callId=${callId}`), ms: st.durationMicros / 1000,
          ...(st.error ? { error: maskText(ctx, st.error) } : {}) } : gone();
      }
      case 'log': {
        const slash = ref.indexOf('/');
        const callId = ref.slice(0, slash);
        const lineId = ref.slice(slash + 1);
        const { lines } = await callLines(client, callId);
        const l = lines.find((x) => x.lineId === lineId);
        return l ? { found: true, line: `${l.level ?? ''} ${l.logger ?? ''}: ${preview(maskText(ctx, l.message), 2000, `call_logs callId=${callId}`)}`.trim() } : gone();
      }
      case 'redis': {
        const [callId, seq] = ref.split('/');
        const page = await client.get<{ commands: { seq: number; command: string; keys: string[] }[] }>(`/db-capture/calls/${seg(callId)}/store-commands`, { query: { offset: 0, limit: 500 } });
        const cmd = page.commands.find((c) => String(c.seq) === seq);
        return cmd ? { found: true, command: maskText(ctx, `${cmd.command} ${cmd.keys.join(' ')}`) } : gone();
      }
      case 'spec': {
        const slash = ref.indexOf('/');
        const rest = ref.slice(slash + 1);
        const hash = rest.indexOf('#');
        const name = hash < 0 ? rest : rest.slice(0, hash);
        const text = await client.get<string>(`/board/cycles/${seg(ref.slice(0, slash))}/specs/${seg(name)}`, { text: true });
        const body = hash < 0 ? text : sectionOf(text, rest.slice(hash + 1));
        return { found: true, spec: preview(body, 1500, `read_spec`) };
      }
      case 'card': {
        const m = /^(.*)#(\d+)$/.exec(ref);
        if (!m) return gone('not a card ref');
        return { found: true, card: line(await cardByNumber(client, m[1], Number(m[2]))) };
      }
      case 'cycle': {
        const c = await client.get<{ name: string; status: string }>(`/session-cycles/${seg(ref)}`);
        return { found: true, cycle: `${c.name} (${c.status})` };
      }
      default:
        return { found: true, note: 'open it with the tool shown' };
    }
  } catch {
    return gone();
  }
}

/** The lines under a heading whose text or slug is `section` (the whole text when none matches). */
export function sectionOf(text: string, section: string): string {
  const want = section.trim().toLowerCase();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l.trim());
    return !!m && (m[2].trim().toLowerCase() === want || slug(m[2]) === want);
  });
  if (start < 0) return text;
  const level = (/^#+/.exec(lines[start].trim()) ?? [''])[0].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i].trim());
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

