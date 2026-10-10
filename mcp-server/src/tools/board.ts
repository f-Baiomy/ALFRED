import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { maskContext, maskMeta, maskText } from '../masking.ts';
import { chunkText, fitItems, ok, preview, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

/**
 * The task board (specs/014-task-board contracts/mcp-tools.md). Every request says it is Claude, and the backend holds
 * Claude to its limits whatever is asked: new cards land in the Inbox, moves only to To do / In progress / Fixed, no
 * scope, closing, reopening or deleting, and a card that repeats one the user closed as Fine or Not in this flow is
 * refused with that card's reason. The tools simply do not offer the rest; a refusal comes back word for word.
 */
const AS_CLAUDE: Pick<RequestOptions, 'headers'> = { headers: { 'X-Alfred-Actor': 'claude' } };

const Kind = z.enum(['BUG', 'TASK', 'NOTE', 'QUESTION']);
const Status = z.enum(['INBOX', 'TO_DO', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'DONE', 'CLOSED']);
const Flag = z.enum(['URGENT', 'RISK', 'BLOCKER', 'AFFECTS_PROJECT', 'NEEDS_DECISION']);
const Link = z.object({
  type: z.enum(['call', 'stmt', 'log', 'redis', 'spec', 'code', 'cycle', 'spacer', 'card', 'rule']),
  ref: z.string().min(1).max(1000).describe('As in contracts/mention-syntax.md, e.g. "in:<callId>", "<callId>/<seq>", "<cycleId>/spec.md#acceptance"'),
  label: z.string().min(1).max(200),
});

interface CardRow {
  id: string; project: string; number: number; kind: string; title: string; status: string; resolution: string | null; reason: string | null;
  flags: string[]; scope: string; author: string; cycleId: string | null; cycleDeleted: boolean; updatedAt: string; commentCount: number;
  similarClosed: { number: number; resolution: string; reason: string | null } | null; description?: string;
  links?: { type: string; ref: string; label: string }[];
}

interface ActivityRow {
  actor: string; kind: string; text: string | null; oldValue: string | null; newValue: string | null; at: string;
}

function line(c: CardRow): string {
  const flags = c.flags.length ? ` [${c.flags.join(', ')}]` : '';
  const state = c.resolution ? `${c.status} (${c.resolution}${c.reason ? `: ${c.reason}` : ''})` : c.status;
  return `#${c.number} ${c.kind}${flags} ${c.title} - ${state}${c.cycleId ? ` (cycle ${c.cycleId}${c.cycleDeleted ? ', deleted' : ''})` : ''}`
    + `${c.author === 'CLAUDE' ? ' ✦' : ''}${c.commentCount ? ` · ${c.commentCount} comments` : ''}`;
}

async function cardByNumber(client: AlfredClient, project: string, number: number): Promise<CardRow> {
  return client.get<CardRow>(`/board/cards/by-number/${seg(number)}`, { query: { project }, notFound: `No card #${number} on the ${project || 'No project'} board.` });
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('board_list', {
    description: 'Cards on a project\'s task board (or one cycle\'s): "#n KIND [flags] title - status (cycle)". Read board_closed_reasons before reporting a finding.',
    inputSchema: {
      project: z.string().default('').describe('Project name; "" is "No project"'),
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

  server.registerTool('board_get', {
    description: 'One card in full - description with its mentions, Linked list and the whole history oldest first. Read it before you continue work on a card.',
    inputSchema: {
      project: z.string().default(''),
      number: z.number().int().min(1),
      offset: z.number().int().min(0).default(0).describe('Where to continue a long description'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const card = await cardByNumber(client, input.project, input.number);
    const history = await client.get<{ entries: ActivityRow[]; total: number }>(`/board/cards/${seg(card.id)}/activity`, { query: { limit: 1000 } });
    return ok({
      card: line(card),
      scope: card.scope,
      description: chunkText(maskText(ctx, card.description ?? ''), input.offset, 8000),
      links: (card.links ?? []).map((l) => `${l.type.toLowerCase()} ${l.ref} - ${maskText(ctx, l.label)}`),
      history: history.entries.map((e) => e.kind === 'COMMENT'
        ? `${e.at} ${e.actor === 'CLAUDE' ? 'Claude' : 'User'}: ${preview(maskText(ctx, e.text ?? ''), 2000, 'board_get')}`
        : `${e.at} ${e.actor === 'CLAUDE' ? 'Claude' : 'User'} ${e.kind} ${e.oldValue ?? ''} → ${e.newValue ?? ''}${e.text ? ` (${e.text})` : ''}`),
      historyTotal: history.total,
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('board_add', {
    description: 'Put a finding on the board. It always lands in the Inbox for the user to sort. Mention evidence in the description as '
      + '@[type:ref|label] (e.g. @[call:in:<id>|POST /orders · 500], @[stmt:<callId>/<seq>|INSERT ORDERS #88]) and pass the main call in links. '
      + 'Refused while the user paused the board, and when the user already closed the same problem as Fine or Not in this flow - the refusal says which card and why.',
    inputSchema: {
      project: z.string().default(''),
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

  server.registerTool('board_comment', {
    description: 'Record progress on a card: what you did, what you found, what comes next, and (when a change touches shared code) its impact. '
      + 'All of did/found/next are needed - another session or the user picks the work up from these.',
    inputSchema: {
      project: z.string().default(''),
      number: z.number().int().min(1),
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

  server.registerTool('board_move', {
    description: 'Move a card to To do, In progress or Fixed. Verified, Done and closing are the user\'s - propose them in board_comment.',
    inputSchema: { project: z.string().default(''), number: z.number().int().min(1), status: z.enum(['TO_DO', 'IN_PROGRESS', 'FIXED']) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const moved = await client.post<CardRow>(`/board/cards/${seg(card.id)}/move`, { ...AS_CLAUDE, body: { status: input.status } });
    return ok({ moved: line(moved) });
  }));

  server.registerTool('board_flag', {
    description: 'Add or remove flags on a card (URGENT, RISK, BLOCKER, AFFECTS_PROJECT, NEEDS_DECISION).',
    inputSchema: { project: z.string().default(''), number: z.number().int().min(1), add: z.array(Flag).default([]), remove: z.array(Flag).default([]) },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    const flags = [...new Set([...card.flags.filter((f) => !input.remove.includes(f as never)), ...input.add])];
    const updated = await client.patch<CardRow>(`/board/cards/${seg(card.id)}`, { ...AS_CLAUDE, body: { flags } });
    return ok({ flagged: line(updated) });
  }));

  server.registerTool('board_closed_reasons', {
    description: 'What the user already dismissed on this project\'s board - closed cards with their resolution, reason and signature. Read before reporting, '
      + 'and do not raise an issue closed as FINE or NOT_IN_FLOW again.',
    inputSchema: { project: z.string().default(''), limit: z.number().int().min(1).max(500).default(200) },
  }, (input) => run(async () => {
    const reasons = await client.get<{ number: number; title: string; signature: string | null; resolution: string; reason: string | null }[]>(
      '/board/closed-reasons', { query: { project: input.project, limit: input.limit } });
    return ok({ closed: reasons.map((r) => `#${r.number} ${r.title} - ${r.resolution}${r.reason ? `: ${r.reason}` : ''}${r.signature ? ` [${r.signature}]` : ''}`) });
  }));

  server.registerTool('get_brief', {
    description: 'A session cycle\'s brief (what it is for, the task, the steps) and its spec files.',
    inputSchema: { cycleId: z.string().min(1) },
  }, (input) => run(async () => {
    const [brief, specs] = await Promise.all([
      client.get<{ text: string; updatedAt: string | null }>(`/board/cycles/${seg(input.cycleId)}/brief`),
      client.get<{ name: string; size: number; uploadedAt: string }[]>(`/board/cycles/${seg(input.cycleId)}/specs`),
    ]);
    return ok({ brief: brief.text || '(no brief yet)', updatedAt: brief.updatedAt, specFiles: specs.map((s) => `${s.name} (${s.size} bytes)`) });
  }));

  server.registerTool('read_spec', {
    description: 'A spec file of a cycle, or one section of it (the heading\'s text or slug), plus the user\'s acceptance checklist marks.',
    inputSchema: {
      cycleId: z.string().min(1),
      name: z.string().min(1),
      section: z.string().optional(),
      offset: z.number().int().min(0).default(0),
    },
  }, (input) => run(async () => {
    const text = await client.get<string>(`/board/cycles/${seg(input.cycleId)}/specs/${seg(input.name)}`, { text: true, notFound: `No spec file ${input.name} in this cycle.` });
    const checklist = await client.get<{ fileName: string; items: { text: string; mark: { mark: string; evidence: string } | null }[] }[]>(
      `/board/cycles/${seg(input.cycleId)}/checklist`).catch(() => []);
    const body = input.section ? sectionOf(text, input.section) : text;
    const items = checklist.find((f) => f.fileName === input.name)?.items ?? [];
    return ok({
      spec: chunkText(body, input.offset, 12_000),
      checklist: items.map((i) => `${i.mark ? i.mark.mark : 'UNMARKED'} - ${i.text}${i.mark?.evidence ? ` (evidence: ${i.mark.evidence})` : ''}`),
    });
  }));

  server.registerTool('board_status', {
    description: 'Tell the board what you are doing (the live strip): WATCHING a cycle with counts, or STOPPED. Returns paused: true when the user paused you - stop adding cards then.',
    inputSchema: {
      project: z.string().default(''),
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
