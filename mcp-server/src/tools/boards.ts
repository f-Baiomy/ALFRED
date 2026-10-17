import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient } from '../alfred-client.ts';
import { ok, run } from '../reply.ts';
import type { BoardRow } from '../board-scope.ts';
import { cardByNumber } from './board.ts';

/**
 * Boards as tasks (specs/027 contracts/mcp-and-export.md): list and open boards, relate cycles and boards, move a card's
 * home, record for a board, and where a listen's finding goes when its cycle is shared. Claude never opens a board on
 * its own: board_open needs `askedIn`, the user's chat message id or "terminal", and Alfred checks it.
 */
interface BoardSummaryRow {
  readonly board: BoardRow & { readonly migratedFrom: string | null };
  readonly cards: number;
  readonly cycleIds: readonly string[];
  readonly boardIds: readonly string[];
  readonly linkedItem: string | null;
}

interface HomeRow {
  readonly kind: 'EVIDENCE' | 'HOME' | 'ASK';
  readonly card: number | null;
  readonly boardId: string | null;
  readonly options: readonly BoardRow[];
  readonly reason: string;
}

interface CycleVerdictsRow {
  readonly cycleId: string;
  readonly boards: readonly { boardId: string; name: string }[];
  readonly calls: readonly {
    callId: string; method: string; endpoint: string; status: number | null;
    boards: readonly { boardId: string; name: string; items: readonly { fileName: string; key: string; result: string }[] }[];
    cards: readonly { project: string; number: number; home: string | null }[];
  }[];
}

const Project = z.string().min(1).max(200);
const BoardId = z.string().min(1).max(200).describe('A board id (board_boards); a project\'s default board is "default:<project>"');

export function boardLine(s: BoardSummaryRow): string {
  const b = s.board;
  return `${b.id} · "${b.name}" · ${b.project}${b.isDefault ? ' · default' : ''}${b.state === 'OPEN' ? '' : ' · ' + b.state.toLowerCase()}`
    + ` · ${s.cards} card(s) · cycles: ${s.cycleIds.length ? s.cycleIds.join(', ') : 'none'}`
    + (s.boardIds.length ? ` · related boards: ${s.boardIds.join(', ')}` : '') + (s.linkedItem ? ` · ◆ ${s.linkedItem}` : '');
}

export function verdictLines(v: CycleVerdictsRow): string[] {
  return v.calls.map((c) => {
    const per = c.boards.map((b) => `${b.name}: ${b.items.map((i) => `${i.key}=${i.result.toLowerCase()}`).join(', ')}`);
    const cards = c.cards.map((k) => `#${k.number}${k.home ? ` (home ${k.home})` : ''}`);
    return `${c.method} ${c.endpoint} ${c.status ?? '…'} [${c.callId}]${per.length ? ' · ' + per.join(' | ') : ''}${cards.length ? ' · cards ' + cards.join(' ') : ''}`;
  });
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('board_boards', {
    description: 'The boards (tasks): each project has a default board, and a task board per task. A board holds the brief, spec files, '
      + 'requirements, chat and cards; its session cycles are its recordings and re-tests (one cycle may be on several boards). '
      + 'Archived boards are left out unless state includes ARCHIVED.',
    inputSchema: {
      project: Project.optional(),
      state: z.array(z.enum(['OPEN', 'DONE', 'ARCHIVED'])).max(3).optional(),
      q: z.string().max(200).optional(),
    },
  }, (input) => run(async () => {
    const states = input.state?.length ? input.state : ['OPEN', 'DONE'];
    const rows = await client.get<BoardSummaryRow[]>('/board/boards', { query: { project: input.project, state: states.join(','), q: input.q } });
    return ok({ boards: rows.map(boardLine) });
  }));

  server.registerTool('board_open', {
    description: 'Open a new board (task) - ONLY when the user asked for it, in a board chat or in this terminal. askedIn is that chat '
      + 'message\'s id, or "terminal"; Alfred refuses without it and records where it was asked. relateTo relates it to the board it '
      + 'was asked from; startRecording makes its first recording (pausing another recording of the project).',
    inputSchema: {
      project: Project,
      name: z.string().min(1).max(120),
      askedIn: z.string().min(1).max(40),
      cycleIds: z.array(z.string().min(1).max(200)).max(100).optional(),
      relateTo: BoardId.optional(),
      startRecording: z.boolean().default(false),
    },
  }, (input) => run(async () => {
    const board = await client.post<BoardRow>('/board/boards', {
      body: { project: input.project, name: input.name, askedIn: input.askedIn, cycleIds: input.cycleIds ?? [], relateTo: input.relateTo,
        startRecording: input.startRecording },
    });
    return ok({ board: `${board.id} · "${board.name}" · ${board.project}`, next: 'Write its brief with board_set_brief (board: ' + board.id + ')' });
  }));

  server.registerTool('board_relate', {
    description: 'Relate (or with remove, unrelate) a session cycle or another board to a board. Unrelating keeps the cycle and its calls. '
      + 'The user can undo what you relate from the board\'s activity.',
    inputSchema: {
      board: BoardId,
      cycleId: z.string().min(1).max(200).optional(),
      otherBoard: BoardId.optional(),
      remove: z.boolean().default(false),
    },
  }, (input) => run(async () => {
    if (!input.cycleId === !input.otherBoard) throw new AlfredError('invalid', 'Pass exactly one of cycleId or otherBoard');
    const path = input.cycleId ? `/board/boards/${seg(input.board)}/cycles/${seg(input.cycleId)}`
      : `/board/boards/${seg(input.board)}/boards/${seg(input.otherBoard!)}`;
    if (input.remove) await client.del(path); else await client.put(path);
    const s = await client.get<BoardSummaryRow>(`/board/boards/${seg(input.board)}`);
    return ok({ board: boardLine(s) });
  }));

  server.registerTool('board_move_home', {
    description: 'Move a card to another board of its project (its home). Its number, status and history stay; both boards show the move. '
      + 'Use it when the evidence shows a finding belongs to another task.',
    inputSchema: { project: Project, number: z.number().int().positive(), board: BoardId },
  }, (input) => run(async () => {
    const card = await cardByNumber(client, input.project, input.number);
    await client.put(`/board/cards/${seg(card.id)}/home`, { body: { boardId: input.board } });
    return ok({ moved: `${input.project}#${input.number} → ${input.board}` });
  }));

  server.registerTool('board_record', {
    description: 'Start a recording for a board. One project records into one cycle at a time: when another cycle records the project, '
      + 'onRunning ASK (default) answers RUNNING with it - ask the user, then call again with JOIN (record into it for this board too) or '
      + 'NEW (pause it, start a new one).',
    inputSchema: {
      board: BoardId,
      kind: z.enum(['REC', 'RETEST']).default('REC'),
      onRunning: z.enum(['ASK', 'JOIN', 'NEW']).default('ASK'),
    },
  }, (input) => run(async () => {
    try {
      const r = await client.post<{ cycleId: string; message: string }>(`/board/boards/${seg(input.board)}/record`,
        { body: { kind: input.kind, onRunning: input.onRunning } });
      return ok({ recording: r.cycleId, note: r.message });
    } catch (e) {
      if (e instanceof AlfredError && e.code === 'RECORDING_CONFLICT') {
        return ok({ result: 'RUNNING', note: e.message.replace(/^Alfred rejected the request \(409\): /, ''),
          options: ['JOIN - record into the running cycle for this board too', 'NEW - pause it and start a new recording'] });
      }
      throw e;
    }
  }));

  server.registerTool('board_home', {
    description: 'Where a finding of a listen goes when its cycle is on several boards: EVIDENCE (the same finding is already that card - '
      + 'add evidence to it), HOME (board_add with that board), or ASK (several boards\' requirements name the endpoint: board_ask the user '
      + 'in the starting board\'s chat with one option per board). Pass the board the listen was started for, when there is one.',
    inputSchema: {
      cycleId: z.string().min(1).max(200),
      project: Project,
      endpoint: z.string().max(2000).optional().describe('"POST /api/refund"'),
      signature: z.string().max(2000).optional(),
      board: BoardId.optional(),
    },
  }, (input) => run(async () => {
    const h = await client.get<HomeRow>(`/board/cycles/${seg(input.cycleId)}/home`,
      { query: { project: input.project, endpoint: input.endpoint, signature: input.signature, board: input.board } });
    return ok({ kind: h.kind, ...(h.card ? { card: h.card } : {}), ...(h.boardId ? { board: h.boardId } : {}),
      ...(h.options.length ? { options: h.options.map((b) => `${b.id} ("${b.name}")`) } : {}), why: h.reason });
  }));

  server.registerTool('board_cycle_verdicts', {
    description: 'One cycle on several boards: for each of its calls, what every related board\'s requirements said, and the cards that '
      + 'mention it with their home. board narrows to the calls that board\'s items name or its cards mention.',
    inputSchema: { cycleId: z.string().min(1).max(200), board: BoardId.optional(), limit: z.number().int().min(1).max(2000).default(200) },
  }, (input) => run(async () => {
    const v = await client.get<CycleVerdictsRow>(`/board/cycles/${seg(input.cycleId)}/verdicts`, { query: { board: input.board, limit: input.limit } });
    return ok({ boards: v.boards.map((b) => `${b.boardId} ("${b.name}")`), calls: verdictLines(v) });
  }));
}
