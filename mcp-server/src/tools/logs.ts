import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import type { CallLogsPage, CallRecord, LinkedLogLine } from '../frontend.ts';
import { maskCall, maskContext, maskMeta } from '../masking.ts';
import { fitItems, ok, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

/** A call's lines are read whole (the backend's per-call seatbelt), then filtered and paged here. */
const MAX_LINES = 5000;
const RAW_LIMIT = 4000;

const WHY: Record<string, string> = {
  LINKING_OFF: "Alfred is not catching this project's log lines: its ▤ switch (Sources bar) or its inbound logging is off.",
  NO_AGENT: 'The agent caught no log lines for this call: ▤ is on, but the database agent was not attached (or was an older version) when the call ran.',
};

async function allLines(client: AlfredClient, callId: string, cycleId: string | undefined): Promise<{ first: CallLogsPage; lines: LinkedLogLine[] }> {
  const lines: LinkedLogLine[] = [];
  let first: CallLogsPage | null = null;
  let after: string | null = null;
  do {
    const page: CallLogsPage = await client.get<CallLogsPage>(`/call-logs/${seg(callId)}`, {
      query: { cycleId, after: after ?? undefined, limit: 500 }, notFound: `Call ${callId} not found (an inbound call id; pass cycleId for a call only a session cycle still holds).`,
    });
    first ??= page;
    lines.push(...page.lines);
    after = page.lines.length ? page.next : null;
  } while (after && lines.length < MAX_LINES);
  return { first: first!, lines };
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('call_logs', {
    description: 'The application log lines written while one inbound call ran (the Logs view of Alfred\'s database window): offset from the call\'s start, '
      + 'level, thread, logger, message, exception and how each line was linked - CAUGHT (caught by the agent inside the application, in the call\'s own order), '
      + 'EXACT (it carries the call id) or THREAD_TIME (same request thread, inside the call\'s time). '
      + 'Masked like bodies. Filter by level or text; raw: true adds each whole original line. capturedLevel is the project Log level '
      + '(Settings → Database capture; ERROR by default): lines below it were never caught, so their absence proves nothing.',
    inputSchema: {
      callId: z.string().min(1),
      cycleId: z.string().optional().describe('The session cycle holding the call, for a call the live list no longer has'),
      level: z.string().optional().describe('Only this level or worse: ERROR, WARN, INFO, DEBUG'),
      text: z.string().optional().describe('Text in the message'),
      raw: z.boolean().default(false).describe('Include each whole original line (cut at 4,000 characters)'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const { first, lines } = await allLines(client, input.callId, input.cycleId);
    // Masked as part of the call, so call-scoped rules apply - the same redact.ts the exports use.
    const stub: CallRecord = { id: input.callId, original_url: '', url: '', method: '', timestamp: '', duration_ms: 0, source: 'internal', logLines: lines };
    const masked = maskCall(ctx, stub).logLines ?? [];
    const rank = (l: string | null) => {
      const v = (l ?? '').toUpperCase();
      return v === 'ERROR' || v === 'FATAL' || v === 'SEVERE' ? 4 : v === 'WARN' || v === 'WARNING' ? 3 : v === 'INFO' ? 2 : 1;
    };
    const min = input.level ? rank(input.level) : 0;
    const needle = input.text?.toLowerCase();
    const matching = masked.filter((l) => rank(l.level) >= min).filter((l) => !needle || l.message.toLowerCase().includes(needle));
    const rows = matching.slice(input.offset, input.offset + input.limit).map((l) => ({
      offsetMs: l.offsetMs, at: l.at, level: l.level, thread: l.thread, logger: l.logger, message: l.message, matchedBy: l.matchedBy,
      source: l.sourceName, lineId: l.lineId, ...(l.kept ? { kept: true } : {}),
      ...(l.exception ? { exception: { type: l.exception.type, message: l.exception.message,
        stack: l.exception.stack && l.exception.stack.length > RAW_LIMIT ? `${l.exception.stack.slice(0, RAW_LIMIT)}… (${l.exception.stack.length} chars)` : l.exception.stack } } : {}),
      ...(input.raw ? { raw: l.raw.length > RAW_LIMIT ? `${l.raw.slice(0, RAW_LIMIT)}… (${l.raw.length} chars)` : l.raw } : {}),
    }));
    const fitted = fitItems(rows, 600);
    const end = input.offset + fitted.items.length;
    return ok({
      callId: input.callId, setup: first.setup, ...(WHY[first.setup] && !lines.length ? { why: WHY[first.setup] } : {}),
      matchedBy: first.matchedBy, thread: first.thread, clockSkewMs: first.clockSkewMs,
      ...(first.logLevel ? { capturedLevel: first.logLevel === 'APP' ? "APP (the application's own level)" : `${first.logLevel} and above` } : {}),
      total: matching.length, ...(matching.length !== lines.length ? { allLines: lines.length } : {}),
      offset: input.offset, nextOffset: end < matching.length ? end : null, lines: fitted.items, ...maskMeta(ctx),
    });
  }));
}
