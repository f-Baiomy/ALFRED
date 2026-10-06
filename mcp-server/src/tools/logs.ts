import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { callLines, callStory, type StoryItem } from '../call-story.ts';
import type { CallRecord, LinkedLogLine } from '../frontend.ts';
import { maskCall, maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { fitItems, invalid, notFound, ok, run } from '../reply.ts';
import { heldInText, scopeBody, ScopeSchema } from '../scope.ts';
import { shortMessage, WHY } from '../signals.ts';
import { framesOfStack, resolveFrames } from '../source.ts';
import { MaskSchema } from './cycles.ts';

/**
 * The application's log lines, as the db-agent caught them inside the JVM (specs/009, specs/010): one call's lines
 * (call_logs), its whole story in order (call_story) and the items around a line (log_context), where a logged
 * exception comes from in the project (exception_source), and - across calls - a search (search_logs), the repeated
 * errors grouped into log problems (log_problems) and the lines no call wrote (outside_logs). Masked like bodies.
 */

const RAW_LIMIT = 4000;
const STACK_LIMIT = 4000;

const WHY_SETUP: Record<string, string> = {
  LINKING_OFF: "Alfred is not catching this project's log lines: its ▤ switch (Sources bar) or its inbound logging is off.",
  NO_AGENT: 'The agent caught no log lines for this call: ▤ is on, but the database agent was not attached (or was an older version) when the call ran.',
};

export function maskLines(ctx: MaskContext, callId: string, lines: readonly LinkedLogLine[]): LinkedLogLine[] {
  // Masked as part of the call, so call-scoped rules apply - the same redact.ts the exports use.
  const stub: CallRecord = { id: callId, original_url: '', url: '', method: '', timestamp: '', duration_ms: 0, source: 'internal', logLines: [...lines] };
  return [...(maskCall(ctx, stub).logLines ?? [])];
}

function cutStack(stack: string | null | undefined): string | null | undefined {
  return stack && stack.length > STACK_LIMIT ? `${stack.slice(0, STACK_LIMIT)}… (${stack.length} chars)` : stack;
}

const rank = (l: string | null | undefined) => {
  const v = (l ?? '').toUpperCase();
  return v === 'ERROR' || v === 'FATAL' || v === 'SEVERE' ? 4 : v === 'WARN' || v === 'WARNING' ? 3 : v === 'INFO' ? 2 : 1;
};

/** A line found across calls, as the backend answers it. */
interface SearchHit {
  readonly callId: string | null;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number | null;
  readonly callAt?: string;
  readonly heldIn?: string[];
  readonly line: LinkedLogLine & { readonly project?: string };
}

export interface ScopeAnswer {
  readonly scope: { kind: string; cycles: { id: string; name: string }[]; includeLive: boolean; calls: number; from?: string; to?: string };
  readonly unavailable: { project: string; why: string }[];
}

/** The scope and the projects whose lines may be missing, as every cross-call answer opens with. */
export function scopeMeta(answer: ScopeAnswer): Record<string, unknown> {
  return {
    scope: answer.scope,
    ...(answer.unavailable?.length ? { unavailable: answer.unavailable.map((u) => ({ project: u.project, why: u.why, meaning: WHY[u.why] ?? u.why })) } : {}),
  };
}

function storyLine(item: StoryItem): Record<string, unknown> {
  return {
    seq: item.seq, ...(item.offsetMs != null ? { offsetMs: item.offsetMs } : {}), kind: item.kind, text: item.text,
    ...(item.error ? { error: true } : {}), ...(item.ref != null ? { ref: item.ref } : {}),
    ...(item.exception ? { exception: item.exception } : {}),
  };
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('call_logs', {
    description: 'The application log lines written while one inbound call ran (the Logs view of Alfred\'s database window): offset from the call\'s start, '
      + 'level, thread, logger, message, exception and how each line was linked - CAUGHT (caught by the agent inside the application, in the call\'s own order), '
      + 'EXACT (it carries the call id) or THREAD_TIME (same request thread, inside the call\'s time). '
      + 'Masked like bodies. Filter by level or text; raw: true adds each whole original line. capturedLevel is the Log level that applied '
      + 'to this call (ERROR by default): lines below it were never caught, so their absence proves nothing.',
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
    const { first, lines } = await callLines(client, input.callId, input.cycleId);
    const masked = maskLines(ctx, input.callId, lines);
    const min = input.level ? rank(input.level) : 0;
    const needle = input.text?.toLowerCase();
    const matching = masked.filter((l) => rank(l.level) >= min).filter((l) => !needle || l.message.toLowerCase().includes(needle));
    const rows = matching.slice(input.offset, input.offset + input.limit).map((l) => ({
      offsetMs: l.offsetMs, at: l.at, level: l.level, thread: l.thread, logger: l.logger, message: l.message, matchedBy: l.matchedBy,
      source: l.sourceName, lineId: l.lineId, ...(l.kept ? { kept: true } : {}),
      ...(l.exception ? { exception: { type: l.exception.type, message: l.exception.message, stack: cutStack(l.exception.stack) } } : {}),
      ...(input.raw ? { raw: l.raw.length > RAW_LIMIT ? `${l.raw.slice(0, RAW_LIMIT)}… (${l.raw.length} chars)` : l.raw } : {}),
    }));
    const fitted = fitItems(rows, 600);
    const end = input.offset + fitted.items.length;
    const setup = first?.setup ?? 'LINKING_OFF';
    return ok({
      callId: input.callId, setup, ...(WHY_SETUP[setup] && !lines.length ? { why: WHY_SETUP[setup] } : {}),
      matchedBy: first?.matchedBy, thread: first?.thread, clockSkewMs: first?.clockSkewMs,
      ...(first?.logLevel ? {
        capturedLevel: first.logLevel === 'APP' ? "APP (the application's own level)" : `${first.logLevel} and above`,
        ...(first.levelAssumed ? { levelAssumed: true } : {}),
      } : {}),
      total: matching.length, ...(matching.length !== lines.length ? { allLines: lines.length } : {}),
      offset: input.offset, nextOffset: end < matching.length ? end : null, lines: fitted.items, ...maskMeta(ctx),
    });
  }));

  server.registerTool('search_logs', {
    description: 'Search the caught log lines of many calls at once - the live calls, a cycle, several cycles or everything (scope) - by text '
      + '(message, logger, thread or exception, case-insensitive), a regex pattern, level (this or worse), logger, exception type and time. '
      + 'Each hit names its call (method, path, status, where it is held) and the line\'s offset in it; total is exact. Use it to find every call that '
      + 'logged a symptom ("No enum constant", a booking reference, NullPointerException). Masked like bodies. outside: true adds lines no call wrote.',
    inputSchema: {
      scope: ScopeSchema,
      text: z.string().max(500).optional(),
      pattern: z.string().max(200).optional().describe('A Java regex instead of text (stops after 2 s and says cutShort)'),
      minLevel: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']).optional(),
      logger: z.string().max(300).optional(),
      exceptionType: z.string().max(300).optional(),
      project: z.string().optional(),
      from: z.string().optional().describe('ISO time'),
      to: z.string().optional().describe('ISO time'),
      outside: z.boolean().default(false),
      after: z.number().int().optional().describe('The next value of the previous page'),
      limit: z.number().int().min(1).max(200).default(30),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    if (!input.text && !input.pattern && !input.minLevel && !input.logger && !input.exceptionType) {
      throw invalid('Say what to look for: text, pattern, minLevel, logger or exceptionType.');
    }
    const ctx = await maskContext(client, input.mask);
    const answer = await client.post<ScopeAnswer & { total: number; hits: SearchHit[]; next: number | null; cutShort?: { scannedLines: number; reason: string } }>(
      '/call-logs/search', { body: {
        scope: await scopeBody(client, input.scope), project: input.project, from: input.from, to: input.to, text: input.text, pattern: input.pattern,
        minLevel: input.minLevel, logger: input.logger, exceptionType: input.exceptionType, outside: input.outside, before: input.after, limit: input.limit,
      } });
    const hits = answer.hits.map((h) => {
      const [line] = h.callId ? maskLines(ctx, h.callId, [h.line]) : [{ ...h.line, message: maskText(ctx, h.line.message) }];
      return {
        call: h.callId ? `${h.method ?? ''} ${maskText(ctx, h.path ?? '')} → ${h.status ?? '?'}`.trim() : `outside any call (${h.line.project ?? '?'})`,
        callId: h.callId, ...(h.heldIn?.length ? { heldIn: heldInText(h.heldIn) } : {}),
        offsetMs: line.offsetMs, at: line.at, level: line.level, logger: line.logger, thread: line.thread, message: shortMessage(ctx, line.message, 600),
        lineId: line.lineId, ...(line.exception ? { exception: { type: line.exception.type, message: line.exception.message } } : {}),
      };
    });
    const fitted = fitItems(hits, 1200);
    const lastShown = fitted.items.at(-1)?.lineId;
    return ok({
      ...scopeMeta(answer), total: answer.total, shown: fitted.items.length, hits: fitted.items,
      next: fitted.cut && lastShown ? Number(String(lastShown).replace(/^c:/, '')) : answer.next,
      ...(answer.cutShort ? { cutShort: answer.cutShort, note: 'The pattern search stopped early - total counts only the lines it examined. Narrow by text, level, logger or time.' } : {}),
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('log_problems', {
    description: 'The repeated errors of many calls grouped into "log problems": ERROR (and with levels ["ERROR","WARN"] also WARN) lines that mean the '
      + 'same thing - same logger, exception type and message with ids, numbers and times set aside - with how many lines and calls, first and last '
      + 'seen, the endpoints it happened on, whether it is new (first seen in the later half of the scope, or after newSince) and an example line. '
      + 'Pass fingerprint to list the calls that had one problem. Masked like bodies.',
    inputSchema: {
      scope: ScopeSchema,
      levels: z.array(z.enum(['ERROR', 'WARN'])).max(2).default(['ERROR']),
      fingerprint: z.string().regex(/^[0-9a-f]{16}$/).optional().describe('One problem: list its calls'),
      newSince: z.string().optional(),
      project: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(20),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const scope = await scopeBody(client, input.scope);
    if (input.fingerprint) {
      const answer = await client.post<ScopeAnswer & { calls: { callId: string; method?: string; path?: string; status?: number; startedAt?: string; heldIn?: string[]; lines: number; firstAt: string }[]; next: number | null }>(
        '/call-logs/problems/calls', { body: { scope, project: input.project, from: input.from, to: input.to, fingerprint: input.fingerprint, offset: input.offset, limit: input.limit } });
      return ok({
        ...scopeMeta(answer), fingerprint: input.fingerprint,
        calls: answer.calls.map((c) => ({ ...c, path: c.path ? maskText(ctx, c.path) : c.path, heldIn: heldInText(c.heldIn) })), next: answer.next, ...maskMeta(ctx),
      });
    }
    const answer = await client.post<ScopeAnswer & { groups: number; newSince: string; problems: LogProblemRow[] }>(
      '/call-logs/problems', { body: { scope, project: input.project, from: input.from, to: input.to, levels: input.levels, newSince: input.newSince, limit: input.limit } });
    const problems = answer.problems.map((p) => ({ ...p, message: shortMessage(ctx, p.message, 400) }));
    const fitted = fitItems(problems, 1200);
    return ok({
      ...scopeMeta(answer), groups: answer.groups, shown: fitted.items.length, newSince: answer.newSince, problems: fitted.items,
      ...(answer.groups > fitted.items.length ? { note: `${answer.groups - fitted.items.length} more problems - raise limit or narrow by project/from/to.` } : {}),
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('call_story', {
    description: 'One call told in order: its database statements, supplier calls and caught log lines by the call\'s own sequence, with offsets - '
      + 'the Together view of the database window. startAt: "firstError" begins at the first failed statement or error line (with a few items before). '
      + 'Long SQL and messages are shortened (db_statement / call_logs give them whole). Masked like bodies.',
    inputSchema: {
      callId: z.string().min(1),
      cycleId: z.string().optional(),
      startAt: z.union([z.enum(['start', 'firstError']), z.number().int().min(0)]).default('start').describe('"start", "firstError", or an item index'),
      kinds: z.array(z.enum(['statement', 'supplier', 'log'])).optional().describe('Only these kinds of items'),
      limit: z.number().int().min(1).max(300).default(80),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const story = await callStory(client, ctx, input.callId, input.cycleId);
    const items = input.kinds ? story.items.filter((i) => input.kinds!.includes(i.kind)) : story.items;
    const firstError = items.findIndex((i) => i.error);
    let start = typeof input.startAt === 'number' ? input.startAt : 0;
    if (input.startAt === 'firstError') start = firstError >= 0 ? Math.max(0, firstError - 3) : 0;
    const fitted = fitItems(items.slice(start, start + input.limit).map(storyLine), 1200);
    const end = start + fitted.items.length;
    return ok({
      callId: input.callId, items: fitted.items, total: items.length, offset: start, nextOffset: end < items.length ? end : null,
      firstErrorAt: firstError >= 0 ? firstError : null,
      counts: { statements: items.filter((i) => i.kind === 'statement').length, supplierCalls: items.filter((i) => i.kind === 'supplier').length, logLines: story.linesTotal },
      ...(story.statementsWhy ? { noStatements: story.statementsWhy } : {}), ...(story.linesWhy ? { noLogLines: story.linesWhy } : {}),
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('log_context', {
    description: 'The items just before and after one log line of a call - statements, supplier calls and other lines, in the call\'s order - the step '
      + 'that led to an error, without reading the whole call. lineId comes from call_logs, search_logs or call_story.',
    inputSchema: {
      callId: z.string().min(1),
      lineId: z.string().min(1),
      cycleId: z.string().optional(),
      before: z.number().int().min(0).max(50).default(5),
      after: z.number().int().min(0).max(50).default(3),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const story = await callStory(client, ctx, input.callId, input.cycleId);
    const at = story.items.findIndex((i) => i.kind === 'log' && i.ref === input.lineId);
    if (at < 0) throw notFound(`Line ${input.lineId} is not one of call ${input.callId}'s lines${story.linesWhy ? ` (${story.linesWhy})` : ''}.`);
    const from = Math.max(0, at - input.before);
    const window = story.items.slice(from, at + input.after + 1);
    return ok({
      callId: input.callId, line: storyLine(story.items[at]),
      before: window.slice(0, at - from).map(storyLine), after: window.slice(at - from + 1).map(storyLine),
      position: { index: at, of: story.items.length }, ...maskMeta(ctx),
    });
  }));

  server.registerTool('exception_source', {
    description: 'Where a logged exception came from in the project you are working in: its stack\'s application frames (libraries and the '
      + 'server left out) resolved to files and lines, the innermost first - like locate_source does for statement call chains.',
    inputSchema: {
      callId: z.string().min(1),
      lineId: z.string().min(1).describe('From call_logs, search_logs or call_story'),
      cycleId: z.string().optional(),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const { lines, why } = await callLines(client, input.callId, input.cycleId);
    const line = lines.find((l) => l.lineId === input.lineId);
    if (!line) throw notFound(`Line ${input.lineId} is not one of call ${input.callId}'s lines${why ? ` (${why})` : ''}.`);
    if (!line.exception?.stack) {
      return ok({ callId: input.callId, lineId: input.lineId, message: shortMessage(ctx, line.message), note: 'This line carries no exception stack.' });
    }
    const frames = framesOfStack(line.exception.stack);
    const resolved = await resolveFrames(frames.app.slice(0, 20));
    return ok({
      callId: input.callId, lineId: input.lineId, exception: { type: line.exception.type, message: line.exception.message ? maskText(ctx, line.exception.message) : null },
      ...(resolved.length ? { thrownAt: resolved[0] } : { note: 'No application frame in this stack - it was thrown inside a library or the server; read its stack with call_logs.' }),
      applicationFrames: resolved, skippedLibraryFrames: frames.skipped, ...maskMeta(ctx),
    });
  }));

  server.registerTool('outside_logs', {
    description: 'Lines no inbound call wrote - scheduled jobs, message listeners, start-up - for a project around a moment (an ISO time, or a call id '
      + 'to look around that call), grouped by thread, at or above a level. For failures caused by background work.',
    inputSchema: {
      project: z.string().min(1),
      around: z.string().min(1).describe('An ISO time, or a call id'),
      minutesBefore: z.number().min(0).max(120).default(2),
      minutesAfter: z.number().min(0).max(120).default(1),
      minLevel: z.enum(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE']).default('WARN'),
      limit: z.number().int().min(1).max(500).default(200),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    let at = Date.parse(input.around);
    if (Number.isNaN(at)) {
      const call = await client.get<{ timestamp: string }>(`/internal-calls/${seg(input.around)}/summary`, { notFound: `No call ${input.around}, and it is not an ISO time either.` });
      at = Date.parse(call.timestamp);
    }
    const from = new Date(at - input.minutesBefore * 60_000).toISOString();
    const to = new Date(at + input.minutesAfter * 60_000).toISOString();
    const lines = await client.get<OutsideLine[]>('/db-capture/outside/logs', { query: { project: input.project, from, to, minLevel: input.minLevel, limit: input.limit } });
    const byThread = new Map<string, unknown[]>();
    for (const l of lines) {
      const list = byThread.get(l.thread) ?? [];
      list.push({ at: l.at, level: l.level, logger: l.logger, message: shortMessage(ctx, l.message, 400), ...(l.exceptionType ? { exception: l.exceptionType } : {}) });
      byThread.set(l.thread, list);
    }
    return ok({
      project: input.project, from, to, minLevel: input.minLevel, lines: lines.length, ...(lines.length >= input.limit ? { more: true } : {}),
      threads: [...byThread].map(([thread, l]) => ({ thread, lines: l })),
      ...(lines.length ? {} : { note: `No lines outside any call for ${input.project} then (lines outside calls are caught while ▤ is on).` }),
      ...maskMeta(ctx),
    });
  }));
}

export interface LogProblemRow {
  readonly fingerprint: string;
  readonly level: string;
  readonly logger: string;
  readonly exceptionType: string | null;
  readonly message: string;
  readonly lines: number;
  readonly calls: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly isNew: boolean;
  readonly endpoints: { endpoint: string; calls: number }[];
  readonly moreEndpoints?: number;
  readonly example?: { callId: string; lineId: string };
}

interface OutsideLine {
  readonly id: number;
  readonly at: string;
  readonly level: string;
  readonly logger: string;
  readonly thread: string;
  readonly message: string;
  readonly exceptionType?: string;
  readonly exceptionMessage?: string;
}
