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

export async function cardContext(client: AlfredClient, ctx: MaskContext, changes: readonly ChangeRow[]): Promise<Record<string, unknown>> {
  const first = changes[0];
  const card: CardRow = await cardByNumber(client, first.project, first.number);
  const entries = await history(client, card.id);
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
      + 'user\'s changes come back, never your own. paused: true = the user paused Claude on the live strip; answer nothing until it clears.',
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
    let page = await client.get<ChangesPage>('/board/changes/wait', {
      query: { ...query, cursor: input.cursor, timeoutSeconds: input.timeoutSeconds },
      timeoutMs: (input.timeoutSeconds + 10) * 1000,
    });
    beat(client.baseUrl, project);
    const paused = input.project !== undefined
      ? (await client.get<{ state: string } | null>('/board/agent-status', { query: { project: input.project } }).catch(() => null))?.state === 'PAUSED'
      : false;
    if (!page.entries.length && !page.cycles.length) {
      return ok({ nothing: 'No change from the user yet.', cursor: page.cursor, ...(paused ? { paused: true } : {}),
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
      .map((g) => cardContext(client, ctx, g).catch((e) => ({ card: `#${g[0].number}`, error: String(e) }))));
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
      ...(paused ? { paused: true } : {}),
      ...(page.more ? { more: 'More changes are waiting - the next board_live returns them at once.' } : {}),
      next: `Answer each card (board_reply / board_comment / board_ask), then board_live with this cursor.`,
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('board_live_stop', {
    description: 'For /alfred-live: says it stopped, so board_wait in other sessions on this machine stops leaving the user\'s changes to it.',
    inputSchema: { project: z.string().optional() },
  }, (input) => run(async () => {
    beat(client.baseUrl, input.project ?? null, true);
    return ok({ stopped: true });
  }));
}
