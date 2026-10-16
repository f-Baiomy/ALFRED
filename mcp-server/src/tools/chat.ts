import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { maskContext, maskMeta, maskProseWith, maskText, type MaskContext } from '../masking.ts';
import { invalid, ok, run } from '../reply.ts';
import { ReadableWriter } from '../readable.ts';
import { boardText } from '../board-text.ts';

/**
 * The board chats (specs/022 contracts/mcp-tools.md). A cycle's chat is answered by the cycle's own Claude session (a fork
 * of the terminal session, kept by the runner); the project chat by the project's live runner. Claude takes a waiting
 * message, answers it once, and records on the board what another session needs to continue - the board's Claude limits
 * apply to every record. What the chat sends the terminal session is always masked here (the one masking implementation),
 * never in the backend.
 */
const AS_CLAUDE: Pick<RequestOptions, 'headers' | 'timeoutMs'> = { headers: { 'X-Alfred-Actor': 'claude' }, timeoutMs: 30_000 };
const Project = z.string().default('').describe('Project name; "" is "No project"');
const Scope = z.string().min(1).max(100).describe('"project" for the project chat, else the session cycle id');
const MessageId = z.number().int().min(1);

/** A prose part longer than this travels to the terminal as a reference (chat_read), not inline. */
export const MIRROR_INLINE_BLOCK = 400;
/** The mirrored answer is cut here - the rest is one chat_read away. */
export const MIRROR_MAX = 6000;

export interface ChatMessageRow {
  readonly id: number;
  readonly project: string;
  readonly scope: string;
  readonly parentId: number | null;
  readonly author: 'USER' | 'CLAUDE' | 'ALFRED';
  readonly kind: string;
  readonly text: string;
  readonly state: string;
  readonly urgent: boolean;
  readonly origin: string | null;
  readonly context: readonly string[];
  readonly quote: string | null;
  readonly extra: Record<string, unknown> | null;
  readonly coversTo: number | null;
  /** where a bridged message came from: "terminal" (the terminal session asked), "project" */
  readonly bridgeFrom?: string | null;
  readonly replyTo: number | null;
  readonly createdAt: string;
}

interface TakeReply {
  readonly message: ChatMessageRow;
  readonly thread: readonly ChatMessageRow[];
  readonly summary: ChatMessageRow | null;
}

const RecordSchema = z.object({
  kind: z.enum(['DECISION', 'CARD', 'ITEM', 'FIX', 'NEXT']),
  text: z.string().min(1).max(8000).describe('The decision, the question left open, or the line the chat shows'),
  card: z.object({ kind: z.enum(['BUG', 'TASK', 'NOTE', 'QUESTION']).default('BUG'), title: z.string().min(1).max(200),
    description: z.string().max(64 * 1024).default('') }).optional().describe('CARD: the Inbox card to add'),
  item: z.object({ file: z.string().min(1).max(200), text: z.string().min(1).max(4000), evidence: z.string().max(4000).optional() })
    .optional().describe('ITEM: the acceptance item to propose (the user accepts it)'),
  fix: z.object({ card: z.number().int().min(1), report: z.string().min(1).max(64 * 1024), plan: z.string().max(16 * 1024).optional() })
    .optional().describe('FIX: the fix report on that card, with its re-test plan'),
});

const TerminalSchema = z.object({
  text: z.string().min(1).max(16 * 1024),
  urgent: z.boolean().default(false),
  reason: z.enum(['contradicts', 'changed-files', 'addressed', 'compact', 'exchange']).default('addressed'),
});

/**
 * The exchange as the terminal session reads it (FR-050): the question and the answer in full prose, a code block or a
 * long part as a reference to read only when needed, masked always.
 */
export function mirrorText(ctx: MaskContext, question: ChatMessageRow, answer: string, answerRef: string): string {
  const shrink = (text: string, ref: string): string => text.replace(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g, (block, lang: string, body: string) =>
    body.length <= MIRROR_INLINE_BLOCK ? block : `[${lang || 'code'} block, ${body.split('\n').length} lines - ${ref}]`);
  let a = shrink(answer, answerRef);
  if (a.length > MIRROR_MAX) a = `${a.slice(0, MIRROR_MAX)}… [the rest - ${answerRef}]`;
  const q = shrink(question.text, `chat_read {"project":"${question.project}","scope":"${question.scope}","id":${question.id}}`);
  return maskProseWith(ctx, `💬 board chat #${question.id} - you asked: ${q}\nClaude answered: ${a}`);
}

/** One message for Claude to read: who, when, the text, and what it points at. */
export function messageLine(ctx: MaskContext, m: ChatMessageRow): string {
  const who = m.author === 'USER' ? 'user' : m.author === 'CLAUDE' ? 'you' : 'Alfred';
  const head = `#${m.id} ${m.createdAt.slice(0, 16).replace('T', ' ')} ${who}${m.kind !== 'TEXT' ? ` (${m.kind.toLowerCase()})` : ''}`
    + `${m.urgent ? ' ⚡urgent' : ''}${m.parentId ? ` ↳ in thread #${m.parentId}` : ''}`;
  const quote = m.quote ? `\n> ${maskText(ctx, m.quote).replace(/\n/g, '\n> ')}` : '';
  const looking = m.context.length ? `\n(looking at: ${m.context.join(', ')})` : '';
  return `${head}:${quote}\n${maskText(ctx, m.text)}${looking}`;
}

/** The `part` of a message: a fenced block of that language, or a visual Claude attached. */
export function partOf(m: ChatMessageRow, part: string): string | null {
  if (part === 'visual') {
    const v = m.extra?.['visual'];
    return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v);
  }
  const blocks = [...m.text.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)].filter((b) => part === 'code' || b[1] === part);
  return blocks.length ? blocks.map((b) => b[2]).join('\n') : null;
}

async function message(client: AlfredClient, id: number): Promise<ChatMessageRow> {
  return client.get<ChatMessageRow>(`/board/chats/messages/${id}`);
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('chat_take', {
    description: 'Take a board chat message to answer (from board_changes / board_wait `chats`). Returns the message, its thread, what the '
      + 'user was looking at and the chat\'s latest summary. Refused when another chat holds the cycle, or when it was taken or cancelled - '
      + 'then leave it. Answer it once with chat_reply.',
    inputSchema: { project: Project, scope: Scope, messageId: MessageId,
      chatId: z.string().min(1).max(100).describe('Your chat/runner id - the one holding this cycle') },
  }, (input) => run(async () => {
    const ctx = await maskContext(client);
    const taken = await client.post<TakeReply>(`/board/chats/messages/${input.messageId}/take`, { ...AS_CLAUDE,
      body: { chatId: input.chatId, ...(input.scope === 'project' ? {} : { cycleId: input.scope }) } });
    return ok({
      take: messageLine(ctx, taken.message),
      ...(taken.thread.length ? { thread: taken.thread.map((m) => messageLine(ctx, m)) } : {}),
      ...(taken.summary ? { summary: messageLine(ctx, taken.summary) } : {}),
      then: `Answer with chat_reply {"project":${JSON.stringify(input.project)},"messageId":${input.messageId},"text":"…"} - add records for what `
        + 'another session needs (a decision, a new problem, an acceptance item, a code change, an open question).',
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('chat_reply', {
    description: 'Answer a board chat message you took. Mentions work (@[call:in:<id>|label], #47, AC8 become chips). `records`: what another '
      + 'session needs to continue - DECISION (brief), CARD (Inbox), ITEM (proposed acceptance item), FIX (fix report + re-test), NEXT (open '
      + 'question) - each shows in the chat with Undo; plain explanations need none. `toTerminal`: urgent items for the terminal session '
      + '(a contradicting decision, a change to files it edited, a message addressed to it) - the exchange itself is mirrored for you. '
      + '`updateId` edits your earlier answer in place (watch batches).',
    inputSchema: {
      project: Project, messageId: MessageId, text: z.string().min(1).max(64 * 1024),
      records: z.array(RecordSchema).max(20).optional(),
      toTerminal: z.array(TerminalSchema).max(10).optional(),
      extra: z.record(z.string(), z.unknown()).optional().describe('shown under the answer. `questions`: 1-4 of {header, question, why?, '
        + 'multiSelect?, options: [{label, then?, recommended?, description?}]} - the user answers all or some at once and the answers come back '
        + 'to you as one message in the thread (as on cards: one Recommended, `then` says what you will do). `proposals`: [{id, text, kind: '
        + 'verify {card} | close {card, reason} | move {card, status} | mark {file, itemKey, mark: PASS|FAIL|CANT_TELL, evidence} | item {file, item}}] '
        + '- the user accepts or declines, each checked against the board again first, applied as the user. `consent`: {kind: resend|rule, '
        + 'summary, call: "in:<id>[@cycle]"} - opens the resend dialog or rule editor only after the user says yes; nothing runs from the chat.'),
      updateId: MessageId.optional(),
    },
  }, (input) => run(async () => {
    const question = await message(client, input.messageId);
    if (question.project !== input.project) throw invalid(`Message #${input.messageId} is in project "${question.project}", not "${input.project}"`);
    const w = new ReadableWriter(client, { project: input.project, cycleId: question.scope === 'project' ? null : question.scope });
    // HTML the board draws becomes board text, HTML with script/style/SVG a ```html live snippet - as on cards (board-text.ts).
    const board = boardText(input.text);
    const text = await w.text(board.text, 64 * 1024);
    const records = input.records ? await Promise.all(input.records.map(async (r) => ({ ...r, text: await w.text(r.text),
      ...(r.card ? { card: { ...r.card, description: await w.text(r.card.description) } } : {}),
      ...(r.fix ? { fix: { ...r.fix, report: await w.text(r.fix.report) } } : {}) }))) : undefined;
    const ctx = await maskContext(client, true);
    // The terminal session itself answers a cycle chat (plan-terminal-answers.md): nothing goes back to it - it wrote this.
    const byTerminal = question.scope !== 'project' && await client.get<{ session: { answeredByTerminal?: boolean } | null }>(
      `/board/chats/${seg(question.scope)}/context`, { query: { project: input.project } }).then((c) => c.session?.answeredByTerminal === true, () => false);
    const toTerminal = question.scope === 'project' || byTerminal ? [] : [
      ...(input.toTerminal ?? []).map((t) => ({ text: maskProseWith(ctx, t.text), urgent: t.urgent, reason: t.reason, mirror: false })),
      // One item per exchange (FR-050): an answer edited in place is not sent again, and a question the terminal asked is not echoed back.
      ...(input.updateId || question.bridgeFrom === 'terminal' ? [] : [{ text: mirrorText(ctx, question, text,
        `chat_read {"project":${JSON.stringify(input.project)},"scope":"${question.scope}","answerOf":${question.id}}`),
        urgent: false, reason: 'exchange', mirror: true }]),
    ];
    const stored = await client.post<{ message: ChatMessageRow; records: { line: string }[]; terminal: { id: number; urgent: boolean; state: string }[] }>(
      `/board/chats/messages/${input.messageId}/reply`, { ...AS_CLAUDE, body: { text, ...(records ? { records } : {}), toTerminal,
        ...(input.extra ? { extra: input.extra } : {}), ...(input.updateId ? { updateId: input.updateId } : {}) } });
    const shown = chatSnippetIds(stored.message.id, text);
    return ok({
      replied: `#${stored.message.id}`,
      ...(shown.length ? { snippets: `${shown.length} live snippet${shown.length === 1 ? '' : 's'} in the answer: ${shown.join(', ')} - once the `
        + 'chat has shown it, board_snippet_view <id> gives its picture and console' + (board.snippets ? ` (${board.snippets} made from your HTML)` : '') } : {}),
      ...(stored.records.length ? { recorded: stored.records.map((r) => `✓ ${r.line}`) } : {}),
      ...(stored.terminal.some((t) => t.urgent) ? { toTerminal: stored.terminal.filter((t) => t.urgent).map((t) => `⚡ item ${t.id} (${t.state})`) } : {}),
      ...w.report(),
    });
  }));

  server.registerTool('chat_read', {
    description: 'Read a board chat: one message whole (`id`), your answer to one (`answerOf`), one part of either (`part`: diff, sql, '
      + 'code, visual - what a mirrored reference points to), or a page of messages (`before`, `limit`).',
    inputSchema: { project: Project, scope: Scope, id: MessageId.optional(), answerOf: MessageId.optional(),
      part: z.enum(['diff', 'sql', 'code', 'visual']).optional(),
      before: MessageId.optional(), limit: z.number().int().min(1).max(100).default(30) },
  }, (input) => run(async () => {
    const ctx = await maskContext(client);
    if (input.id != null || input.answerOf != null) {
      const m = input.id != null ? await message(client, input.id)
        : await client.get<ChatMessageRow>(`/board/chats/messages/${input.answerOf}/answer`);
      if (input.part) {
        const part = partOf(m, input.part);
        return ok(part == null ? { nothing: `Message #${m.id} has no ${input.part} part.` } : { id: m.id, part: input.part, text: maskText(ctx, part), ...maskMeta(ctx) });
      }
      return ok({ message: messageLine(ctx, m), ...maskMeta(ctx) });
    }
    const page = await client.get<{ messages: ChatMessageRow[]; more: boolean }>(`/board/chats/${seg(input.scope)}/messages`,
      { query: { project: input.project, limit: input.limit, ...(input.before ? { before: input.before } : {}) } });
    return ok({ messages: page.messages.map((m) => messageLine(ctx, m)),
      ...(page.more && page.messages.length ? { older: `chat_read with before=${page.messages[0].id}` } : {}), ...maskMeta(ctx) });
  }));

  server.registerTool('chat_summary', {
    description: 'Compact a board chat: write the summary of everything up to `coversTo` - decisions, findings, open questions as chips '
      + '(#47, AC8, @[call:…]). Nothing is deleted; the messages fold under it and a new session starts from it.',
    inputSchema: { project: Project, scope: Scope, text: z.string().min(1).max(64 * 1024), coversTo: MessageId },
  }, (input) => run(async () => {
    const w = new ReadableWriter(client, { project: input.project, cycleId: input.scope === 'project' ? null : input.scope });
    const text = await w.text(input.text, 64 * 1024);
    const stored = await client.post<ChatMessageRow>(`/board/chats/${seg(input.scope)}/summary`,
      { ...AS_CLAUDE, query: { project: input.project }, body: { text, coversTo: input.coversTo } });
    return ok({ summary: `#${stored.id}`, covers: `up to #${input.coversTo}`, ...w.report() });
  }));

  server.registerTool('chat_watch', {
    description: 'Tell the user when something happens (the user asked "tell me when …"): an acceptance item passes (ITEM_PASSES, target = '
      + 'the item key), a status shows up (STATUS, target = "5xx" or "404"), or an error is logged (ERROR_LOG, target = an endpoint). Alfred '
      + 'posts in the chat when it fires - no model, no polling.',
    inputSchema: { project: Project, scope: Scope, kind: z.enum(['ITEM_PASSES', 'STATUS', 'ERROR_LOG']), target: z.string().min(1).max(200),
      label: z.string().min(1).max(200), messageId: MessageId },
  }, (input) => run(async () => {
    const stored = await client.post<{ id: number }>(`/board/chats/${seg(input.scope)}/watches`,
      { ...AS_CLAUDE, query: { project: input.project }, body: { kind: input.kind, target: input.target, label: input.label, messageId: input.messageId } });
    return ok({ watching: input.label, id: stored.id });
  }));

  server.registerTool('chat_mirror', {
    description: 'Runner only: send the terminal session of a cycle what its chat did outside an answer (a compact pointer). Masked always.',
    inputSchema: { project: Project, scope: Scope, items: z.array(TerminalSchema).min(1).max(10) },
  }, (input) => run(async () => {
    if (input.scope === 'project') throw invalid('The project chat has no terminal session');
    const ctx = await maskContext(client, true);
    const stored = await client.post<{ id: number; state: string }[]>(`/board/chats/${seg(input.scope)}/terminal`, { ...AS_CLAUDE,
      query: { project: input.project },
      body: { items: input.items.map((t) => ({ text: maskProseWith(ctx, t.text), urgent: t.urgent, reason: t.reason, mirror: t.reason !== 'compact' })) } });
    return ok({ stored: stored.map((s) => `item ${s.id} (${s.state})`) });
  }));
}

/**
 * The ids the chat gives the live snippets of an answer (chat-message.component's snippet owner): `inline:chat:<message>:a:<n>`,
 * n counting the answer's ```html live / ```python live / ```mermaid blocks in order - the ids board_snippet_view reads.
 */
export function chatSnippetIds(messageId: number, text: string): string[] {
  const ids: string[] = [];
  let n = 0;
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const open = /^\s*(`{3,}|~{3,})\s*([\w-]*)(.*)$/.exec(line);
    if (fence) {
      if (open && open[1].startsWith(fence) && !open[2] && !open[3].trim()) fence = null;
      continue;
    }
    if (!open) continue;
    fence = open[1];
    const lang = open[2].toLowerCase();
    if (lang === 'mermaid' || ((lang === 'html' || lang === 'python') && /\blive\b/.test(open[3]))) ids.push(`inline:chat:${messageId}:a:${n++}`);
  }
  return ids;
}
