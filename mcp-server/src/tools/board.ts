import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { callLines } from '../call-story.ts';
import { mentionsIn, serializeMention } from '../frontend.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { chunkText, fitItems, invalid, ok, preview, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

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

/** One entry's text over this many characters is read in parts with board_get entry=<index>. */
const ENTRY_INLINE = 6000;

interface Proposal { status: string; resolution: string | null; reason: string; evidence: string; at: string }

interface CardRow {
  id: string; project: string; number: number; kind: string; title: string; status: string; resolution: string | null; reason: string | null;
  flags: string[]; scope: string; author: string; cycleId: string | null; cycleDeleted: boolean; updatedAt: string; commentCount: number;
  similarClosed: { number: number; resolution: string; reason: string | null } | null; description?: string;
  links?: { type: string; ref: string; label: string }[]; proposal?: Proposal | null;
}

interface ActivityRow {
  id?: number; actor: string; kind: string; text: string | null; oldValue: string | null; newValue: string | null; at: string;
}

interface SearchHit extends CardRow { lastComment: ActivityRow | null }

interface ChangeRow extends ActivityRow { project: string; number: number; title: string; status: string; cycleId: string | null }

interface ChangesPage {
  entries: ChangeRow[];
  cycles: { cycleId: string; what: string; name: string | null; detail: string | null; at: string }[];
  cursor: string;
  more: boolean;
}

function line(c: CardRow): string {
  const flags = c.flags.length ? ` [${c.flags.join(', ')}]` : '';
  const state = c.resolution ? `${c.status} (${c.resolution}${c.reason ? `: ${c.reason}` : ''})` : c.status;
  const proposal = c.proposal ? ` · ✦ proposed ${target(c.proposal)} - waiting for the user` : '';
  return `#${c.number} ${c.kind}${flags} ${c.title} - ${state}${c.cycleId ? ` (cycle ${c.cycleId}${c.cycleDeleted ? ', deleted' : ''})` : ''}`
    + `${c.author === 'CLAUDE' ? ' ✦' : ''}${c.commentCount ? ` · ${c.commentCount} comments` : ''}${proposal}`;
}

function target(p: Proposal): string {
  return p.status === 'CLOSED' && p.resolution ? `close as ${p.resolution}` : p.status;
}

function who(actor: string): string {
  return actor === 'CLAUDE' ? 'Claude' : 'User';
}

/** One history entry as one line; a comment in full (it is read in parts past `inline` characters). */
function entryLine(ctx: MaskContext, e: ActivityRow, index: number, inline = ENTRY_INLINE): string {
  const text = maskText(ctx, e.text ?? '');
  const body = text.length > inline ? `${text.slice(0, inline)}… (${text.length} chars - read the rest with board_get entry=${index})` : text;
  if (e.kind === 'COMMENT') return `${e.at} ${who(e.actor)}: ${body}`;
  const change = e.oldValue || e.newValue ? ` ${e.oldValue ?? ''} → ${e.newValue ?? ''}` : '';
  return `${e.at} ${who(e.actor)} ${e.kind}${change}${body ? ` (${body})` : ''}`;
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

async function cardByNumber(client: AlfredClient, project: string, number: number): Promise<CardRow> {
  return client.get<CardRow>(`/board/cards/by-number/${seg(number)}`, { query: { project }, notFound: `No card #${number} on the ${project || 'No project'} board.` });
}

async function history(client: AlfredClient, cardId: string): Promise<ActivityRow[]> {
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

function changeLine(ctx: MaskContext, e: ChangeRow): string {
  return `${e.project || '(No project)'} #${e.number} "${e.title}" (${e.status}) - ${entryLine(ctx, e, -1, 1500)
    .replace(/board_get entry=-1/, `board_get ${JSON.stringify({ project: e.project, number: e.number })}`)}`;
}

function changesReply(ctx: MaskContext, page: ChangesPage): Record<string, unknown> {
  const entries = page.entries.map((e) => changeLine(ctx, e));
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
    description: 'Cards on one project\'s task board (or one cycle\'s): "#n KIND [flags] title - status (cycle)". Use board_search to look across every board.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional().describe('Only this session cycle\'s cards (any project)'),
      status: z.array(Status).optional(),
      kind: z.array(Kind).optional(),
      flag: z.array(Flag).optional(),
      limit: z.number().int().min(1).max(500).default(200),
    },
  }, (input) => run(async () => {
    const page = await client.get<{ cards: CardRow[]; total: number; counts: { open: number; fixed: number; done: number } }>('/board/cards', {
      query: { project: input.project, cycleId: input.cycleId, status: input.status?.join(','), kind: input.kind?.join(','),
        flag: input.flag?.join(','), limit: input.limit },
    });
    const fitted = fitItems(page.cards.map(line), 300);
    return ok({ cards: fitted.items, total: page.total, progress: page.counts, ...(fitted.cut ? { more: 'Narrow it with status/kind/flag.' } : {}) });
  }));

  server.registerTool('board_search', {
    description: 'Cards across EVERY board (or one project / cycle), each with its latest comment - start here in a new session: '
      + 'mine=true with status [TO_DO, IN_PROGRESS] is "what was I working on". Filters: text, status, kind, flag, author, changed since.',
    inputSchema: {
      project: z.string().optional().describe('One project; omit for every board'),
      cycleId: z.string().optional(),
      text: z.string().max(300).optional().describe('Words in the title or description'),
      status: z.array(Status).optional(),
      kind: z.array(Kind).optional(),
      flag: z.array(Flag).optional(),
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
        flag: input.flag?.join(','), author: input.author, claudeTouched: input.mine || undefined, since: input.since,
        offset: input.offset, limit: input.limit },
    });
    const rows = page.cards.map((h) => hitLine(ctx, h));
    const fitted = fitItems(rows, 300);
    const next = input.offset + fitted.items.length;
    return ok({ cards: fitted.items, total: page.total, ...(next < page.total ? { nextOffset: next } : {}), ...maskMeta(ctx) });
  }));

  server.registerTool('board_get', {
    description: 'One card in full: description, Linked list, every mention with the tool that opens it, the open proposal, and the history '
      + 'oldest first with every comment complete. Long history continues at nextHistoryOffset; a comment longer than 6000 characters is read '
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
    };
    const lines = entries.slice(input.historyOffset).map((e, i) => `[${input.historyOffset + i}] ${entryLine(ctx, e, input.historyOffset + i)}`);
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
    return ok(changesReply(ctx, page));
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
    return ok(changesReply(ctx, page));
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
    const [brief, specs, cards] = await Promise.all([
      client.get<{ text: string; updatedAt: string | null }>(`/board/cycles/${seg(input.cycleId)}/brief`),
      client.get<{ name: string; size: number; uploadedAt: string }[]>(`/board/cycles/${seg(input.cycleId)}/specs`),
      client.get<{ cards: SearchHit[]; total: number }>('/board/search', { query: { cycleId: input.cycleId, limit: 100 } }).catch(() => ({ cards: [], total: 0 })),
    ]);
    const briefText = chunkText(maskText(ctx, brief.text || '(no brief yet)'), 0, 6000);
    const rows = cards.cards.map((h) => hitLine(ctx, h));
    const fitted = fitItems(rows, JSON.stringify(briefText).length + 800);
    return ok({
      brief: briefText.nextOffset === null ? briefText.text : `${briefText.text}… (${briefText.totalLength} chars; the rest is in the cycle's Brief tab)`,
      updatedAt: brief.updatedAt,
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
    const checklist = await client.get<{ fileName: string; items: { key: string; text: string; mark: { mark: string; evidence: string } | null; suggestion?: { mark: string; evidence: string } | null }[] }[]>(
      `/board/cycles/${seg(input.cycleId)}/checklist`).catch(() => []);
    const body = input.section ? sectionOf(text, input.section) : text;
    const items = checklist.find((f) => f.fileName === input.name)?.items ?? [];
    return ok({
      spec: chunkText(body, input.offset, 10_000),
      checklist: items.map((i) => `[${i.key}] ${i.mark ? i.mark.mark : 'UNMARKED'} - ${i.text}${i.mark?.evidence ? ` (evidence: ${i.mark.evidence})` : ''}`
        + `${i.suggestion ? ` · you suggested ${i.suggestion.mark}, waiting for the user` : ''}`),
    });
  }));

  server.registerTool('board_verify', {
    description: 'Checks every Fixed card of a project against a re-test cycle: the cycle\'s calls to each card\'s endpoint (by signature) say '
      + 'LOOKS_FIXED, STILL_FAILING or NOT_EXERCISED. With apply=true, comments "still failing" on the failing ones and proposes Verified on '
      + 'the fixed ones, with the calls as evidence - the user accepts.',
    inputSchema: { project: Project, cycleId: z.string().min(1), apply: z.boolean().default(false) },
  }, (input) => run(async () => {
    const checks = await client.get<{ number: number; title: string; signature: string | null; verdict: string; calls: { ref: string; label: string; signal: string }[] }[]>(
      '/board/verify', { query: { project: input.project, cycleId: input.cycleId } });
    const done: string[] = [];
    if (input.apply) {
      for (const c of checks) {
        const card = await cardByNumber(client, input.project, c.number);
        const evidence = c.calls.slice(0, 10).map((x) => serializeMention({ type: 'call', ref: x.ref, label: x.label })).join(' ');
        if (c.verdict === 'LOOKS_FIXED') {
          await client.put(`/board/cards/${seg(card.id)}/proposal`, { ...AS_CLAUDE, body: { status: 'VERIFIED', reason: `Re-test cycle ${input.cycleId}: every call to the endpoint now succeeds`, evidence } });
          done.push(`#${c.number} proposed Verified`);
        } else if (c.verdict === 'STILL_FAILING') {
          await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: {
            did: `Checked the re-test cycle ${input.cycleId} for ${c.signature}`, found: `Still failing: ${evidence}`, next: 'Investigate the failing call and fix again' } });
          done.push(`#${c.number} commented still failing`);
        }
      }
    }
    const rows = checks.map((c) => `#${c.number} ${c.title} [${c.signature ?? 'no call mentioned'}] - ${c.verdict}${c.calls.length ? `: ${c.calls.slice(0, 5).map((x) => `${x.label} (${x.ref})`).join('; ')}${c.calls.length > 5 ? ` +${c.calls.length - 5} more` : ''}` : ''}`);
    const fitted = fitItems(rows, 400 + JSON.stringify(done).length);
    return ok({ checks: fitted.items, total: checks.length, ...(input.apply ? { applied: done } : {}), ...(fitted.cut ? { more: 'Some checks did not fit.' } : {}) });
  }));

  // ------------------------------------------------------------------------------------------------------------ writing

  server.registerTool('board_add', {
    description: 'Put a finding on the board. It always lands in the Inbox for the user to sort. Mention evidence in the description as '
      + '@[type:ref|label] (e.g. @[call:in:<id>|POST /orders · 500], @[stmt:<callId>/<seq>|INSERT ORDERS #88]) and pass the main call in links. '
      + 'Check board_similar / board_for_call first. Refused while the user paused the board, and when the user already closed the same problem '
      + 'as Fine or Not in this flow - the refusal says which card and why.',
    inputSchema: {
      project: Project,
      kind: Kind,
      title: z.string().min(1).max(300),
      description: z.string().max(256 * 1024).default(''),
      flags: z.array(Flag).default([]),
      cycleId: z.string().optional(),
      links: z.array(Link).max(100).default([]),
    },
  }, (input) => run(async () => {
    const card = await client.post<CardRow>('/board/cards', {
      ...AS_CLAUDE,
      body: { project: input.project, kind: input.kind, title: input.title, description: input.description, flags: input.flags,
        cycleId: input.cycleId, links: input.links },
    });
    return ok({ added: `#${card.number}`, status: card.status, card: line(card) });
  }));

  server.registerTool('board_add_many', {
    description: 'Several findings from one scan, each like board_add (Inbox, duplicate check). Each one says added or why it was refused.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional(),
      cards: z.array(z.object({
        kind: Kind, title: z.string().min(1).max(300), description: z.string().max(64 * 1024).default(''), flags: z.array(Flag).default([]),
        links: z.array(Link).max(50).default([]),
      })).min(1).max(30),
    },
  }, (input) => run(async () => {
    const results: string[] = [];
    for (const c of input.cards) {
      try {
        const card = await client.post<CardRow>('/board/cards', { ...AS_CLAUDE, body: { project: input.project, cycleId: input.cycleId, ...c } });
        results.push(`added #${card.number} ${c.title}`);
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
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { did: input.did, found: input.found, next: input.next, impact: input.impact } });
    return ok({ commented: `#${card.number}` });
  }));

  server.registerTool('board_reply', {
    description: 'Answer the user on a card in your own words (shown as "Reply" in the history). Mentions work: @[call:in:<id>|label].',
    inputSchema: { project: Project, number: CardNumber, text: z.string().min(1).max(64 * 1024) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    await client.post(`/board/cards/${seg(card.id)}/comments`, { ...AS_CLAUDE, body: { reply: input.text } });
    return ok({ replied: `#${card.number}` });
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
    },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
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
    return ok({ recorded: `#${card.number}`, moved });
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
    description: 'Propose a step only the user takes: VERIFIED (a Fixed card), DONE (Fixed or Verified), or CLOSED with a resolution '
      + '(FINE, NOT_IN_FLOW, WONT_FIX). The card shows it with Accept / Dismiss; a new proposal replaces the open one. Give the evidence as mentions.',
    inputSchema: {
      project: Project, number: CardNumber, status: z.enum(['VERIFIED', 'DONE', 'CLOSED']), resolution: Resolution.optional(),
      reason: z.string().max(2000).default(''), evidence: z.string().max(8 * 1024).default(''),
    },
  }, (input) => run(async () => {
    if (input.status === 'CLOSED' && !input.resolution) throw invalid('A close needs a resolution: FINE, NOT_IN_FLOW or WONT_FIX.');
    const card = await cardByNumber(client, input.project, input.number);
    const updated = await client.put<CardRow>(`/board/cards/${seg(card.id)}/proposal`, { ...AS_CLAUDE,
      body: { status: input.status, resolution: input.status === 'CLOSED' ? input.resolution : null, reason: input.reason, evidence: input.evidence } });
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

  server.registerTool('board_status', {
    description: 'Tell the board what you are doing (the live strip): WATCHING a cycle with counts, or STOPPED. Returns paused: true when the user paused you - stop adding cards then.',
    inputSchema: {
      project: Project,
      cycleId: z.string().optional(),
      state: z.enum(['WATCHING', 'STOPPED']).default('WATCHING'),
      callsChecked: z.number().int().min(0).default(0),
      cardsAdded: z.number().int().min(0).default(0),
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

