import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { ok, run } from '../reply.ts';
import {
  type ActivityRow, type CardRow, type ChangeRow, type ChangesPage, cardByNumber, entryLine, history, isQuestion, line, stripLabel, who,
} from './board.ts';
import { MaskSchema } from './cycles.ts';

/**
 * /alfred-live (skills/alfred-live): Claude answering the user on the board as they work. One call waits for the user's
 * next change (the board's own change signal - no polling), lets a quick burst settle, and hands back each touched card
 * with what the user did, the recent thread with history indexes, the open questions and what kind of answer fits - so
 * the reply is one more call, not three. While it runs it keeps a heartbeat so a listen in another session leaves the
 * user's changes to it (board_wait says so).
 */

/** The last few history entries a reply needs; older ones are a board_get away. */
const THREAD = 8;
/** At most this many cards per call; the rest come on the next call (the cursor stops before them). */
const MAX_CARDS = 8;
/** A heartbeat older than this means no /alfred-live is running. */
const ALIVE_MS = 120_000;
/** A call that waits (up to 50 s) or reads many cards refreshes the heartbeat this often, so it never lapses under ALIVE_MS meanwhile. */
const BEAT_EVERY_MS = 20_000;
/** While the board is paused, board_live looks at the pause this often - it has no change signal of its own. */
const PAUSE_RECHECK_MS = 5_000;

function heartbeatFile(baseUrl: string): string {
  return join(tmpdir(), `alfred-live-${createHash('sha1').update(baseUrl).digest('hex').slice(0, 12)}.json`);
}

/**
 * Who answers the user right now on this Alfred: the /alfred-live runner's heartbeat Alfred holds (the runner may be on
 * any machine - the user's, while Alfred runs on a LAN host), else a board_live loop on this machine.
 */
export async function liveAnswerer(client: AlfredClient, project?: string): Promise<{ project: string | null; host?: string } | null> {
  const runner = await client.get<{ project: string; host: string } | undefined>('/board/live-runner', { query: { project: project ?? '' } })
    .catch(() => undefined);
  if (runner) return { project: runner.project || null, host: runner.host };
  const local = liveHolder(client.baseUrl);
  return local && (!local.project || !project || local.project === project) ? local : null;
}

/** A board_live loop in a session on this machine - null when none is running. */
export function liveHolder(baseUrl: string, now = Date.now()): { project: string | null; at: string } | null {
  try {
    const beat = JSON.parse(readFileSync(heartbeatFile(baseUrl), 'utf8')) as { project: string | null; at: string; stopped?: boolean };
    return !beat.stopped && now - Date.parse(beat.at) < ALIVE_MS ? beat : null;
  } catch {
    return null;
  }
}

export function beat(baseUrl: string, project: string | null, stopped = false): void {
  try {
    writeFileSync(heartbeatFile(baseUrl), JSON.stringify({ project, at: new Date().toISOString(), stopped }));
  } catch {
    // a heartbeat is a courtesy to other sessions; never fail the call for it
  }
}

/** Runs `work` (a long wait) with the heartbeat refreshed every `everyMs`, so it is still fresh when the wait ends. */
export async function whileBeating<T>(baseUrl: string, project: string | null, work: () => Promise<T>, everyMs = BEAT_EVERY_MS): Promise<T> {
  const timer = setInterval(() => beat(baseUrl, project), everyMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** What kind of answer one change asks for. */
export function respondTo(e: ChangeRow, parent: ActivityRow | undefined, index: (id: number | undefined) => number | undefined): string {
  const i = index(e.id);
  const at = i === undefined ? '' : ` [${i}]`;
  switch (e.kind) {
    case 'COMMENT':
      if (parent && isQuestion(parent)) return `ANSWERS your question [${index(parent.id) ?? '?'}] - act on it now; reply in that thread (board_reply replyTo ${index(parent.id) ?? '?'}) with what it changes, then do it`;
      if (parent) return `replies to ${who(parent.actor)}${at} - answer in the thread (board_reply replyTo ${i ?? '?'})`;
      return /\?\s*$|^(why|what|how|can|could|is|are|does|do|should|where|when)\b/i.test(stripLabel(e.text))
        ? `asks you${at} - answer it in its thread (board_reply replyTo ${i ?? '?'}); investigate first only if the answer needs evidence, and say so in one line`
        : `comments${at} - answer in its thread when it asks for something or changes your work (board_reply replyTo ${i ?? '?'}); otherwise note it`;
    case 'STATUS':
      if (e.newValue === 'TO_DO') return 'moved it to To do - the user chose it to be fixed: say so in one line only if you hold more on it';
      if (e.newValue === 'FIXED') return 'moved it to Fixed - give the re-test steps in one line if the card has none (board_retest_plan)';
      if (e.newValue === 'VERIFIED' || e.newValue === 'DONE') return 'accepted the fix - nothing to answer';
      return `moved it ${e.oldValue ?? ''} → ${e.newValue ?? ''} - note it; answer only if it changes the plan`;
    case 'RESOLUTION':
    case 'REASON':
      return 'closed it with a reason - nothing to answer; a Fine / Not in this flow about a flow value is a check line to propose later';
    case 'PROPOSAL_DISMISSED': return 'dismissed your proposal - one state comment: what you will do instead';
    case 'PROPOSAL_ACCEPTED': return 'accepted your proposal - nothing to answer';
    case 'REOPENED': return 'reopened it - read why and answer what you will do';
    case 'DESCRIPTION':
    case 'TITLE':
    case 'KIND':
      return 'edited the card - re-read it; answer only if it changes your work';
    case 'FLAGS': return 'changed the flags - note it (Urgent goes first)';
    case 'TEAMS': return 'changed the teams - note it';
    default: return `${e.kind.toLowerCase()} - note it`;
  }
}

/** The changes a reply would act on twice: one per card, user actions only, oldest first. */
export function byCard(entries: readonly ChangeRow[]): Map<string, ChangeRow[]> {
  const out = new Map<string, ChangeRow[]>();
  for (const e of entries) {
    if (e.actor !== 'USER') continue;
    const key = `${e.project}\u0000${e.number}`;
    out.set(key, [...(out.get(key) ?? []), e]);
  }
  return out;
}

/**
 * One card ready to answer. The card and its history are read together when the change names the card's id (the board's changes do),
 * and with `heartbeat` the heartbeat is refreshed at the end - many cards of a long history take a while. A caller that is not the
 * loop (the runner's prefetch, board_live_card) passes none: it must not claim a board_live loop is running.
 */
export async function cardContext(client: AlfredClient, ctx: MaskContext, changes: readonly ChangeRow[],
  heartbeat?: { project: string | null }): Promise<Record<string, unknown>> {
  const first = changes[0];
  const cardRequest = cardByNumber(client, first.project, first.number);
  const [card, entries]: [CardRow, ActivityRow[]] = await Promise.all([
    cardRequest,
    first.cardId ? history(client, first.cardId) : cardRequest.then((c) => history(client, c.id)),
  ]);
  const indexOf = new Map(entries.map((e, i) => [e.id, i]));
  const byId = new Map(entries.filter((e) => e.id != null).map((e) => [e.id!, e]));
  const index = (id: number | undefined) => (id == null ? undefined : indexOf.get(id));
  const answered = new Set(entries.filter((e) => e.actor === 'USER' && e.replyTo != null).map((e) => e.replyTo));
  const start = Math.max(0, entries.length - THREAD);
  const thread = entries.slice(start).map((e, n) => {
    const i = start + n;
    const reply = e.replyTo != null ? `↳ reply to [${indexOf.get(e.replyTo) ?? '?'}] ` : '';
    const q = isQuestion(e) ? ` (question - ${answered.has(e.id) ? 'answered' : 'OPEN'})` : '';
    return `[${i}] ${reply}${entryLine(ctx, e, i, 1500)}${q}`;
  });
  const open = entries.map((e, i) => (isQuestion(e) && !answered.has(e.id) ? i : -1)).filter((i) => i >= 0);
  if (heartbeat) beat(client.baseUrl, heartbeat.project);
  return {
    card: `${card.project || '(No project)'} ${line(card)}`,
    project: card.project,
    number: card.number,
    userDid: changes.map((e) => respondTo(e, e.replyTo != null ? byId.get(e.replyTo) : undefined, index)),
    ...(card.description ? { description: maskText(ctx, card.description).slice(0, 1500) + (card.description.length > 1500 ? '… (board_get for the rest)' : '') } : {}),
    thread,
    ...(start > 0 ? { earlier: `${start} earlier entries - board_get for them` } : {}),
    ...(open.length ? { openQuestions: open } : {}),
  };
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('board_live', {
    description: 'For /alfred-live: waits (up to timeoutSeconds) for the user\'s next change on the board - a comment, a reply, an answer to '
      + 'your question, a move, a close, an edit - lets a quick burst settle (settleMs), then returns each touched card ready to answer: '
      + 'what the user did and what kind of answer fits, the recent thread with [indexes] for board_reply, open questions, and the brief / '
      + 'spec / mark changes in cycles. Woken by the board\'s change signal, never polling. Pass the returned cursor next time. Only the '
      + 'user\'s changes come back, never your own. paused: true = the user paused Claude on the live strip: the cursor comes back unchanged '
      + '(nothing is consumed), the call waits out its timeout, and you answer nothing until a call stops saying it.',
    inputSchema: {
      cursor: z.string().max(100).default('now').describe('"now" to start; then the cursor the last call returned'),
      project: z.string().optional().describe('One project; omit for every board'),
      cycleId: z.string().optional().describe('Only this session cycle\'s cards'),
      timeoutSeconds: z.number().int().min(1).max(50).default(50),
      settleMs: z.number().int().min(0).max(5000).default(1200).describe('After the first change, wait this long for the rest of a burst'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const project = input.project ?? null;
    beat(client.baseUrl, project);
    const query = { project: input.project, cycleId: input.cycleId, actor: 'USER' };
    const isPaused = async () => input.project !== undefined
      && (await client.get<{ state: string } | null>('/board/agent-status', { query: { project: input.project } }).catch(() => null))?.state === 'PAUSED';
    // Paused: nothing is answered and nothing is consumed - the cursor stays where the call found it, so what the user does meanwhile
    // comes back once they resume.
    const pausedReply = () => ok({ paused: true, cursor: input.cursor,
      nothing: 'The user paused Claude on the live strip - answer nothing. The cursor is unchanged: what they do meanwhile comes back when they resume.',
      next: `board_live ${JSON.stringify({ ...input, mask: undefined })}` });
    // A change after that cursor would end a wait at once, so while paused this call waits itself, out its timeout, instead of
    // handing the loop an instant answer to repeat.
    const deadline = Date.now() + input.timeoutSeconds * 1000;
    while (await isPaused()) {
      const left = deadline - Date.now();
      if (left <= 0) return pausedReply();
      beat(client.baseUrl, project);
      await new Promise((r) => setTimeout(r, Math.min(PAUSE_RECHECK_MS, left)));
    }
    const waitSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    let page = await whileBeating(client.baseUrl, project, () => client.get<ChangesPage>('/board/changes/wait', {
      query: { ...query, cursor: input.cursor, timeoutSeconds: waitSeconds },
      timeoutMs: (waitSeconds + 10) * 1000,
    }));
    beat(client.baseUrl, project);
    // Paused while it waited: what woke it is not consumed either.
    if (await isPaused()) return pausedReply();
    if (!page.entries.length && !page.cycles.length) {
      return ok({ nothing: 'No change from the user yet.', cursor: page.cursor,
        next: `board_live ${JSON.stringify({ ...input, cursor: page.cursor, mask: undefined })}` });
    }
    if (input.settleMs > 0) {
      // A burst (type an answer, then move the card) is one turn of work, not two.
      await new Promise((r) => setTimeout(r, input.settleMs));
      page = await client.get<ChangesPage>('/board/changes', { query: { ...query, cursor: input.cursor, limit: 200 } }).catch(() => page);
    }
    const ctx = await maskContext(client, input.mask);
    const groups = [...byCard(page.entries).values()];
    // Up to MAX_CARDS come with their thread; the rest as one line each (board_get when you reach them) - none is lost.
    const cards = await Promise.all(groups.slice(0, MAX_CARDS)
      .map((g) => cardContext(client, ctx, g, { project }).catch((e) => ({ card: `#${g[0].number}`, error: String(e) }))));
    const alsoChanged = groups.slice(MAX_CARDS).map((g) => `${g[0].project || '(No project)'} #${g[0].number} "${g[0].title}" - ${g.length} change(s): `
      + `${g.map((e) => e.kind.toLowerCase()).join(', ')} → board_get ${JSON.stringify({ project: g[0].project, number: g[0].number })}`);
    const cursor = page.cursor;
    const cycles = page.cycles.map((c) => `cycle ${c.cycleId}${c.name ? ` "${c.name}"` : ''}: ${c.what}${c.detail ? ` (${maskText(ctx, c.detail)})` : ''}`
      + (/brief/i.test(c.what) ? ' - re-read the brief (task_context) if it changes scope or decisions' : ''));
    return ok({
      cards,
      ...(alsoChanged.length ? { alsoChanged } : {}),
      ...(cycles.length ? { cycleChanges: cycles } : {}),
      cursor,
      ...(page.more ? { more: 'More changes are waiting - the next board_live returns them at once.' } : {}),
      next: `Answer each card (board_reply / board_comment / board_ask), then board_live with this cursor.`,
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('board_live_card', {
    description: 'For the /alfred-live runner\'s prefetch: the context to answer ONE card from changes the caller already holds - what '
      + 'the user did and what kind of answer fits, the recent thread with [indexes] for board_reply, the open questions - exactly as one card '
      + 'of board_live, without waiting. Pass the changes as the board returned them (kind, text, replyTo, oldValue, newValue...); a change '
      + 'that is not the user\'s is left out.',
    inputSchema: {
      project: z.string().default('').describe('Project name; "" is "No project"'),
      number: z.number().int().min(1),
      changes: z.array(z.object({
        id: z.number().int().nullish().describe('The history entry\'s id - lets a reply find the comment it answers'),
        kind: z.string().min(1).max(40).describe('COMMENT, STATUS, RESOLUTION, TEAMS, ...'),
        text: z.string().max(256 * 1024).nullish(),
        replyTo: z.number().int().nullish().describe('The id of the comment this one answers'),
        oldValue: z.string().max(10_000).nullish(),
        newValue: z.string().max(10_000).nullish(),
        actor: z.string().max(20).nullish().describe('USER (the default) or CLAUDE'),
        at: z.string().max(40).nullish(),
      })).min(1).max(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const mine = input.changes.filter((c) => (c.actor ?? 'USER').toUpperCase() === 'USER');
    if (!mine.length) return ok({ nothing: 'None of these changes is the user\'s - nothing to answer.' });
    const ctx = await maskContext(client, input.mask);
    const rows: ChangeRow[] = mine.map((c) => ({
      ...(c.id != null ? { id: c.id } : {}), actor: 'USER', kind: c.kind, text: c.text ?? null, oldValue: c.oldValue ?? null, newValue: c.newValue ?? null,
      at: c.at ?? new Date().toISOString(), replyTo: c.replyTo ?? null, project: input.project, number: input.number, title: '', status: '', cycleId: null,
    }));
    return ok({ ...(await cardContext(client, ctx, rows)), ...maskMeta(ctx) });
  }));

  server.registerTool('board_live_stop', {
    description: 'For /alfred-live: says it stopped, so board_wait in other sessions on this machine stops leaving the user\'s changes to it.',
    inputSchema: { project: z.string().optional() },
  }, (input) => run(async () => {
    beat(client.baseUrl, input.project ?? null, true);
    return ok({ stopped: true });
  }));
}
