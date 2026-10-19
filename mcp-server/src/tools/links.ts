import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient, type RequestOptions } from '../alfred-client.ts';
import { invalid, ok, run } from '../reply.ts';

/**
 * Streams between Alfreds (specs/035): what other Alfreds on the LAN stream to this one and what it streams out, and
 * this Alfred's own environment columns of boards other Alfreds host (D35-D41). Another Alfred's things carry its link's
 * tag - `<id>@<slug>` (a cycle `8f1c…@stg-83`, a card, a call) - and every read tool takes those refs like local ids: the
 * data is read live from its owner, masked there, nothing kept here. Writing on another Alfred's things is never direct:
 * links_request asks its owner (a comment, a question, a note), who accepts or rejects it.
 */

interface LinkRow {
  id: string; slug: string; name: string; peerName: string | null; address: string | null; online: boolean; rttMs: number | null;
  peerVersion: string | null; lastError: string | null; skewed: boolean; lastSeen: string | null;
}
interface StreamRow {
  id: string; mine: boolean; linkId: string; kind: 'CYCLE' | 'BOARD'; target: string; targetName: string | null; project: string | null;
  mode: 'VIEW' | 'COMMENT'; autoAccept: boolean; passOn: boolean; passMode: 'VIEW' | 'COMMENT'; unmasked: boolean; env: string | null;
  createdAt: string; endedAt: string | null;
}
interface RequestRow {
  id: string; streamId: string; linkId: string; incoming: boolean; kind: string; target: string; targetLabel: string | null; text: string;
  author: string; state: string; note: string | null; createdAt: string;
}
interface Assigned { hostSlug: string; hostName: string; hostOnline: boolean; boardId: string; boardName: string | null; project: string | null; env: string }
interface Column {
  name: string; verdict: string; missing: string[]; online: boolean; error: string | null;
  marks: { fileName: string; itemKey: string; mark: string; evidence: string; actor: string }[];
  steps: { stepKey: string; state: string; note: string | null }[];
  retests: { cardNumber: number; verdict: string; summary: string | null }[];
  cycles: { cycleRef: string; name: string | null; retestFor: number[] }[];
  asks: { items: { fileName: string; itemKey: string; text: string | null }[]; steps: string[]; fixedCards: number[] };
}

const REMOTE: Pick<RequestOptions, 'timeoutMs'> = { timeoutMs: 20_000 };
const Slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/).describe('The host Alfred\'s link tag, e.g. "pc-1" (env_boards lists them)');
const BoardId = z.string().min(1).max(200).describe('The host\'s own board id (env_boards lists them)');

/** "8f1c…@stg-83" → its link's tag and the owner's own id; a plain id is this Alfred's. */
export function splitRef(ref: string): { inner: string; slug: string } | null {
  const at = ref.lastIndexOf('@');
  if (at <= 0) return null;
  const slug = ref.slice(at + 1);
  return /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/.test(slug) ? { inner: ref.slice(0, at), slug } : null;
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('links_streams', {
    description: 'The other Alfreds this one is linked with (name, tag, online, version) and what is streamed each way: boards and cycles '
      + 'streamed TO this Alfred (refs `<id>@<tag>` you can pass to get_cycle, check_calls, board_get… - read live from their owner, '
      + 'masked there) and what this Alfred streams OUT. Also the requests waiting (asked of this Alfred, or asked by it). Offline is a '
      + 'state: say you cannot reach that Alfred and answer from what you can read.',
    inputSchema: {},
  }, () => run(async () => {
    const [links, streams, requests] = await Promise.all([
      client.get<LinkRow[]>('/links'),
      client.get<StreamRow[]>('/links/streams', { query: { ended: true } }),
      client.get<RequestRow[]>('/links/requests', { query: { limit: 50 } }),
    ]);
    const byId = new Map(links.map((l) => [l.id, l]));
    const ref = (s: StreamRow) => `${s.target}@${byId.get(s.linkId)?.slug ?? '?'}`;
    return ok({
      links: links.map((l) => `${l.name} @${l.slug} - ${l.online ? `online${l.rttMs != null ? ` ${l.rttMs} ms` : ''}` : `offline${l.lastError ? ` (${l.lastError})` : ''}`}`
        + ` · Alfred ${l.peerVersion ?? '?'}${l.skewed ? ' · its clock is off' : ''}`),
      streamedToHere: streams.filter((s) => !s.mine).map((s) => ({
        ref: ref(s), kind: s.kind, name: s.targetName ?? s.target, from: byId.get(s.linkId)?.name ?? '?', project: s.project,
        youMay: s.mode === 'COMMENT' ? 'read, and ask (links_request)' : 'read', ...(s.env ? { env: s.env } : {}),
        state: s.endedAt ? 'stream ended' : byId.get(s.linkId)?.online ? 'live' : 'offline',
      })),
      streamedFromHere: streams.filter((s) => s.mine && !s.endedAt).map((s) => ({
        kind: s.kind, id: s.target, name: s.targetName ?? s.target, to: byId.get(s.linkId)?.name ?? '?', mode: s.mode,
        autoAccept: s.autoAccept, ...(s.kind === 'CYCLE' ? { passOn: s.passOn ? s.passMode : 'no' } : {}), secrets: s.unmasked ? 'UNMASKED' : 'masked',
      })),
      requests: requests.filter((r) => r.state === 'WAITING').map((r) => ({
        id: r.id, direction: r.incoming ? `asked of this Alfred by ${byId.get(r.linkId)?.name ?? '?'}` : `asked of ${byId.get(r.linkId)?.name ?? '?'}`,
        kind: r.kind, about: r.targetLabel ?? r.target, text: r.text,
      })),
      note: 'Requests asked of this Alfred are the user\'s to accept or reject - never answer them yourself.',
    });
  }));

  server.registerTool('links_request', {
    description: 'Ask the owner of another Alfred\'s card, brief or call (a ref ending `@<tag>`): a comment or a question on a card, a '
      + 'comment on a board\'s brief, or a note on a call. It is a request - the owner (a person) accepts or rejects it; you never write '
      + 'there directly. Only on a stream that allows comments (links_streams says "you may: read, and ask"). Use it for what the owner '
      + 'must see on their side; this Alfred\'s own board (cards opened from their calls) is written as usual.',
    inputSchema: {
      ref: z.string().min(3).max(300).describe('The card id, board id (for the brief) or call id - with its @<tag>'),
      kind: z.enum(['CARD_COMMENT', 'CARD_QUESTION', 'BRIEF_COMMENT', 'CALL_NOTE']),
      text: z.string().min(1).max(20_000),
      label: z.string().max(200).optional().describe('What it is about, as the owner should read it: "#7 Refund total", "GET /refunds/7 → 500"'),
      quote: z.string().max(2000).optional().describe('BRIEF_COMMENT: the passage of the brief it is about'),
    },
  }, (input) => run(async () => {
    const split = splitRef(input.ref);
    if (!split) throw invalid('Not another Alfred\'s ref - it ends with @<tag> (links_streams lists them). On this Alfred\'s own things write as usual.');
    const [links, streams] = await Promise.all([
      client.get<LinkRow[]>('/links'),
      client.get<StreamRow[]>('/links/streams', { query: { mine: false } }),
    ]);
    const link = links.find((l) => l.slug === split.slug);
    if (!link) throw invalid(`No link tagged @${split.slug}.`);
    const active = streams.filter((s) => s.linkId === link.id && !s.endedAt);
    const stream = active.find((s) => s.target === split.inner) ?? active.find((s) => s.kind === 'BOARD') ?? active.find((s) => s.kind === 'CYCLE');
    if (!stream) throw invalid(`${link.name} streams nothing that carries that to this Alfred.`);
    if (stream.mode !== 'COMMENT') throw invalid(`${link.name} streams it view only - the user can ask them to allow comments.`);
    const out = await client.post<RequestRow>('/links/requests', { ...REMOTE, body: {
      via: split.slug, streamId: stream.id, kind: input.kind, target: split.inner, targetLabel: input.label, text: input.text,
      extra: input.kind === 'BRIEF_COMMENT' && input.quote ? JSON.stringify({ quote: input.quote }) : undefined, claude: true,
    } });
    return ok({ request: out.id, state: out.state, to: link.name, said: out.state === 'ACCEPTED' ? 'taken at once (their stream auto-accepts)'
      : `waiting for ${link.name} to accept or reject it` });
  }));

  // ------------------------------------------------------------------------------------------------ environments

  server.registerTool('env_boards', {
    description: 'Boards other Alfreds host for which THIS Alfred is an environment (e.g. STG): per board, what it asks every environment '
      + '(acceptance items, test steps, Fixed cards to re-test) and this Alfred\'s own column - its marks, ticks, re-tests, verdict and '
      + 'what is still missing. Only this Alfred writes its column (env_mark, env_step, env_retest, env_record); the host sees it live. '
      + 'Read the host\'s board itself with board_get / task_context on its ref `<board>@<tag>`.',
    inputSchema: {},
  }, () => run(async () => {
    const assigned = await client.get<Assigned[]>('/links/env/assignments');
    if (!assigned.length) return ok({ boards: [], note: 'No other Alfred has named this one an environment of its boards.' });
    const columns = await Promise.all(assigned.map((a) => client.get<Column>(`/links/env/${seg(a.hostSlug)}/${seg(a.boardId)}`, REMOTE)
      .then((c) => ({ a, c }), (e: unknown) => ({ a, c: null as Column | null, error: e instanceof Error ? e.message : String(e) }))));
    return ok({ boards: columns.map(({ a, c, ...rest }) => ({
      host: `${a.hostName} @${a.hostSlug}${a.hostOnline ? '' : ' (offline)'}`, boardId: a.boardId, boardRef: `${a.boardId}@${a.hostSlug}`,
      board: a.boardName ?? a.boardId, project: a.project, environment: a.env,
      ...(c ? {
        verdict: c.verdict, stillMissing: c.missing,
        items: c.asks.items.map((i) => {
          const m = c.marks.find((x) => x.fileName === i.fileName && x.itemKey === i.itemKey);
          return `${i.fileName}#${i.itemKey}: ${i.text ?? ''} → ${m ? `${m.mark}${m.evidence ? ` (${m.evidence})` : ''}` : 'not marked'}`;
        }),
        steps: c.asks.steps.map((st) => `${st} → ${c.steps.find((x) => x.stepKey === st)?.state ?? 'not ticked'}`),
        retests: c.asks.fixedCards.map((n) => {
          const r = c.retests.find((x) => x.cardNumber === n);
          return `#${n} → ${r ? `${r.verdict}${r.summary ? ` (${r.summary})` : ''}` : 'not re-tested here'}`;
        }),
        cycles: c.cycles.map((x) => `${x.cycleRef} ${x.name ?? ''}${x.retestFor.length ? ` (re-test ${x.retestFor.map((n) => '#' + n).join(' ')})` : ''}`),
      } : { error: (rest as { error?: string }).error }),
    })) });
  }));

  server.registerTool('env_mark', {
    description: 'Mark one acceptance item in this Alfred\'s environment column (env_boards lists them): PASS, FAIL or CANT_TELL, with the '
      + 'evidence from THIS Alfred\'s calls (the call, the status, the row) - the host sees it at once in this environment\'s column. '
      + 'clear: true takes the mark back. Never mark the host\'s own column; it is the host\'s.',
    inputSchema: {
      host: Slug, boardId: BoardId,
      fileName: z.string().min(1).max(200), itemKey: z.string().min(1).max(200),
      mark: z.enum(['PASS', 'FAIL', 'CANT_TELL']).optional(),
      evidence: z.string().max(20_000).optional().describe('Required for a mark: what in this Alfred\'s calls shows it'),
      clear: z.boolean().optional(),
    },
  }, (input) => run(async () => {
    const base = `/links/env/${seg(input.host)}/${seg(input.boardId)}/marks`;
    if (input.clear) {
      await client.del(base, { query: { fileName: input.fileName, itemKey: input.itemKey } });
      return ok({ cleared: `${input.fileName}#${input.itemKey}` });
    }
    if (!input.mark) throw invalid('Pass mark (PASS, FAIL, CANT_TELL) or clear: true.');
    if (!input.evidence?.trim()) throw invalid('Say the evidence - the call and what it shows - so the host can check it.');
    const m = await client.put<{ mark: string }>(base, { ...REMOTE, body: { fileName: input.fileName, itemKey: input.itemKey, mark: input.mark,
      evidence: input.evidence.trim(), claude: true } });
    return ok({ marked: `${input.fileName}#${input.itemKey}`, mark: m.mark });
  }));

  server.registerTool('env_step', {
    description: 'Tick one test step in this Alfred\'s environment column: SEEN (it happened in this Alfred\'s calls) or FAILED, with a note. '
      + 'clear: true takes it back.',
    inputSchema: {
      host: Slug, boardId: BoardId, stepKey: z.string().min(1).max(500),
      state: z.enum(['SEEN', 'FAILED']).optional(), note: z.string().max(5000).optional(), clear: z.boolean().optional(),
    },
  }, (input) => run(async () => {
    const base = `/links/env/${seg(input.host)}/${seg(input.boardId)}/steps`;
    if (input.clear) {
      await client.del(base, { query: { stepKey: input.stepKey } });
      return ok({ cleared: input.stepKey });
    }
    if (!input.state) throw invalid('Pass state (SEEN or FAILED) or clear: true.');
    await client.put(base, { ...REMOTE, body: { stepKey: input.stepKey, state: input.state, note: input.note ?? '', claude: true } });
    return ok({ ticked: input.stepKey, state: input.state });
  }));

  server.registerTool('env_record', {
    description: 'Start recording a test cycle on THIS Alfred for an environment of another Alfred\'s board: it is streamed to the host and '
      + 'put on its board as this environment\'s cycle. retestFor names the Fixed cards it re-tests (the cycle is named after them). Ask '
      + 'the user before starting a recording.',
    inputSchema: {
      host: Slug, boardId: BoardId, name: z.string().max(160).optional(),
      retestFor: z.array(z.number().int().positive()).max(50).optional(),
    },
  }, (input) => run(async () => {
    const c = await client.post<{ cycleRef: string; name: string | null; env: string }>(
      `/links/env/${seg(input.host)}/${seg(input.boardId)}/record`, { ...REMOTE, body: { name: input.name ?? null, retestFor: input.retestFor ?? [] } });
    return ok({ recording: c.cycleRef, name: c.name, environment: c.env, said: 'Recording here, streamed to the host and on its board.' });
  }));

  server.registerTool('env_retest', {
    description: 'Re-test Fixed cards of another Alfred\'s board on THIS environment: the host judges each card with its own re-test, on this '
      + 'Alfred\'s calls since the fix (or only in cycleId, one of this environment\'s cycles). The verdicts land in this environment\'s '
      + 'column. Something not captured is UNKNOWN, never a pass.',
    inputSchema: {
      host: Slug, boardId: BoardId, cards: z.array(z.number().int().positive()).min(1).max(50),
      cycleId: z.string().max(200).optional().describe('One of this environment\'s cycles (env_boards lists them); every one when absent'),
    },
  }, (input) => run(async () => {
    const out = await client.post<{ cardNumber: number; verdict: string; summary: string | null }[]>(
      `/links/env/${seg(input.host)}/${seg(input.boardId)}/retest`, { timeoutMs: 120_000, body: { cards: input.cards, cycleId: input.cycleId ?? null, claude: true } });
    return ok({ verdicts: out.map((r) => `#${r.cardNumber} ${r.verdict}${r.summary ? ` - ${r.summary}` : ''}`) });
  }));
}
