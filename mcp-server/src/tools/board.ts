import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { callLines } from '../call-story.ts';
import { mentionsIn, serializeMention } from '../frontend.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { chunkText, fitItems, invalid, ok, preview, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';
import { liveHolder } from './live.ts';

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
const StepList = z.array(z.object({ text: z.string().min(1).max(500), endpoint: z.string().max(300).optional() })).max(20).default([]);

type RetestResultRow = { text: string; outcome: string; before: string | null; after: string[]; note: string | null };
type RetestCheckRow = { number: number; title: string; status: string; verdict: string; statusOnly: boolean; summary: string; newBuild: boolean;
  results: RetestResultRow[]; calls: { ref: string; label: string; passed: boolean; failed: string | null }[];
  steps: { text: string; endpoint: string | null; seen: boolean; calls: number }[] };
type RetestPlanRow = { expectations: unknown[]; steps: unknown[]; updatedBy: string | null };
type RetestRunRow = { at: string; verdict: string; calls: number; source: string; summary: string };

function retestLine(c: RetestCheckRow): Record<string, unknown> {
  return {
    card: `#${c.number} ${c.title} (${c.status}) - ${c.verdict}: ${c.summary}${c.newBuild ? ' · new build since the fix, not re-tested yet' : ''}`,
    ...(c.statusOnly ? { note: 'No expectations - only the status was compared; board_retest_plan adds them' } : {}),
    results: c.results.map((r) => `${r.outcome} ${r.text}${r.before != null ? ` · before ${r.before}` : ''}${r.after.length ? ` · now ${r.after.slice(0, 5).join(', ')}` : ''}${r.note ? ` (${r.note})` : ''}`),
    ...(c.steps.length ? { steps: c.steps.map((s) => `${s.seen ? 'done' : 'not done'} - ${s.text}${s.endpoint ? ` [${s.endpoint}]` : ''}`) } : {}),
    calls: c.calls.slice(0, 5).map((x) => `${x.passed ? 'pass' : `FAIL ${x.failed}`} ${serializeMention({ type: 'call', ref: x.ref, label: x.label })}`),
  };
}

/** One entry's text over this many characters is read in parts with board_get entry=<index>. */
const ENTRY_INLINE = 6000;

interface Proposal { status: string; resolution: string | null; reason: string; evidence: string; at: string; kind?: string; intoNumber?: number | null }

export interface CardRow {
  id: string; project: string; number: number; kind: string; title: string; status: string; resolution: string | null; reason: string | null;
  flags: string[]; scope: string; author: string; cycleId: string | null; cycleDeleted: boolean; updatedAt: string; commentCount: number;
  similarClosed: { number: number; resolution: string; reason: string | null } | null; description?: string;
  links?: { type: string; ref: string; label: string }[]; proposal?: Proposal | null;
  waiting?: { who: string; since: string; setBy: string } | null;
  blockedBy?: { project: string; number: number; title: string; status: string }[];
  specItems?: { cycleId: string; fileName: string; itemKey: string; text: string | null }[];
  /** Ids of the teams the card is assigned to (board_teams lists them). */
  teams?: string[];
}

interface TeamRow { id: string; name: string; icon: string; owns: string; hints: string[] }

/**
 * How Claude picks a card's teams - shared by board_teams, board_assign and board_add so the three say the same. The
 * evidence decides, not the endpoint's name: a 405 from a Java controller is Backend even when the page shows it.
 */
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
  /** The comment this one answers (one level), or null. */
  replyTo?: number | null;
}

export function isQuestion(e: ActivityRow): boolean {
  return e.kind === 'COMMENT' && e.actor === 'CLAUDE' && !!e.text && e.text.startsWith('**Question**');
}

/** Claude's questions on a card the user has not answered (replied to) yet, as history indexes. */
export function openQuestionIndexes(entries: readonly ActivityRow[]): number[] {
  const answered = new Set(entries.filter((e) => e.actor === 'USER' && e.replyTo != null).map((e) => e.replyTo));
  return entries.map((e, i) => (isQuestion(e) && !answered.has(e.id) ? i : -1)).filter((i) => i >= 0);
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
  cursor: string;
  more: boolean;
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

export function who(actor: string): string {
  return actor === 'CLAUDE' ? 'Claude' : 'User';
}

/** One history entry as one line; a comment in full (it is read in parts past `inline` characters). */
export function entryLine(ctx: MaskContext, e: ActivityRow, index: number, inline = ENTRY_INLINE): string {
  const text = maskText(ctx, e.text ?? '');
  const body = text.length > inline ? `${text.slice(0, inline)}… (${text.length} chars - read the rest with board_get entry=${index})` : text;
  if (e.kind === 'COMMENT') return `${e.at} ${who(e.actor)}: ${body}`;
  const change = e.oldValue || e.newValue ? ` ${e.oldValue ?? ''} → ${e.newValue ?? ''}` : '';
  return `${e.at} ${who(e.actor)} ${e.kind}${change}${body ? ` (${body})` : ''}`;
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

export async function cardByNumber(client: AlfredClient, project: string, number: number): Promise<CardRow> {
  return client.get<CardRow>(`/board/cards/by-number/${seg(number)}`, { query: { project }, notFound: `No card #${number} on the ${project || 'No project'} board.` });
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
  const thread = parent
    ? (isQuestion(parent) && e.actor === 'USER' ? `ANSWERS your question "${preview(stripLabel(parent.text), 120, 'board_get')}": `
      : `↳ reply to ${who(parent.actor)} "${preview(stripLabel(parent.text), 120, 'board_get')}": `)
    : '';
  return `${e.project || '(No project)'} #${e.number} "${e.title}" (${e.status}) - ${thread}${entryLine(ctx, e, -1, 1500)
    .replace(/board_get entry=-1/, `board_get ${JSON.stringify({ project: e.project, number: e.number })}`)}`;
}

export function stripLabel(text: string | null): string {
  return (text ?? '').replace(/^\*\*(Did|Found|Next|Impact|Reply|Question)\*\*\s*/, '').replace(/\s+/g, ' ').trim();
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
  const fitted = fitItems(entries, 600 + JSON.stringify(cycles).length);
  const cut = fitted.cut || page.more;
  return {
    changes: fitted.items,
    cycleChanges: cycles,
    cursor: fitted.cut ? `${page.entries[fitted.items.length - 1].id}.${page.cursor.split('.')[1] ?? '0'}` : page.cursor,
    ...(cut ? { more: 'More changes - call again with this cursor.' } : {}),
    ...(entries.length === 0 && cycles.length === 0 ? { nothing: 'No changes after the cursor.' } : {}),
    ...maskMeta(ctx),
  };
}

export function register(server: McpServer, client: AlfredClient): void {
  // ------------------------------------------------------------------------------------------------------------ reading

  server.registerTool('board_list', {
    description: 'Cards on one project\'s task board (or one cycle\'s): "#n KIND [flags] {teams} title - status (cycle)". Use board_search to look across every board.',
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
    const fitted = fitItems(page.cards.map(line), 300);
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
      since: z.string().optional().describe('ISO time: only cards changed since'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
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
    const entries = await history(client, card.id);
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
    const head = {
      card: line(card),
      scope: card.scope,
      ...(card.proposal ? { proposal: `${target(card.proposal)}: ${maskText(ctx, card.proposal.reason)}${card.proposal.evidence ? ` - ${maskText(ctx, card.proposal.evidence)}` : ''}` } : {}),
      description,
      links: (card.links ?? []).map((l) => `${l.type.toLowerCase()} ${l.ref} - ${maskText(ctx, l.label)}`),
      mentions: shownMentions,
      ...(mentions.length > shownMentions.length ? { moreMentions: `${mentions.length - shownMentions.length} more - board_evidence lists them all` } : {}),
      ...(openQuestionIndexes(entries).length ? { openQuestions: openQuestionIndexes(entries) } : {}),
      ...(card.specItems?.length ? { specItems: card.specItems.map((i) => `${i.fileName} [${i.itemKey}] ${i.text ?? '(item gone)'}`) } : {}),
    };
    const indexOf = new Map(entries.map((e, i) => [e.id, i]));
    const answered = new Set(entries.filter((e) => e.actor === 'USER' && e.replyTo != null).map((e) => e.replyTo));
    const lines = entries.slice(input.historyOffset).map((e, n) => {
      const i = input.historyOffset + n;
      const thread = e.replyTo != null ? `↳ reply to [${indexOf.get(e.replyTo) ?? '?'}] ` : '';
      const state = isQuestion(e) ? ` (question - ${answered.has(e.id) ? 'answered' : 'OPEN, waiting for the user'})` : '';
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
    const live = liveHolder(client.baseUrl);
    return ok({ ...changesReply(ctx, page, await parentsOf(client, page)),
      ...(live && (!live.project || !input.project || live.project === input.project)
        ? { live: '/alfred-live is answering the user on this board - only note these changes; do not reply to them' } : {}) });
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
    const live = liveHolder(client.baseUrl);
    return ok({ ...changesReply(ctx, page, await parentsOf(client, page)),
      ...(live && (!live.project || !input.project || live.project === input.project)
        ? { live: '/alfred-live is answering the user on this board - only note these changes; do not reply to them' } : {}) });
  }));

  server.registerTool('board_closed_reasons', {
    description: 'What the user already dismissed on this project\'s board - closed cards with their resolution, reason and signature. Read before reporting, '
      + 'and do not raise an issue closed as FINE or NOT_IN_FLOW again.',
    inputSchema: { project: Project, limit: z.number().int().min(1).max(500).default(200) },
  }, (input) => run(async () => {
    const reasons = await client.get<{ number: number; title: string; signature: string | null; resolution: string; reason: string | null }[]>(
      '/board/closed-reasons', { query: { project: input.project, limit: input.limit } });
    return ok({ closed: reasons.map((r) => `#${r.number} ${r.title} - ${r.resolution}${r.reason ? `: ${r.reason}` : ''}${r.signature ? ` [${r.signature}]` : ''}`) });
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
    const briefText = chunkText(maskText(ctx, brief.text || '(no brief yet)'), 0, 6000);
    const rows = cards.cards.map((h) => hitLine(ctx, h));
    const fitted = fitItems(rows, JSON.stringify(briefText).length + 800);
    return ok({
      brief: briefText.nextOffset === null ? briefText.text : `${briefText.text}… (${briefText.totalLength} chars; the rest is in the cycle's Brief tab)`,
      updatedAt: brief.updatedAt,
      ...(brief.updatedBy === 'CLAUDE' ? { writtenBy: 'Claude (the user can Restore previous)' } : {}),
      ...(steps.length ? { testSteps: steps.map(stepLine) } : {}),
      specFiles: specs.map((s) => `${s.name} (${s.size} bytes)`),
      cards: fitted.items,
      cardsTotal: cards.total,
      ...(fitted.cut || cards.total > rows.length ? { moreCards: `board_search ${JSON.stringify({ cycleId: input.cycleId, offset: fitted.items.length })}` } : {}),
      ...maskMeta(ctx),
    });
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
      + '(Markdown). apply=true also proposes Verified on PASSES and comments on FAILS / FLAKY - the user accepts.',
    inputSchema: {
      project: Project,
      numbers: z.array(CardNumber).max(100).default([]).describe('Only these cards; empty = every Fixed card'),
      cycleId: z.string().optional().describe('A re-test cycle; omit to use the live calls since each fix'),
      record: z.boolean().default(false),
      apply: z.boolean().default(false),
    },
  }, (input) => run(async () => {
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
        if (c.verdict === 'PASSES') {
          await client.put(`/board/cards/${seg(card.id)}/proposal`, { ...AS_CLAUDE, body: { status: 'VERIFIED', reason: `Re-test from ${source}: ${c.summary}`, evidence } });
          done.push(`#${c.number} proposed Verified`);
        } else if (c.verdict === 'FAILS' || c.verdict === 'FLAKY') {
          await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: {
            did: `Re-tested from ${source}`, found: `${c.verdict === 'FLAKY' ? 'Flaky' : 'Still failing'}: ${c.summary}\n\n${evidence}`,
            next: 'Investigate the failing call and fix again', waitingOn: 'CLAUDE' } });
          done.push(`#${c.number} commented ${c.verdict === 'FLAKY' ? 'flaky' : 'still failing'}`);
        }
      }
    }
    const rows = checks.map(retestLine);
    const fitted = fitItems(rows, 400 + JSON.stringify(done).length + (report?.length ?? 0));
    return ok({ source, checks: fitted.items, total: checks.length, ...(report ? { report } : {}), ...(input.apply ? { applied: done } : {}),
      ...(fitted.cut ? { more: 'Some checks did not fit - pass numbers.' } : {}) });
  }));

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
      + 'had). A step names the endpoint ("POST /Admin2/agency/by-branch") whose call shows it was done, or none for the card\'s own.',
    inputSchema: { project: Project, number: CardNumber, expect: ExpectList, steps: StepList },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const plan = await client.put<RetestPlanRow>(`/board/cards/${seg(card.id)}/retest-plan`, { ...AS_CLAUDE, body: { expectations: input.expect, steps: input.steps } });
    return ok({ saved: `#${card.number}`, expectations: plan.expectations.length, steps: plan.steps.length });
  }));

  // ------------------------------------------------------------------------------------------------------------ writing

  server.registerTool('board_add', {
    description: 'Put a finding on the board. It always lands in the Inbox for the user to sort. Mention evidence in the description as '
      + '@[type:ref|label] (e.g. @[call:in:<id>|POST /orders · 500], @[stmt:<callId>/<seq>|INSERT ORDERS #88]) and pass the main call in links. '
      + 'Check board_similar / board_for_call first. Refused while the user paused the board, and when the user already closed the same problem '
      + 'as Fine or Not in this flow - the refusal says which card and why. Always pass teams. ' + TEAM_GUIDE,
    inputSchema: {
      project: Project,
      kind: Kind,
      title: z.string().min(1).max(300),
      description: z.string().max(256 * 1024).default(''),
      flags: z.array(Flag).default([]),
      teams: Teams.default([]),
      cycleId: z.string().optional(),
      links: z.array(Link).max(100).default([]),
    },
  }, (input) => run(async () => {
    const card = await client.post<CardRow>('/board/cards', {
      ...AS_CLAUDE,
      body: { project: input.project, kind: input.kind, title: input.title, description: input.description, flags: input.flags,
        teams: input.teams, cycleId: input.cycleId, links: input.links },
    });
    return ok({ added: `#${card.number}`, status: card.status, card: line(card),
      ...(card.teams?.length ? {} : { teams: 'none - pick them with board_assign (board_teams lists the teams)' }) });
  }));

  server.registerTool('board_add_many', {
    description: 'Several findings from one scan, each like board_add (Inbox, duplicate check, teams). Each one says added or why it was refused. '
      + 'In the same call, each card can take its first state comment (firstComment: did / found / next / waitingOn - as board_comment) and the '
      + 'Acceptance item it breaks (specItem: fileName + itemKey from read_spec / task_context, in cycleId - as board_link_spec), so a batch of '
      + 'findings is one call instead of three per card.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional(),
      cards: z.array(z.object({
        kind: Kind, title: z.string().min(1).max(300), description: z.string().max(64 * 1024).default(''), flags: z.array(Flag).default([]),
        teams: Teams.default([]), links: z.array(Link).max(50).default([]),
        firstComment: z.object({
          did: z.string().min(1).max(64 * 1024), found: z.string().min(1).max(64 * 1024), next: z.string().min(1).max(64 * 1024), waitingOn: WaitingOn,
        }).optional().describe('The card\'s first state comment, written right after it is added'),
        specItem: z.object({ fileName: z.string().min(1), itemKey: z.string().min(1) }).optional()
          .describe('The Acceptance item this card is about (needs cycleId)'),
      })).min(1).max(30),
    },
  }, (input) => run(async () => {
    const results: string[] = [];
    for (const { firstComment, specItem, ...c } of input.cards) {
      try {
        const card = await client.post<CardRow>('/board/cards', { ...AS_CLAUDE, body: { project: input.project, cycleId: input.cycleId, ...c } });
        const extra: string[] = [];
        // The card is added: a failed comment or link is said, never a reason to call it not added.
        if (firstComment) {
          await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: firstComment })
            .then(() => extra.push('commented'), (e) => extra.push(`comment not written: ${(e as Error).message}`));
        }
        if (specItem) {
          if (!input.cycleId) extra.push('spec item not linked: give cycleId');
          else await client.post(`/board/cards/${seg(card.id)}/spec-items`, { ...AS_CLAUDE, body: { cycleId: input.cycleId, ...specItem } })
            .then(() => extra.push(`linked to ${specItem.itemKey}`), (e) => extra.push(`spec item not linked: ${(e as Error).message}`));
        }
        results.push(`added #${card.number} ${c.title}${card.teams?.length ? ` {${card.teams.join(', ')}}` : ' - no team yet'}${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
      } catch (error) {
        results.push(`not added "${c.title}": ${(error as Error).message}`);
        if (/paused/i.test((error as Error).message)) break;
      }
    }
    return ok({ results });
  }));

  server.registerTool('board_comment', {
    description: 'Record progress on a card: what you did, what you found, what comes next, and (when a change touches shared code) its impact. '
      + 'All of did/found/next are needed - another session or the user picks the work up from these. To answer the user use board_reply; to ask, board_ask.',
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
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE,
      body: { did: input.did, found: input.found, next: input.next, impact: input.impact, ...(replyTo != null ? { replyTo } : {}),
        ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}) } });
    return ok({ commented: `#${card.number}` });
  }));

  server.registerTool('board_reply', {
    description: 'Answer the user on a card in your own words (shown as "Reply" in the history). With replyTo (a comment\'s [index] from '
      + 'board_get) it goes under that comment, in its thread - use it to answer one exact comment. Mentions work: @[call:in:<id>|label].',
    inputSchema: {
      project: Project, number: CardNumber, text: z.string().min(1).max(64 * 1024),
      replyTo: z.number().int().min(0).optional().describe('The [index] of the comment you answer, from board_get'),
      waitingOn: WaitingOn,
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const replyTo = input.replyTo === undefined ? undefined : await commentIdAt(client, card, input.replyTo);
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { reply: input.text, ...(replyTo != null ? { replyTo } : {}),
      ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}) } });
    return ok({ replied: `#${card.number}`, ...(input.replyTo !== undefined ? { under: `[${input.replyTo}]` } : {}) });
  }));

  server.registerTool('board_ask', {
    description: 'Ask the user a question on a card: shown as "Question" and the card is flagged Needs decision. Their answer arrives in '
      + 'board_wait / board_changes.',
    inputSchema: { project: Project, number: CardNumber, question: z.string().min(1).max(16 * 1024) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { question: input.question } });
    return ok({ asked: `#${card.number}`, flagged: 'NEEDS_DECISION', next: `board_wait ${JSON.stringify({ project: input.project, cursor: 'now' })}` });
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
    for (const l of input.links) await client.post(`/board/cards/${seg(card.id)}/links`, { ...AS_CLAUDE, body: l });
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
    description: 'Rewrite the title, description or kind of one of YOUR cards while it is still in the Inbox. After the user sorts it, comment instead.',
    inputSchema: {
      project: Project, number: CardNumber, title: z.string().min(1).max(300).optional(), description: z.string().max(256 * 1024).optional(),
      kind: Kind.optional(),
    },
  }, (input) => run(async () => {
    if (input.title === undefined && input.description === undefined && input.kind === undefined) throw invalid('Nothing to change - give a title, description or kind.');
    const card = await cardByNumber(client, input.project, input.number);
    const updated = await client.patch<CardRow>(`/board/cards/${seg(card.id)}`, { ...AS_CLAUDE, body: { title: input.title, description: input.description, kind: input.kind } });
    return ok({ edited: line(updated) });
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
      await client.put(`/board/cards/${seg(card.id)}/retest-plan`, { ...AS_CLAUDE, body: { expectations: input.expect, steps: input.steps } });
      plan = `${input.expect.length} expectations, ${input.steps.length} steps`;
    }
    const files = input.files.map((f) => {
      const ref = f.line ? `${f.path}:${f.line}` : f.path;
      const name = f.path.split(/[\\/]/).pop() ?? f.path;
      return `${serializeMention({ type: 'code', ref, label: f.line ? `${name}:${f.line}` : name })}${f.note ? ` ${f.note}` : ''}`;
    });
    const did = [input.summary, files.length ? `Changed: ${files.join(', ')}` : '', input.commit ? `Commit: ${input.commit}` : '',
      input.tests ? `Tests: ${input.tests}` : ''].filter(Boolean).join('\n\n');
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { did, found: input.rootCause, next: `Verify: ${input.verify}`, impact: input.impact } });
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
    return ok({ recorded: `#${card.number}`, moved, retestPlan: plan || 'none - add expect so the re-test checks more than the status' });
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
    const body = input.status === 'MERGE' ? { kind: 'MERGE', intoNumber: input.intoNumber, reason: input.reason, evidence: input.evidence }
      : input.status === 'REOPEN' ? { kind: 'REOPEN', reason: input.reason, evidence: input.evidence }
        : { status: input.status, resolution: input.status === 'CLOSED' ? input.resolution : null, reason: input.reason, evidence: input.evidence };
    const updated = await client.put<CardRow>(`/board/cards/${seg(card.id)}/proposal`, { ...AS_CLAUDE, body });
    return ok({ proposed: line(updated), next: 'The user accepts or dismisses it; board_wait tells you which.' });
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
    const brief = await client.put<{ updatedAt: string }>(`/board/cycles/${seg(input.cycleId)}/brief`, { ...AS_CLAUDE, body: { text: input.text } });
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
    },
  }, (input) => run(async () => {
    await client.post(`/board/cycles/${seg(input.cycleId)}/log`, { ...AS_CLAUDE, body: { skill: input.skill, did: input.did, found: input.found, next: input.next } });
    return ok({ logged: input.skill, cycleId: input.cycleId });
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

