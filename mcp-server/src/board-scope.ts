import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, seg, type AlfredClient } from './alfred-client.ts';
import { fail, invalid } from './reply.ts';
import { candidatesText, resolveBoard } from './board-ref.ts';

/**
 * Boards (specs/027 contracts/mcp-and-export.md): a board is a task, and the task routes take its id where they took a
 * cycle id. Every tool registered through {@link withBoardParam} that has a `cycleId` input also takes `board`:
 *
 * - `board` given: it is the task (`cycleId` becomes the board id).
 * - only `cycleId`, on a tool that names a TASK (TASK_TOOLS): the board with that id; else the one board related to that
 *   cycle; several -> an error naming them; none -> the id as given (a cycle on no board keeps working as before).
 * - Tools whose `cycleId` is a recording (a re-test cycle, a session log) keep it as given.
 */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  'board_add', 'board_add_many', 'task_context', 'get_brief', 'board_set_brief', 'read_spec', 'board_put_spec', 'board_edit_spec',
  'board_requirements', 'board_evidence_put', 'board_brief_comment', 'board_next_steps', 'board_steps', 'board_mark_step',
  'board_link_spec', 'board_suggest_mark', 'board_list', 'board_search', 'board_short_name',
]);

export interface BoardRow {
  readonly id: string;
  readonly project: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly state: 'OPEN' | 'DONE' | 'ARCHIVED';
}

/** The task a cycle id stands for (see above). */
export async function taskOf(client: AlfredClient, cycleId: string): Promise<string> {
  try {
    await client.get(`/board/boards/${seg(cycleId)}`);
    return cycleId;
  } catch (e) {
    if (!(e instanceof AlfredError) || e.kind !== 'not_found') throw e;
  }
  const boards = await client.get<BoardRow[]>(`/board/cycles/${seg(cycleId)}/boards`).catch(() => [] as BoardRow[]);
  const open = boards.filter((b) => b.state === 'OPEN');
  const pick = open.length === 1 ? open : boards.length === 1 ? boards : [];
  if (pick.length === 1) return pick[0].id;
  if (boards.length > 1) {
    throw new AlfredError('invalid', `Cycle ${cycleId} is on ${boards.length} boards - pass board: one of `
      + boards.map((b) => `${b.id} ("${b.name}", ${b.project}${b.state === 'OPEN' ? '' : ', ' + b.state.toLowerCase()})`).join('; '));
  }
  if (boards.length === 0 && !/^[0-9a-f-]{8,}$/i.test(cycleId)) {
    // not an id: AB#1234 or a board's name (specs/030)
    const found = await resolveBoard(client, cycleId);
    if (found && 'candidates' in found) throw new AlfredError('invalid', candidatesText(cycleId, found.candidates));
    if (found) return found.board.board.id;
  }
  return cycleId;
}

type Handler = (input: Record<string, unknown>, extra: unknown) => unknown;

/** A view of {@code server} whose board tools also take `board` (see the file comment). */
export function withBoardParam(server: McpServer, client: AlfredClient): McpServer {
  const register = server.registerTool.bind(server) as unknown as (name: string, config: Record<string, unknown>, handler: Handler) => unknown;
  const wrapped = (name: string, config: Record<string, unknown>, handler: Handler): unknown => {
    const schema = config['inputSchema'] as Record<string, unknown> | undefined;
    // only the tools whose cycleId names a task: on the others it is a recording (a re-test cycle, a session log)
    if (!TASK_TOOLS.has(name) || !schema || !('cycleId' in schema) || 'board' in schema) return register(name, config, handler);
    const cycleId = schema['cycleId'] as z.ZodTypeAny;
    const withBoard = {
      ...config,
      inputSchema: {
        ...schema,
        cycleId: cycleId.isOptional() ? cycleId : cycleId.optional(),
        board: z.string().min(1).max(200).optional().describe('The board (task) this is about: AB#<item id> (the board whose main item it is), its name or its id'),
      },
    };
    const required = !cycleId.isOptional();
    return register(name, withBoard, async (input, extra) => {
      const { board, ...rest } = input as { board?: string; cycleId?: string };
      let task = board ?? rest.cycleId;
      if (!task && required) return fail(invalid('Pass board (a board id from board_boards) or cycleId'));
      try {
        if (board) {
          // AB#1234, the board's name or its id (specs/030)
          const found = await resolveBoard(client, board);
          if (found && 'candidates' in found) return fail(invalid(candidatesText(board, found.candidates)));
          if (found) task = found.board.board.id;
        } else if (task) {
          task = await taskOf(client, task);
        }
      } catch (e) {
        return fail(e);
      }
      return handler(task === undefined ? rest : { ...rest, cycleId: task }, extra);
    });
  };
  return new Proxy(server, {
    get(target, prop, receiver) {
      return prop === 'registerTool' ? wrapped : Reflect.get(target, prop, receiver);
    },
  });
}
