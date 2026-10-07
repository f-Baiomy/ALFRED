import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { loadCapture } from '../db-capture.ts';
import {
  buildStoreItems, storeFindings, type CapturedStatement, type KeyHistoryRow, type KeyPatternRow, type StoreCommand, type StoreCommandSummary,
  type StoreCommandsPage,
} from '../frontend.ts';
import { maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { chunkText, fitItems, notFound, ok, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

/**
 * The Redis commands the application sent during a call (specs/011-redis-capture, contracts/export-and-mcp.md):
 * one call's commands with their decoded values (redis_commands), the call's Redis at a glance with the same findings as
 * the database window (redis_overview), and every recorded call that read or wrote one key (redis_key_history).
 * Values come decoded by Alfred (never by the application); a key masked in the project's settings stays masked, and
 * session masking hides secrets in the text the same way it does in bodies.
 */

const VALUE_LIMIT = 4000;
const PAGE = 500;

const WHY_OFF = 'Alfred has no Redis commands for this call: its project\'s ⬢ switch (Sources bar) was off when the call ran, the agent was not attached, '
  + 'or the application sent no Redis command during it.';

async function allCommands(client: AlfredClient, callId: string): Promise<StoreCommandsPage> {
  let page = await client.get<StoreCommandsPage>(`/db-capture/calls/${seg(callId)}/store-commands`, { query: { offset: 0, limit: PAGE } });
  const commands = [...page.commands];
  const cold = [...page.cold];
  while (page.commands.length === PAGE) {
    page = await client.get<StoreCommandsPage>(`/db-capture/calls/${seg(callId)}/store-commands`, { query: { offset: commands.length, limit: PAGE } });
    commands.push(...page.commands);
    cold.push(...page.cold);
  }
  return { ...page, commands, cold };
}

function masked(ctx: MaskContext, value: string | null | undefined): string | null {
  return value == null ? null : maskText(ctx, value);
}

function row(ctx: MaskContext, c: StoreCommandSummary, cold: ReadonlySet<number>) {
  return {
    id: c.id, seq: c.seq, command: c.command, keys: c.keys.map((k) => maskText(ctx, k)), ...(c.keysTotal > c.keys.length ? { keysTotal: c.keysTotal } : {}),
    rw: c.rw, outcome: c.outcome, ...(cold.has(c.seq) ? { cacheCold: true } : {}), ms: Math.round(c.micros / 100) / 10,
    reply: masked(ctx, c.outcome === 'FAILED' ? c.error : c.replyPreview), args: masked(ctx, c.argsText),
    bytes: c.bytes, replyBytes: c.replyBytes,
    ...(c.origin?.cache ? { springCache: `${c.origin.cache}${c.origin.operation ? ` (${c.origin.operation})` : ''}` } : {}),
    ...(c.group ? { group: `${c.group.kind} ${c.group.id} ${c.group.index + 1}/${c.group.size}` } : {}),
    ...(c.poolWaitMicros != null ? { poolWaitMs: Math.round(c.poolWaitMicros / 100) / 10 } : {}),
    code: c.code ?? null, client: c.client ?? null, connection: c.connection ?? null,
  };
}

const FILTERS: Record<string, (c: StoreCommandSummary, cold: ReadonlySet<number>) => boolean> = {
  all: () => true,
  reads: (c) => c.rw === 'r',
  writes: (c) => c.rw === 'w',
  misses: (c) => c.outcome === 'MISS',
  failed: (c) => c.outcome === 'FAILED',
  cold: (c, cold) => cold.has(c.seq),
};

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('redis_commands', {
    description: 'The Redis commands one inbound call sent, in the call\'s order (seq shared with its database statements and supplier calls): command, '
      + 'keys, read/write, outcome (OK/HIT/MISS/FAILED), time, reply, Spring Cache origin, MULTI/pipeline group and the code line. With `commandId`, one '
      + 'command in full: every argument, the reply and the value decoded by Alfred (JSON, Java serialization, Kryo, gzip, Snappy - format named), the value '
      + 'before a write when captured, and which recorded call last wrote the key. Requires ⬢ Redis capture on for the project.',
    inputSchema: {
      callId: z.string().min(1),
      filter: z.enum(['all', 'reads', 'writes', 'misses', 'failed', 'cold']).default('all'),
      key: z.string().optional().describe('Only commands whose key contains this text'),
      commandId: z.number().int().min(1).optional().describe('One command in full (its id from a previous answer)'),
      valueOffset: z.number().int().min(0).default(0).describe('With commandId: where to continue a long value'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    if (input.commandId !== undefined) {
      const c = await client.get<StoreCommand>(`/db-capture/store-commands/${seg(input.commandId)}`, { notFound: `Redis command ${input.commandId} not found.` });
      const value = (v: StoreCommand['value']) => {
        if (!v) return null;
        if (v.masked) return { masked: true, bytes: v.bytes };
        const text = maskText(ctx, v.text ?? '');
        const chunk = chunkText(text, input.valueOffset, VALUE_LIMIT);
        return { format: v.format ?? null, className: v.className ?? null, bytes: v.bytes, ...(v.partial ? { partial: true } : {}),
          text: chunk.nextOffset === null && chunk.offset === 0 ? text : chunk };
      };
      return ok({
        ...row(ctx, c.row, new Set()), callId: input.callId, args: c.args.map((a) => maskText(ctx, a)), server: c.server ?? null, db: c.db ?? null,
        thread: c.thread ?? null, callers: c.callers ?? null, fingerprint: c.fingerprint ?? null, resp: c.resp,
        reply: value(c.reply), value: value(c.value), before: value(c.before), ...(c.row.beforeNote ? { beforeNote: c.row.beforeNote } : {}),
        writtenBy: c.writtenBy ?? null, ...maskMeta(ctx),
      });
    }
    const page = await allCommands(client, input.callId);
    if (!page.commands.length && !page.summary) throw notFound(WHY_OFF);
    const cold = new Set(page.cold);
    const keyText = input.key?.toLowerCase();
    const matching = [...page.commands].sort((a, b) => a.seq - b.seq)
      .filter((c) => FILTERS[input.filter](c, cold))
      .filter((c) => !keyText || c.keys.some((k) => k.toLowerCase().includes(keyText)));
    const rows = matching.slice(input.offset, input.offset + input.limit).map((c) => row(ctx, c, cold));
    const fitted = fitItems(rows, 400);
    const end = input.offset + fitted.items.length;
    return ok({
      callId: input.callId, total: matching.length, offset: input.offset, nextOffset: end < matching.length ? end : null,
      ...(page.dropped ? { notKept: page.dropped, notKeptWhy: 'the agent\'s queue was full - these commands were counted, not kept' } : {}),
      commands: fitted.items, ...maskMeta(ctx),
    });
  }));

  server.registerTool('redis_overview', {
    description: 'One inbound call\'s Redis at a glance - what Alfred\'s database window shows on its Redis view: counts (reads, writes, hits, misses, failed), '
      + 'hit rate, time, the key patterns (slowest first, last writer) and the findings with the command numbers (#seq): failed commands, single reads one by '
      + 'one (one MGET would do), a miss filled from the database, big values, cold cache (TTL ran out), KEYS/FLUSH in the request path, slow commands.',
    inputSchema: {
      callId: z.string().min(1),
      slowMillis: z.number().min(0).default(10).describe('A command slower than this counts as slow'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const page = await allCommands(client, input.callId);
    if (!page.commands.length && !page.summary) throw notFound(WHY_OFF);
    const statements: readonly CapturedStatement[] = await loadCapture(client, input.callId).then((c) => c.statements).catch(() => []);
    const keys = await client.get<KeyPatternRow[]>(`/db-capture/calls/${seg(input.callId)}/store-keys`).catch(() => []);
    const findings = storeFindings(page.commands, page.cold, statements, [], input.slowMillis)
      .map((f) => ({ severity: f.severity, title: f.title, short: maskText(ctx, f.short), why: f.why, fix: f.fix ?? null, impactMs: f.impactMs, seqs: f.seqs.slice(0, 30) }));
    const c = page.commands;
    const hits = c.filter((x) => x.outcome === 'HIT').length;
    const misses = c.filter((x) => x.outcome === 'MISS').length;
    const groups = buildStoreItems(c).filter((i) => i.kind === 'group').map((g) => g.kind === 'group' ? `#${g.seq} ${g.verb} ${maskText(ctx, g.pattern)} ${g.meta}`.trim() : '');
    return ok({
      callId: input.callId, commands: c.length, reads: c.filter((x) => x.rw === 'r').length, writes: c.filter((x) => x.rw === 'w').length,
      hits, misses, failed: c.filter((x) => x.outcome === 'FAILED').length, hitRatePercent: hits + misses ? Math.round((100 * hits) / (hits + misses)) : null,
      ms: Math.round(c.reduce((n, x) => n + x.micros, 0) / 100) / 10, cacheCold: page.cold.length,
      ...(page.dropped ? { notKept: page.dropped } : {}),
      clients: [...new Set(c.map((x) => x.client).filter((x): x is string => !!x))],
      keyPatterns: keys.slice(0, 30).map((k) => ({ ...k, pattern: maskText(ctx, k.pattern), ms: Math.round(k.micros / 100) / 10 })),
      groups, findings: findings.filter((f) => f.severity !== 'note'), ...maskMeta(ctx),
    });
  }));

  server.registerTool('redis_key_history', {
    description: 'Every recorded call that read or wrote one Redis key, newest first: the call (method, path, status), the command, read/write, the outcome, '
      + 'and whether a write stored the same value as the one before it. Answers "who changed this key" and "why was it missing".',
    inputSchema: {
      key: z.string().min(1),
      project: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const rows = await client.get<KeyHistoryRow[]>('/db-capture/store-keys/history', { query: { key: input.key, project: input.project, limit: input.limit } });
    const fitted = fitItems(rows.map((r) => ({ ...r, path: masked(ctx, r.path) })), 300);
    return ok({ key: maskText(ctx, input.key), project: input.project ?? null, total: rows.length, history: fitted.items, ...maskMeta(ctx) });
  }));
}
