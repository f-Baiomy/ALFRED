import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { withParts } from '../calls.ts';
import { detectAndFormatBody, type CallRecord, type Comment, type CommentBlock } from '../frontend.ts';
import { maskContext, maskMeta, maskText } from '../masking.ts';
import { chunkText, fitItems, invalid, notFound, ok, preview, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';
import { resolveCall } from './calls.ts';

/** Every comment this server writes starts with this, so the UI and list_comments can tell Claude's from a person's. */
export const CLAUDE_PREFIX = '🤖 Claude: ';

const Block = z.enum(['call', 'request-headers', 'request-body', 'response-headers', 'response-body']);

/**
 * The lines of a block exactly as the call card numbers them for comments (json-panel's baseText):
 * headers as pretty JSON of the header object, a body pretty-printed when it is JSON or XML and as
 * sent otherwise. The exports read a comment back with the same detectAndFormatBody split, so a
 * line number here is the line the UI and the files show.
 */
export function blockLines(call: CallRecord, block: CommentBlock): string[] {
  switch (block) {
    case 'call': return [];
    case 'request-headers': return JSON.stringify(call.request?.headers ?? {}, null, 2).split('\n');
    case 'response-headers': return JSON.stringify(call.response?.headers ?? {}, null, 2).split('\n');
    case 'request-body': return detectAndFormatBody(call.request?.body ?? '').body.split('\n');
    case 'response-body': return detectAndFormatBody(call.response?.body ?? '').body.split('\n');
  }
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('list_comments', {
    description: 'Comments on a call, each with the part (request/response headers/body) and line it is attached to; byClaude marks ones Claude wrote.',
    inputSchema: {
      callId: z.string().min(1),
      commentId: z.string().optional().describe('Read this one comment in full, paged by offset'),
      offset: z.number().int().min(0).default(0),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const comments = await client.get<Comment[]>('/comments', { query: { callId: input.callId } });
    if (input.commentId) {
      const one = comments.find((c) => c.id === input.commentId);
      if (!one) throw notFound(`Comment ${input.commentId} not found on call ${input.callId}.`);
      return ok({ id: one.id, block: one.block, line: one.lineIndex + 1, comment: chunkText(maskText(ctx, one.comment), input.offset, 12_000), ...maskMeta(ctx) });
    }
    const rows = comments.map((c) => ({
      id: c.id, block: c.block, line: c.lineIndex + 1, lineText: preview(maskText(ctx, c.lineText), 300, 'get_call_body'),
      comment: preview(maskText(ctx, c.comment), 1000, `list_comments commentId ${c.id}`),
      createdAt: c.createdAt, byClaude: c.comment.startsWith(CLAUDE_PREFIX),
    }));
    const fitted = fitItems(rows, 300);
    return ok({ comments: fitted.items, total: rows.length, ...(fitted.cut ? { more: 'Too many to show at once - read the rest one by one with commentId.' } : {}), ...maskMeta(ctx) });
  }));

  const CommentSchema = {
    callId: z.string().min(1),
    direction: z.enum(['inbound', 'outbound']).optional(),
    block: Block.default('call').describe('"call" = a note on the whole call (no line); else the part a line belongs to'),
    line: z.number().int().min(1).optional(),
    lineMatch: z.string().min(1).optional().describe('Text the line contains - the first such line is used'),
    comment: z.string().min(1).max(4000),
  };

  server.registerTool('add_comment', {
    description: 'Record a finding as a comment on a call in Alfred (shown live in the UI and in exports, prefixed "' + CLAUDE_PREFIX.trim() + '"). '
      + 'block "call" (default) notes the whole call; a header/body block anchors it to a line - by number (1-based, as get_call_body '
      + 'shows the pretty-printed text) or by text it contains.',
    inputSchema: CommentSchema,
  }, (input) => run(async () => ok(await addComment(client, input))));

  server.registerTool('add_comments', {
    description: 'Add many comments in one call (e.g. one note per call across a cycle) - each as add_comment. Reports each result; one bad item does not stop the rest.',
    inputSchema: { comments: z.array(z.object(CommentSchema)).min(1).max(200) },
  }, (input) => run(async () => {
    const results = await Promise.all(input.comments.map((c) => addComment(client, { ...c, block: c.block ?? 'call' })
      .then((created) => ({ ok: true as const, ...created }))
      .catch((error: Error) => ({ ok: false as const, callId: c.callId, error: error.message }))));
    return ok({ added: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
  }));

  server.registerTool('delete_comment', {
    description: 'Delete one comment by id (from list_comments or add_comment).',
    inputSchema: { commentId: z.string().min(1) },
  }, (input) => run(async () => {
    await client.del(`/comments/${seg(input.commentId)}`, { notFound: `Comment ${input.commentId} not found.` });
    return ok({ deleted: true, commentId: input.commentId });
  }));
}

interface CommentInput {
  callId: string;
  direction?: 'inbound' | 'outbound';
  block: CommentBlock;
  line?: number;
  lineMatch?: string;
  comment: string;
}

async function addComment(client: AlfredClient, input: CommentInput) {
  if (input.line !== undefined && input.lineMatch !== undefined) throw invalid('Give line or lineMatch, not both.');
  const { ref, call: summary } = await resolveCall(client, input.callId, input.direction);
  let index = 0;
  let lineText = '';
  if (input.block !== 'call') {
    const call = await withParts(client, ref, summary, [input.block]);
    const lines = blockLines(call, input.block);
    if (input.line !== undefined) {
      if (input.line > lines.length) throw invalid(`${input.block} has ${lines.length} lines; line ${input.line} does not exist.`);
      index = input.line - 1;
    } else if (input.lineMatch !== undefined) {
      const needle = input.lineMatch.toLowerCase();
      index = lines.findIndex((l) => l.toLowerCase().includes(needle));
      if (index < 0) throw invalid(`No line of ${input.block} contains "${input.lineMatch}".`);
    }
    lineText = lines[index] ?? '';
  }
  const created = await client.post<Comment>('/comments', {
    body: { callId: summary.id, block: input.block, lineIndex: index, lineText, comment: CLAUDE_PREFIX + input.comment },
  });
  return { id: created.id, callId: created.callId, block: created.block, ...(created.block === 'call' ? {} : { line: created.lineIndex + 1, lineText: created.lineText }), comment: created.comment };
}
