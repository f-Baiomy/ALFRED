import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AlfredClient } from '../alfred-client.ts';
import { callStory, callLines, isErrorLine } from '../call-story.ts';
import type { CallStoreSummary, CallSummaryDto, TriageEntry } from '../frontend.ts';
import { maskContext, maskMeta, maskText } from '../masking.ts';
import { fitItems, ok, run } from '../reply.ts';
import { heldInText, scopeBody, ScopeSchema, type Scope } from '../scope.ts';
import { isError, SIGNALS, SIGNAL_TEXT, signalEvidence, signalsOfEntry, type SignalName } from '../signals.ts';
import { framesOfStack, resolveFrames } from '../source.ts';
import { triageOf } from '../triage.ts';
import { MaskSchema } from './cycles.ts';
import { scopeMeta, type LogProblemRow, type ScopeAnswer } from './logs.ts';

/**
 * Cross-call investigation (specs/010-mcp-log-investigation): every call with an error or a warning, from HTTP, the
 * database or the logs (problem_calls), endpoint health, when problems started (problem_timeline), two cycles compared
 * (compare_cycles), and one call's investigation report (investigate_call) - answered by the backend over triage's saved
 * marks and db-capture's caught lines, never by reading every call here.
 */

const SignalSchema = z.enum(SIGNALS);

interface ProblemCallRow {
  readonly callId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly error?: string;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly project: string | null;
  readonly heldIn: string[];
  readonly signals: SignalName[];
  readonly severity: 'error' | 'warning';
  readonly evidence: {
    failedStatements: number; swallowed: boolean; dbFlags: string[]; logErrors: number; logWarnings: number; logExceptions: number;
    failingSupplierCalls: number; logStatus: string | null; logLevel: string | null; redisFailed?: number; cacheCold?: number;
  };
}

type ProblemCallsAnswer = ScopeAnswer & { counts: Record<string, number>; matching: number; unmarked?: number; calls: ProblemCallRow[]; next: number | null };

async function problemCalls(client: AlfredClient, scope: Scope, body: Record<string, unknown>): Promise<ProblemCallsAnswer> {
  return client.post<ProblemCallsAnswer>('/triage/problem-calls', { body: { scope: await scopeBody(client, scope), ...body } });
}

function evidenceText(row: ProblemCallRow): string {
  const e = row.evidence;
  const parts: string[] = [];
  if (row.error) parts.push(`no answer: ${row.error}`);
  if (e.failedStatements) parts.push(`✖ DB ${e.failedStatements} failed${e.swallowed ? ' (swallowed)' : ''}`);
  if (e.failingSupplierCalls) parts.push(`${e.failingSupplierCalls} supplier call${e.failingSupplierCalls > 1 ? 's' : ''} failed`);
  const sig = signalEvidence({ logErrors: e.logErrors, logWarnings: e.logWarnings, logExceptions: e.logExceptions, logLevel: e.logLevel, dbFlags: e.dbFlags,
    redisFailed: e.redisFailed, redisCold: e.cacheCold });
  if (sig) parts.push(sig);
  return parts.join(' · ');
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('problem_calls', {
    description: 'Every call with an error or a warning - from HTTP (error status, no answer), the database (failed statement, any database flag: '
      + 'slow, N+1, huge result, no WHERE...), the logs (ERROR line, exception, WARN line) or a failing supplier call - over the live calls, a cycle, '
      + 'several cycles or everything. Starts with how many calls carry each signal, then the calls most severe first, each with all its signals '
      + 'and one line of evidence. Combine signals: all (each of), any (one of), none (not): e.g. all:["LOG_ERROR"], none:["HTTP_ERROR"] = 2xx calls '
      + 'that logged an error. Signals: ' + SIGNALS.map((s) => `${s} (${SIGNAL_TEXT[s]})`).join(', ') + '.',
    inputSchema: {
      scope: ScopeSchema,
      all: z.array(SignalSchema).max(8).optional(),
      any: z.array(SignalSchema).max(8).optional(),
      none: z.array(SignalSchema).max(8).optional(),
      dbFlags: z.array(z.string()).max(20).optional().describe('Only these database flags count as DB_WARNING, e.g. ["REPEATED_QUERY","SLOW"]'),
      minStatus: z.number().int().min(100).max(600).optional().describe('An HTTP status at or over this is an error (400 by default)'),
      project: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(40),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const answer = await problemCalls(client, input.scope, {
      all: input.all, any: input.any, none: input.none, dbFlags: input.dbFlags, minStatus: input.minStatus, project: input.project,
      from: input.from, to: input.to, offset: input.offset, limit: input.limit,
    });
    const calls = answer.calls.map((c) => ({
      callId: c.callId, call: `${c.method} ${maskText(ctx, c.path)} → ${c.status ?? (c.error ? 'no answer' : '?')}`, startedAt: c.startedAt,
      ...(c.durationMs != null ? { durationMs: Math.round(c.durationMs) } : {}), project: c.project, heldIn: heldInText(c.heldIn),
      severity: c.severity, signals: c.signals, evidence: maskText(ctx, evidenceText(c)),
    }));
    const fitted = fitItems(calls, 1500);
    const end = input.offset + fitted.items.length;
    return ok({
      ...scopeMeta(answer), counts: answer.counts, matching: answer.matching, ...(answer.unmarked ? { notYetMarked: answer.unmarked } : {}),
      calls: fitted.items, offset: input.offset, nextOffset: end < answer.matching ? end : null,
      next: 'investigate_call on one of them; call_story / log_context for its order of events; search_logs or log_problems across calls.',
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('endpoint_health', {
    description: 'Which endpoints are unhealthy: per endpoint (method and path, ids in the path grouped as {id}) its calls and how many had an HTTP '
      + 'error, a failed statement, a database flag, an ERROR or WARN log line, a failed Redis command, a cold cache miss or a failing supplier call, with median and slowest duration - '
      + 'worst first, over any scope. Endpoints with captured Redis commands carry `redis`: commands per call, hit rate, misses filled from the database per call, Redis time.',
    inputSchema: {
      scope: ScopeSchema, project: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(30),
    },
  }, (input) => run(async () => {
    const answer = await client.post<ScopeAnswer & { endpoints: Record<string, unknown>[] }>('/triage/endpoints', {
      body: { scope: await scopeBody(client, input.scope), project: input.project, from: input.from, to: input.to, limit: input.limit },
    });
    return ok({ ...scopeMeta(answer), endpoints: fitItems(answer.endpoints, 1000).items });
  }));

  server.registerTool('problem_timeline', {
    description: 'When problems started: per time bucket (1 minute by default, widened to at most 1,440 buckets) how many calls ran and how many '
      + 'carried each signal, and the first moment each signal was seen - to tell a deployment or data change from a constant bug. Empty buckets '
      + 'are left out.',
    inputSchema: {
      scope: ScopeSchema, project: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
      bucketMinutes: z.number().int().min(1).max(1440).default(1),
    },
  }, (input) => run(async () => {
    const answer = await client.post<ScopeAnswer & { bucketMinutes: number; buckets: { start: string; calls: number; counts: Record<string, number> }[]; firstSeen: Record<string, string> }>(
      '/triage/timeline', { body: { scope: await scopeBody(client, input.scope), project: input.project, from: input.from, to: input.to, bucketMinutes: input.bucketMinutes } });
    const fitted = fitItems(answer.buckets, 1500);
    return ok({
      ...scopeMeta(answer), bucketMinutes: answer.bucketMinutes, firstSeen: answer.firstSeen, buckets: fitted.items,
      ...(fitted.cut ? { more: answer.buckets.length - fitted.items.length, note: 'Narrow with from/to, or widen bucketMinutes.' } : {}),
    });
  }));

  server.registerTool('compare_cycles', {
    description: 'Two session cycles compared - before and after a fix, yesterday and today: log problems that are new, gone or still there (with '
      + 'their counts in both), and the calls per signal side by side (HTTP errors, failed statements, database flags, log errors and warnings).',
    inputSchema: {
      before: z.string().min(1).describe('Cycle id or name'),
      after: z.string().min(1).describe('Cycle id or name'),
      withWarnings: z.boolean().default(false).describe('Group WARN lines too'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const levels = input.withWarnings ? ['ERROR', 'WARN'] : ['ERROR'];
    const side = async (cycle: string) => {
      const scope = await scopeBody(client, { cycle });
      const [problems, calls] = await Promise.all([
        client.post<ScopeAnswer & { groups: number; problems: LogProblemRow[] }>('/call-logs/problems', { body: { scope, levels, limit: 100 } }),
        client.post<ProblemCallsAnswer>('/triage/problem-calls', { body: { scope, limit: 1 } }),
      ]);
      return { problems, counts: calls.counts, scope: calls.scope };
    };
    const [a, b] = await Promise.all([side(input.before), side(input.after)]);
    const inA = new Map(a.problems.problems.map((p) => [p.fingerprint, p]));
    const inB = new Map(b.problems.problems.map((p) => [p.fingerprint, p]));
    const row = (p: LogProblemRow, before: number, after: number) => ({
      level: p.level, logger: p.logger, exceptionType: p.exceptionType, message: maskText(ctx, p.message.slice(0, 300)), linesBefore: before, linesAfter: after,
      fingerprint: p.fingerprint, example: p.example,
    });
    const fresh = [...inB.values()].filter((p) => !inA.has(p.fingerprint)).map((p) => row(p, 0, p.lines));
    const gone = [...inA.values()].filter((p) => !inB.has(p.fingerprint)).map((p) => row(p, p.lines, 0));
    const still = [...inB.values()].filter((p) => inA.has(p.fingerprint)).map((p) => row(p, inA.get(p.fingerprint)!.lines, p.lines));
    const signalCounts = Object.fromEntries(SIGNALS.map((s) => [s, { before: a.counts[s] ?? 0, after: b.counts[s] ?? 0 }]));
    return ok({
      before: { cycle: input.before, calls: a.scope.calls, logProblems: a.problems.groups },
      after: { cycle: input.after, calls: b.scope.calls, logProblems: b.problems.groups },
      signals: signalCounts, newProblems: fresh, goneProblems: gone, stillThere: fitItems(still, 4000).items,
      ...(a.problems.groups > 100 || b.problems.groups > 100 ? { note: 'Only the 100 most frequent log problems of each cycle were compared.' } : {}),
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('investigate_call', {
    description: 'A ready-made investigation of one inbound call: its status and signals, the first error (failed statement or error log line) with '
      + 'the five items before it, where its logged exception was thrown in the project, its failing supplier calls, and the most similar call of '
      + 'the same endpoint that succeeded (to compare with diff_calls). A starting point to drill into with call_story, log_context, db_statement.',
    inputSchema: { callId: z.string().min(1), cycleId: z.string().optional(), mask: MaskSchema },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const [marks, story] = await Promise.all([triageOf(client, [input.callId]).catch(() => ({}) as Record<string, TriageEntry>), callStory(client, ctx, input.callId, input.cycleId)]);
    const entry = marks[input.callId];
    const signals = entry ? signalsOfEntry(entry) : [];
    const firstError = story.firstErrorIndex;
    const errorWindow = firstError == null ? [] : story.items.slice(Math.max(0, firstError - 5), firstError + 1).map((i) => ({
      seq: i.seq, kind: i.kind, text: i.text, ...(i.offsetMs != null ? { offsetMs: i.offsetMs } : {}), ...(i.error ? { error: true } : {}),
      ...(i.ref != null ? { ref: i.ref } : {}),
    }));

    // the first logged exception, resolved to the project's source
    let exception: Record<string, unknown> | null = null;
    const { lines } = await callLines(client, input.callId, input.cycleId).catch(() => ({ lines: [] as never[] }));
    const thrown = lines.find((l) => isErrorLine(l) && l.exception?.stack);
    if (thrown) {
      const frames = framesOfStack(thrown.exception!.stack);
      const resolved = await resolveFrames(frames.app.slice(0, 8));
      exception = {
        lineId: thrown.lineId, type: thrown.exception!.type, message: thrown.exception!.message ? maskText(ctx, thrown.exception!.message) : null,
        ...(resolved[0] ? { thrownAt: resolved[0] } : { note: 'thrown inside a library or the server - no application frame' }),
      };
    }

    const similar = entry && !signals.some(isError) ? null : await similarSuccess(client, input.callId, entry);
    // the call's Redis at a glance (specs/011-redis-capture) - no summary = ⬢ was off for it
    const redisSummary = (await client.get<Record<string, CallStoreSummary>>('/db-capture/store/summaries', { query: { callIds: input.callId } })
      .catch(() => ({}) as Record<string, CallStoreSummary>))[input.callId];
    const redis = redisSummary ? {
      commands: redisSummary.commands, hits: redisSummary.hits, misses: redisSummary.misses, failed: redisSummary.failed,
      ms: Math.round(redisSummary.micros / 100) / 10, ...(redisSummary.dropped ? { notKept: redisSummary.dropped } : {}),
      next: redisSummary.failed || redisSummary.misses ? 'redis_overview for the findings, redis_commands filter:"failed" / "misses"' : 'redis_commands',
    } : null;
    return ok({
      callId: input.callId,
      ...(entry ? {
        call: `${entry.method ?? ''} ${maskText(ctx, entry.url ?? '')} → ${entry.status ?? (entry.error ? 'no answer' : '?')}`,
        startedAt: new Date(entry.startedAt).toISOString(), durationMs: entry.durationMs,
        signals: signals.map((s) => ({ signal: s, meaning: SIGNAL_TEXT[s] })),
        ...(signalEvidence(entry.signals) ? { logAndDb: signalEvidence(entry.signals) } : {}),
      } : { note: 'Triage has no mark for this call yet (recorded before triage, or still arriving).' }),
      firstError: errorWindow.length ? { atItem: firstError, window: errorWindow } : null,
      ...(exception ? { exception } : {}),
      failingSupplierCalls: (entry?.failingSupplierCalls ?? []).map((s) => ({
        callId: s.callId, call: `${s.method ?? ''} ${maskText(ctx, s.url ?? '')} → ${s.status ?? (s.error ? 'no answer' : '?')}`,
        ...(s.softFailure ? { softFailure: maskText(ctx, `${s.softFailure.code ? `${s.softFailure.code}: ` : ''}${s.softFailure.message}`) } : {}),
      })),
      ...(similar ? { similarSuccess: similar } : {}),
      ...(redis ? { redis } : {}),
      ...(story.statementsWhy ? { noStatements: story.statementsWhy } : {}), ...(story.linesWhy ? { noLogLines: story.linesWhy } : {}),
      next: 'call_story startAt:"firstError", log_context on the error line, exception_source, diff_calls with similarSuccess.',
      ...maskMeta(ctx),
    });
  }));
}

/** The nearest live call of the same endpoint (same method, same path) that succeeded - error signals none. */
async function similarSuccess(client: AlfredClient, callId: string, entry: TriageEntry | undefined): Promise<{ callId: string; startedAt: string } | null> {
  if (!entry?.url || !entry.method) return null;
  let path: string;
  try {
    path = new URL(entry.url, 'http://x').pathname;
  } catch {
    return null;
  }
  const page = await client.get<{ calls: CallSummaryDto[] }>('/internal-calls', { query: { search: path, limit: 100, sort: 'newest' } }).catch(() => ({ calls: [] }));
  const candidates = page.calls.filter((c) => c.id !== callId && c.method === entry.method && (c.status ?? 0) > 0 && (c.status ?? 0) < 400 && !c.error);
  if (!candidates.length) return null;
  const marks = await triageOf(client, candidates.map((c) => c.id)).catch(() => ({}) as Record<string, TriageEntry>);
  const clean = candidates.filter((c) => !marks[c.id] || !signalsOfEntry(marks[c.id]).some(isError))
    .sort((x, y) => Math.abs(Date.parse(x.timestamp) - entry.startedAt) - Math.abs(Date.parse(y.timestamp) - entry.startedAt));
  return clean[0] ? { callId: clean[0].id, startedAt: clean[0].timestamp } : null;
}

