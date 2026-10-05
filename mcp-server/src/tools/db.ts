import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { seg, type AlfredClient } from '../alfred-client.ts';
import { liveSummary } from '../calls.ts';
import { analysisOf, childrenOf, loadCapture } from '../db-capture.ts';
import type {
  CallDbCapture, CallRecord, CapturedStatement, ExportedDbStatement, RecordedQueryResult, RowsPage, TraceHit, TypedValue,
} from '../frontend.ts';
import { maskCapture, maskContext, maskMeta, maskQueryResult, type MaskContext } from '../masking.ts';
import { chunkText, fitItems, ok, run } from '../reply.ts';
import { MaskSchema } from './cycles.ts';

const CELL_LIMIT = 300;
const SQL_LIMIT = 6000;

function cell(value: TypedValue | null | undefined): string | null {
  if (!value) return null;
  if (value.opaque) return `(${value.type ?? 'object'} not readable)`;
  return value.value ?? null;
}

function cut(value: string | null): string | null {
  return value !== null && value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}… (${value.length} chars; db_query or db_statement rowsOffset for more)` : value;
}

/** The capture's call, masked with its statements so per-call `db-column` rules apply. */
async function maskedCapture(client: AlfredClient, ctx: MaskContext, callId: string, needCall: boolean): Promise<{ call: CallRecord; capture: CallDbCapture & { statements: readonly CapturedStatement[] } }> {
  const capture = await loadCapture(client, callId);
  // The overview's timing needs the call itself; a statement list does not, and keeps working after
  // the inbound ring buffer dropped the call (the capture outlives it).
  const call = needCall ? (await liveSummary(client, callId, 'inbound')).call : stubCall(callId);
  return { call, capture: maskCapture(ctx, call, capture) as typeof capture };
}

/** Just enough of a call to scope redactions to it, for a statement read on its own. */
function stubCall(callId: string): CallRecord {
  return { id: callId, original_url: '', url: '', method: '', timestamp: '', duration_ms: 0, source: 'internal' };
}

function statementRow(s: CapturedStatement) {
  return {
    id: s.id, seq: s.seq, kind: s.kind, table: s.table ?? null,
    durationMs: Math.round(s.durationMicros / 100) / 10,
    outcome: s.outcome.kind === 'FAILED' ? `FAILED${s.outcome.swallowed ? ' (swallowed)' : ''} ${s.outcome.sqlState ?? ''} ${s.outcome.message ?? ''}`.trim()
      : s.outcome.kind === 'ROWS' ? `${s.outcome.rowsRead ?? 0} rows` : s.outcome.kind === 'UPDATED' ? `${s.outcome.affected ?? 0} updated` : s.outcome.kind,
    sqlPreview: s.sql.length > 160 ? `${s.sql.slice(0, 160)}…` : s.sql,
    at: s.callers?.[0] ?? s.codeLocation ?? null,
  };
}

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('db_overview', {
    description: 'Database overview of one captured inbound call - exactly what Alfred\'s database window shows: the summary line, where the time went, '
      + 'per-query totals and every finding (fan-outs, swallowed failures, duplicates, slow statements) with the statement numbers (#seq) involved.',
    inputSchema: {
      callId: z.string().min(1),
      queries: z.number().int().min(0).max(100).default(8).describe("How many per-query totals to include (costliest first)"),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const { call, capture } = await maskedCapture(client, ctx, input.callId, true);
    const analysis = analysisOf(call, capture, await childrenOf(client, call.id));
    const queries = fitItems(analysis.queries.slice(0, input.queries).map((q) => ({ ...q, sql: q.sql.length > 200 ? `${q.sql.slice(0, 200)}…` : q.sql })), JSON.stringify(analysis.findings).length + JSON.stringify(analysis.time).length + 600).items;
    return ok({
      callId: call.id, statements: capture.statements.length, summary: analysis.summary, time: analysis.time,
      findings: analysis.findings, queries, queryCount: analysis.queries.length, ...maskMeta(ctx),
    });
  }));

  server.registerTool('db_statements', {
    description: 'List a captured call\'s database statements in order, filtered and paged: seq, kind, table, duration, outcome, SQL preview and the application frame that ran it.',
    inputSchema: {
      callId: z.string().min(1),
      failedOnly: z.boolean().optional(),
      slowMicros: z.number().int().min(0).optional().describe('Only statements at least this slow (microseconds). No default.'),
      kind: z.string().optional().describe('SELECT, INSERT, UPDATE, DELETE, CALL, ...'),
      table: z.string().optional(),
      text: z.string().optional().describe('Text in the SQL'),
      seqFrom: z.number().int().optional(),
      seqTo: z.number().int().optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const { capture } = await maskedCapture(client, ctx, input.callId, false);
    const matching = [...capture.statements].sort((a, b) => a.seq - b.seq)
      .filter((s) => !input.failedOnly || s.outcome.kind === 'FAILED')
      .filter((s) => input.slowMicros === undefined || s.durationMicros >= input.slowMicros)
      .filter((s) => !input.kind || s.kind.toLowerCase() === input.kind.toLowerCase())
      .filter((s) => !input.table || (s.table ?? '').toLowerCase().includes(input.table.toLowerCase()))
      .filter((s) => !input.text || s.sql.toLowerCase().includes(input.text.toLowerCase()))
      .filter((s) => input.seqFrom === undefined || s.seq >= input.seqFrom)
      .filter((s) => input.seqTo === undefined || s.seq <= input.seqTo);
    const fitted = fitItems(matching.slice(input.offset, input.offset + input.limit).map(statementRow), 400);
    const end = input.offset + fitted.items.length;
    return ok({ total: matching.length, offset: input.offset, nextOffset: end < matching.length ? end : null, statements: fitted.items, ...maskMeta(ctx) });
  }));

  server.registerTool('db_statement', {
    description: 'One database statement in full: SQL, bound parameters, result rows (paged), outcome/error, transaction, the application call chain '
      + '(callers: class.method(File.java:line), innermost first) and the ORM query (HQL) that produced it. Use the id from db_statements.',
    inputSchema: {
      statementId: z.number().int().min(1),
      rowsOffset: z.number().int().min(0).default(0),
      rowsLimit: z.number().int().min(0).max(200).default(20),
      part: z.enum(['RESULT', 'BEFORE_IMAGE']).default('RESULT'),
      sqlOffset: z.number().int().min(0).default(0),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const statement = await client.get<CapturedStatement>(`/db-capture/statements/${seg(input.statementId)}`, { notFound: `Statement ${input.statementId} not found.` });
    const page = input.rowsLimit > 0
      ? await client.get<RowsPage>(`/db-capture/statements/${seg(input.statementId)}/rows`, { query: { part: input.part, offset: input.rowsOffset, limit: input.rowsLimit } }).catch(() => null)
      : null;
    // Masked as a one-statement capture of its own call, so the same redactDbCapture path hides params, rows and origin.
    const asExported: ExportedDbStatement = input.part === 'RESULT' ? { ...statement, rows: page?.rows ?? null } : { ...statement, beforeImageRows: page?.rows ?? null };
    const capture: CallDbCapture = { statements: [asExported], transactions: [] };
    const masked = (statement.callId ? maskCapture(ctx, stubCall(statement.callId), capture) : capture).statements[0] as ExportedDbStatement;
    const rows = (input.part === 'RESULT' ? masked.rows : masked.beforeImageRows) ?? [];
    const sql = chunkText(masked.sql, input.sqlOffset, SQL_LIMIT);
    return ok({
      id: masked.id, callId: masked.callId, seq: masked.seq, kind: masked.kind, table: masked.table ?? null,
      sql: sql.nextOffset === null && sql.offset === 0 ? masked.sql : sql,
      params: masked.params.map((set) => set.map((v) => (v ? `${v.type ?? ''}:${v.value ?? 'null'}` : null))),
      outcome: masked.outcome, durationMs: masked.durationMicros / 1000, startedAt: masked.startedAt, offsetMs: masked.offsetMicros / 1000,
      txId: masked.txId ?? null, undone: masked.undone, expected: masked.expected,
      codeLocation: masked.codeLocation ?? null, callers: masked.callers ?? null, origin: masked.origin ?? null,
      rows: page ? {
        part: input.part, columns: page.columns.map((c) => `${c.name}:${c.type}`), offset: input.rowsOffset, total: page.total,
        nextOffset: input.rowsOffset + rows.length < page.total ? input.rowsOffset + rows.length : null,
        rows: rows.map((r) => r.map((v) => cut(cell(v)))),
      } : null,
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('db_query', {
    description: 'The database window\'s search over one call\'s recorded statements: mode "search" (free text) or "sql" (SQL over the recorded statements '
      + 'and rows - never the application\'s database). Same results as the UI.',
    inputSchema: {
      callId: z.string().min(1),
      mode: z.enum(['search', 'sql']).default('search'),
      text: z.string().min(1),
      sortColumn: z.string().optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(50),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const raw = await client.post<RecordedQueryResult>(`/db-capture/calls/${seg(input.callId)}/statements/query`, {
      body: { mode: input.mode, text: input.text, offset: input.offset, limit: input.limit, sortColumn: input.sortColumn ?? null, sortDir: input.sortDir ?? null },
    });
    const result = maskQueryResult(ctx, input.callId, raw);
    const fitted = fitItems(result.rows.map((r) => r.map(cut)), 600);
    const end = input.offset + fitted.items.length;
    return ok({
      columns: result.columns, total: result.total, offset: input.offset, nextOffset: end < result.total ? end : null,
      rows: fitted.items, ...(result.statementSeqs ? { statementSeqs: result.statementSeqs } : {}), ...(result.error ? { error: result.error } : {}), ...maskMeta(ctx),
    });
  }));

  server.registerTool('trace_value', {
    description: 'Where a value appears in one call\'s database capture: as a bound parameter, in result rows, before-images, generated keys or OUT parameters, by statement #seq.',
    inputSchema: { callId: z.string().min(1), value: z.string().min(1), mask: MaskSchema },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const result = await client.get<{ hits: TraceHit[] }>(`/db-capture/calls/${seg(input.callId)}/trace`, { query: { value: input.value } });
    // The hits are positions only; the value itself is never echoed back, masked or not.
    return ok({ callId: input.callId, hits: result.hits.slice(0, 500), total: result.hits.length, ...maskMeta(ctx) });
  }));
}
