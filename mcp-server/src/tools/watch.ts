import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { toRow } from '../calls.ts';
import { listCycleCalls, requireCycle, type CycleEntry } from '../cycle-calls.ts';
import { maskCalls, maskContext, maskMeta } from '../masking.ts';
import { ok, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

/** Alfred's own "something changed" sockets: a captured call arrives on the calls sockets, cycle edits on session-cycles. */
const SOCKETS = ['/ws/calls', '/ws/internal-calls', '/ws/session-cycles'];
const SETTLE_MS = 400;
const MAX_WAIT_S = 60;

/**
 * Waits until a cycle holds calls it did not hold before - so an agent can add spacers while the
 * user is still clicking, not only after "stop". Not a poll: it listens on the same WebSocket
 * signals the UI reloads on, re-reads the cycle only when one fires, and gives up after a bounded
 * wait (60 s at most), so a tool call can never hang.
 */
export async function waitForCalls(client: AlfredClient, cycleId: string, sinceCallId: string | undefined, timeoutMs: number): Promise<{ newEntries: CycleEntry[]; total: number; timedOut: boolean; recording: boolean }> {
  const cycle = await requireCycle(client, cycleId);
  const first = await listCycleCalls(client, cycle.id);
  const known = new Set(first.entries.map((e) => e.call.id));
  const after = (entries: CycleEntry[]) => {
    if (sinceCallId) {
      const at = entries.findIndex((e) => e.call.id === sinceCallId);
      return at >= 0 ? entries.slice(at + 1) : entries.filter((e) => !known.has(e.call.id));
    }
    return entries.filter((e) => !known.has(e.call.id));
  };
  const ready = sinceCallId ? after(first.entries) : [];
  if (ready.length) return { newEntries: ready, total: first.entries.length, timedOut: false, recording: cycle.status === 'RECORDING' };

  return new Promise((resolve, reject) => {
    const sockets: WebSocket[] = [];
    let settle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (value: { newEntries: CycleEntry[]; total: number; timedOut: boolean } | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settle);
      for (const s of sockets) s.close();
      if (value instanceof Error) reject(value);
      else resolve({ ...value, recording: cycle.status === 'RECORDING' });
    };
    const check = () => {
      listCycleCalls(client, cycle.id).then((now) => {
        const fresh = after(now.entries);
        if (fresh.length) finish({ newEntries: fresh, total: now.entries.length, timedOut: false });
      }).catch(finish);
    };
    const timer = setTimeout(() => finish({ newEntries: [], total: first.entries.length, timedOut: true }), timeoutMs);
    const wsBase = client.baseUrl.replace(/^http/, 'ws');
    for (const path of SOCKETS) {
      const socket = new WebSocket(wsBase + path);
      // A burst of calls arrives as a burst of messages: read the cycle once it settles, not per message.
      socket.addEventListener('message', () => {
        clearTimeout(settle);
        settle = setTimeout(check, SETTLE_MS);
      });
      sockets.push(socket);
    }
  });
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('wait_for_calls', {
    description: 'Wait (up to timeoutSec, at most 60) until a session cycle captures new calls - e.g. while the user reproduces something with '
      + 'recording on - and return them with their numbers. Pass sinceCallId (the lastCallId of the previous reply) to continue where you left off. '
      + 'Event-driven (Alfred\'s WebSocket signals), not polling; returns timedOut: true when nothing arrived.',
    inputSchema: {
      cycleId: z.string().min(1),
      sinceCallId: z.string().optional(),
      timeoutSec: z.number().int().min(1).max(MAX_WAIT_S).default(30),
      includeOptions: z.boolean().default(false),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const result = await waitForCalls(client, input.cycleId, input.sinceCallId, input.timeoutSec * 1000);
    const shown = result.newEntries.filter((e) => input.includeOptions || e.call.method !== 'OPTIONS');
    const rows = maskCalls(ctx, shown.map((e) => e.call)).map(toRow);
    return ok({
      newCalls: rows, newCount: result.newEntries.length, hiddenOptions: result.newEntries.length - shown.length,
      totalCalls: result.total, timedOut: result.timedOut, recording: result.recording,
      lastCallId: result.newEntries.at(-1)?.call.id ?? input.sinceCallId ?? null,
      ...(result.recording ? {} : { note: 'The cycle is not recording - start_recording to capture new calls.' }),
      ...maskMeta(ctx),
    });
  }));
}
