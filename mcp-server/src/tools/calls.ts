import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AlfredError, type AlfredClient } from '../alfred-client.ts';
import {
  bodyView, liveSummary, partsFor, select, sourceOf, toRow, withParts,
  type CallRef, type Direction, type FieldName,
} from '../calls.ts';
import { listCycleCalls, requireCycle, segmentOf } from '../cycle-calls.ts';
import { analysisOf, childrenOf, dbSummaries, loadCapture, nonNoteFindings } from '../db-capture.ts';
import {
  callTime, detectAndFormatBody, emptyResultOf, softFailureOf, toCallRecord, type CallEndpointSource, type CallStatementFailures, type SoftFailure, type CallRecord, type CallSummaryDto, type Comment, type CommentBlock,
} from '../frontend.ts';
import { maskCall, maskCalls, maskContext, maskMeta, maskText, type MaskContext } from '../masking.ts';
import { chunkText, fitItems, ok, preview, run } from '../reply.ts';
import { GROUP_TITLES, outcomeOf, statementFailuresOf, triageOrNull } from '../triage.ts';
import type { TriageEntry } from '../frontend.ts';
import { FieldsSchema, MaskSchema, PathsSchema } from './cycles.ts';

const SCAN_PAGE = 200;
export const SCAN_CAP = 2000;
/** Response bodies read per search to find errors inside successful responses (failed: true). */
const SOFT_CHECK_LIMIT = 200;

/** What a call's own bodies say went wrong despite its status - only present when there is something. */
function flagsOf(call: CallRecord): { softFailure?: SoftFailure; emptyResult?: string[] } {
  const soft = softFailureOf(call);
  const empty = call.source === 'internal' ? emptyResultOf(call) : null;
  return { ...(soft ? { softFailure: soft } : {}), ...(empty ? { emptyResult: [...empty.emptyKeys] } : {}) };
}

const Block = z.enum(['request-headers', 'request-body', 'response-headers', 'response-body']);

/** Resolves a call Claude names: a cycle's copy when cycleId is given, else the live log. */
export async function resolveCall(client: AlfredClient, id: string, direction?: Direction, cycleId?: string): Promise<{ ref: CallRef; call: CallRecord }> {
  if (cycleId) {
    const cycle = await requireCycle(client, cycleId);
    const { entries } = await listCycleCalls(client, cycle.id);
    const entry = entries.find((e) => e.call.id === id || e.capturedId === id);
    if (!entry) throw new AlfredError('not_found', `Call ${id} is not in cycle "${cycle.name}".`);
    return { ref: { id: entry.call.id, source: entry.call.source ?? 'external', cycleId: cycle.id }, call: entry.call };
  }
  const { call, source } = await liveSummary(client, id, direction);
  return { ref: { id, source }, call };
}

/** Pretty JSON, as the call card shows headers - so a line number here is the line add_comment anchors to. */
function headerText(headers: Readonly<Record<string, string>> | undefined): string {
  return JSON.stringify(headers ?? {}, null, 2);
}

async function dbLine(client: AlfredClient, ctx: MaskContext, call: CallRecord): Promise<unknown> {
  if (call.source !== 'internal') return undefined;
  const summaries = await dbSummaries(client, [call.id]);
  if (!summaries[call.id]) return null;
  const capture = await loadCapture(client, call.id);
  const analysis = analysisOf(call, capture, await childrenOf(client, call.id));
  return {
    summary: maskText(ctx, analysis.summary ?? ''),
    statements: capture.statements.length,
    findings: nonNoteFindings(analysis).map((f) => ({ severity: f.severity, title: maskText(ctx, f.title), short: maskText(ctx, f.short), seqs: f.seqs })),
    more: 'db_overview for the time breakdown and every finding; db_statements / db_statement for the statements.',
  };
}

// ------------------------------------------------------------------------------------------------ search

export interface SearchInput {
  direction: 'inbound' | 'outbound' | 'both';
  project?: string;
  supplier?: string;
  text?: string;
  status?: number | string;
  failed?: boolean;
  needsAttention?: boolean;
  dbFailed?: boolean;
  minStatus?: number;
  slowMs?: number;
  from?: string;
  to?: string;
  sort: 'newest' | 'oldest' | 'slowest';
}

interface ListPage { readonly calls: readonly CallSummaryDto[]; readonly total: number }

function statusMatches(call: CallRecord, status: number | string | undefined): boolean {
  if (status === undefined) return true;
  const code = call.response?.status;
  if (typeof status === 'number') return code === status;
  const cls = /^([1-5])xx$/i.exec(status);
  return cls ? code != null && Math.floor(code / 100) === Number(cls[1]) : String(code) === status;
}

function isFailed(call: CallRecord): boolean {
  return !!call.error || call.state === 'ERROR' || (call.response?.status ?? 0) >= 400;
}

/**
 * The live list API filters by text, supplier and project only; status, failure, slowness and time
 * are applied here while paging summaries (never bodies), bounded by SCAN_CAP rows per direction
 * and reported when hit (research R3).
 */
export interface CallFilters {
  project?: string;
  status?: number | string;
  failed?: boolean;
  needsAttention?: boolean;
  dbFailed?: boolean;
  minStatus?: number;
  slowMs?: number;
}

/** Whether a filter needs the calls' saved marks (one request per page of calls). */
export function wantsMarks(f: CallFilters): boolean {
  return !!(f.failed || f.needsAttention || f.dbFailed);
}

/**
 * The filters the list API cannot apply, shared by search_calls and search_cycle so both judge a call
 * alike. `softFailed` reads the body only when it decides the outcome - a call already failing by
 * status or error never costs a body fetch.
 */
export async function passesFilters(call: CallRecord, f: CallFilters, softFailed: () => Promise<boolean>, mark?: TriageEntry | null): Promise<boolean> {
  if (call.source === 'external' && f.project && call.service_name !== f.project) return false;
  if (!statusMatches(call, f.status)) return false;
  if (f.slowMs !== undefined && (call.duration_ms ?? 0) < f.slowMs) return false;
  // The saved mark answers "error inside a 200" without the body; a call with no mark is judged from its body.
  const soft = async () => (mark ? !!mark.softFailure : softFailed());
  if (f.failed && !isFailed(call) && !(await soft())) return false;
  if (f.needsAttention) {
    const own = mark ? mark.needsAttention : !!call.error || call.state === 'ERROR' || (call.response?.status ?? 0) >= (f.minStatus ?? 300);
    if (!own && !(await soft())) return false;
  }
  if (f.dbFailed && !(mark && mark.failedStatements > 0)) return false;
  return true;
}

export async function searchCalls(client: AlfredClient, input: SearchInput, want: number): Promise<{ calls: CallRecord[]; scanned: number; scanCapHit: boolean; softCapHit: boolean; more: boolean }> {
  const fromMs = input.from ? Date.parse(input.from) : undefined;
  const toMs = input.to ? Date.parse(input.to) : undefined;
  // A project names inbound traffic; with no supplier asked for, outbound would only be scanned to find nothing.
  const sources: CallEndpointSource[] = input.direction !== 'both' ? [sourceOf(input.direction)]
    : input.project && !input.supplier ? ['internal'] : ['internal', 'external'];
  const serverSort = input.sort === 'newest' ? 'newest-call' : input.sort === 'oldest' ? 'oldest-call' : 'slowest';
  let scanned = 0;
  let scanCapHit = false;
  let softChecks = 0;
  let softCapHit = false;
  const found: CallRecord[] = [];
  for (const source of sources) {
    const matches: CallRecord[] = [];
    for (let offset = 0; offset < SCAN_CAP; offset += SCAN_PAGE) {
      const page = await client.get<ListPage>(`/${segmentOf(source)}`, {
        query: {
          search: input.text, supplier: source === 'external' ? input.supplier : undefined,
          serviceNames: source === 'internal' ? input.project : undefined, sort: serverSort, offset, limit: SCAN_PAGE,
        },
      });
      scanned += page.calls.length;
      let pastWindow = false;
      const marks = wantsMarks(input) ? await triageOrNull(client, page.calls.map((c) => c.id), input.minStatus) : null;
      for (const dto of page.calls) {
        const call = toCallRecord(dto, source);
        const t = callTime(call);
        if (fromMs !== undefined && t < fromMs) { if (input.sort === 'newest') pastWindow = true; continue; }
        if (toMs !== undefined && t > toMs) { if (input.sort === 'oldest') pastWindow = true; continue; }
        const pass = await passesFilters(call, input, async () => {
          // A 200 can still be a failure (an error in its body): read that body, within a budget.
          if (softChecks >= SOFT_CHECK_LIMIT) { softCapHit = true; return false; }
          softChecks++;
          const bodied = await withParts(client, { id: call.id, source }, call, ['response-body']).catch(() => call);
          return !!softFailureOf(bodied);
        }, marks?.[call.id]);
        if (pass) matches.push(call);
      }
      if (pastWindow || matches.length >= want || page.calls.length < SCAN_PAGE || offset + SCAN_PAGE >= page.total) break;
      if (offset + SCAN_PAGE >= SCAN_CAP) scanCapHit = true;
    }
    found.push(...matches);
  }
  const order = input.sort === 'slowest'
    ? (a: CallRecord, b: CallRecord) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1)
    : input.sort === 'oldest' ? (a: CallRecord, b: CallRecord) => callTime(a) - callTime(b) : (a: CallRecord, b: CallRecord) => callTime(b) - callTime(a);
  found.sort(order);
  return { calls: found.slice(0, want), scanned, scanCapHit, softCapHit, more: found.length > want };
}

export const SearchSchema = {
  direction: z.enum(['inbound', 'outbound', 'both']).default('both'),
  project: z.string().optional().describe('Project name, e.g. odeysys: its inbound calls (and, for outbound, only calls attributed to it)'),
  supplier: z.string().optional().describe('Outbound supplier host, e.g. api.cert.platform.sabre.com'),
  text: z.string().optional().describe('Case-insensitive text in method, URL, status, error, headers or bodies'),
  status: z.union([z.number().int(), z.string().regex(/^([1-5]xx|\d{3})$/i)]).optional().describe('Exact status (404) or class (5xx)'),
  failed: z.boolean().optional().describe('Only failures: errors, status >= 400, and errors inside a successful response body (SOAP Fault, OTA Error, JSON errors)'),
  needsAttention: z.boolean().optional().describe('Only calls needing attention: status >= minStatus (default 300, so redirects count), an error, '
    + 'still running long after it started, or an error inside a successful body'),
  dbFailed: z.boolean().optional().describe('Only inbound calls with a failed database statement (whatever their own status - a 200 can hide one)'),
  minStatus: z.number().int().min(300).max(600).optional().describe('Threshold for needsAttention (default 300)'),
  slowMs: z.number().min(0).optional().describe('Only calls at least this slow'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['newest', 'oldest', 'slowest']).default('newest'),
};

export function register(server: McpServer, client: AlfredClient): void {
  server.registerTool('get_call', {
    description: 'One recorded call in full: request/response headers, bodies (paged - see totalLength/nextOffset), timing, comments, '
      + 'the supplier calls an inbound call made (children, with ids), and its database summary. Use fields/paths to read only parts of it '
      + '(e.g. fields ["method","url"]). Pass cycleId to read a cycle\'s copy (works after the live log dropped the call).',
    inputSchema: {
      id: z.string().min(1),
      direction: z.enum(['inbound', 'outbound']).optional(),
      cycleId: z.string().optional(),
      fields: FieldsSchema,
      paths: PathsSchema,
      bodyOffset: z.number().int().min(0).default(0),
      bodyLength: z.number().int().min(256).max(15000).default(4000),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const { ref, call: summary } = await resolveCall(client, input.id, input.direction, input.cycleId);
    const selective = !!(input.fields?.length || input.paths?.length);
    const parts = selective ? partsFor(input.fields, input.paths) : 'all';
    const call = maskCall(ctx, await withParts(client, ref, summary, parts));
    const wants = (f: FieldName) => !selective || input.fields?.includes(f);
    const extras = {
      children: wants('children') && call.source === 'internal' && !ref.cycleId
        ? maskCalls(ctx, await childrenOf(client, call.id)).map(toRow) : undefined,
      comments: wants('comments')
        ? (await client.get<Comment[]>('/comments', { query: { callId: call.id } }))
          .map((c) => ({ id: c.id, block: c.block, line: c.lineIndex + 1, lineText: maskText(ctx, c.lineText), comment: preview(maskText(ctx, c.comment), 500, `list_comments commentId ${c.id}`) }))
        : undefined,
      db: wants('db') ? await dbLine(client, ctx, call) : undefined,
    };
    if (selective) {
      const sel = select(call, input.fields, input.paths, extras, input.bodyOffset, input.bodyLength);
      return ok({ id: call.id, ...sel.values, ...(call.response?.body ? flagsOf(call) : {}), ...(sel.missing.length ? { missing: sel.missing } : {}), ...maskMeta(ctx) });
    }
    // The saved mark (priority and the failing supplier calls) and the failed statements from their index - no
    // statement list is loaded for them.
    const mark = (await triageOrNull(client, [call.id]))?.[call.id];
    const failures = call.source === 'internal' && wants('db') ? (await statementFailuresOf(client, [call.id]).catch(() => ({} as Record<string, CallStatementFailures>)))[call.id] : undefined;
    return ok({
      ...toRow(call),
      originalUrl: call.original_url,
      ...(mark ? {
        attention: {
          priority: mark.priority, group: GROUP_TITLES[mark.priority], needsAttention: mark.needsAttention,
          ...(mark.failingSupplierCalls.length ? {
            failingSupplierCalls: mark.failingSupplierCalls.map((s) => ({
              id: s.callId, url: maskText(ctx, s.url ?? ''), outcome: maskText(ctx, outcomeOf(s)),
              ...(s.softFailure ? { softFailure: { ...s.softFailure, message: maskText(ctx, s.softFailure.message) } } : {}),
            })),
          } : {}),
        },
      } : {}),
      ...(failures ? {
        dbFailures: {
          failedCount: failures.failedCount, swallowedCount: failures.swallowedCount,
          statements: failures.statements.slice(0, 10).map((st) => ({
            id: st.id, seq: st.seq, kind: st.kind, table: st.table ?? null, sqlState: st.sqlState ?? null, message: maskText(ctx, st.message ?? ''),
            swallowed: st.swallowed, undone: st.undone, at: st.callers?.[0] ?? st.codeLocation ?? null,
          })),
          more: 'db_statement statementId for one in full (its call chain resolves to project files); db_statements failedOnly for all of them.',
        },
      } : {}),
      state: call.state,
      ...(call.source === 'internal' ? {} : { supplier: call.supplierName ?? undefined }),
      ...flagsOf(call),
      parentCallId: call.parentCallId ?? undefined,
      timing: call.timing ?? undefined,
      ...(call.interception?.applied?.length ? {
        interception: {
          applied: call.interception.applied.map((a) => ({ rule: a.ruleName ?? null, ruleId: a.ruleId ?? null, action: a.action, ...(a.detail ? { detail: a.detail } : {}) })),
          requestChanged: !!call.interception.originalRequest,
          responseChanged: !!call.interception.originalResponse,
          more: 'get_rule ruleId shows the rule; the ⚡ panel on the call in the UI shows the before/after of each changed half.',
        },
      } : {}),
      request: { headers: call.request?.headers ?? {}, body: bodyView(call.request?.body, call.request?.headers, input.bodyOffset, input.bodyLength) },
      response: { status: call.response?.status ?? null, headers: call.response?.headers ?? {}, body: bodyView(call.response?.body, call.response?.headers, input.bodyOffset, input.bodyLength) },
      ...(extras.children !== undefined ? { children: extras.children } : {}),
      comments: extras.comments,
      ...(extras.db !== undefined ? { db: extras.db } : {}),
      ...(ref.cycleId ? { cycleId: ref.cycleId } : {}),
      ...maskMeta(ctx),
    });
  }));

  server.registerTool('get_call_body', {
    description: 'Page through one part of a call (request/response headers or body) by character offset - for bodies too large for get_call.',
    inputSchema: {
      id: z.string().min(1),
      direction: z.enum(['inbound', 'outbound']).optional(),
      cycleId: z.string().optional(),
      part: Block,
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(256).max(15000).default(12000),
      pretty: z.boolean().default(true).describe('Bodies pretty-printed as the UI shows them (line numbers match add_comment). false = bytes as sent.'),
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const { ref, call: summary } = await resolveCall(client, input.id, input.direction, input.cycleId);
    const call = maskCall(ctx, await withParts(client, ref, summary, [input.part]));
    const block: CommentBlock = input.part;
    const value = block === 'request-headers' ? headerText(call.request?.headers)
      : block === 'response-headers' ? headerText(call.response?.headers)
      : block === 'request-body' ? call.request?.body ?? '' : call.response?.body ?? '';
    if (block.endsWith('-body')) {
      const headers = block === 'request-body' ? call.request?.headers : call.response?.headers;
      // Pretty-printed (JSON/XML) when `pretty`, exactly the text add_comment numbers lines in.
      const shown = input.pretty ? detectAndFormatBody(value).body : value;
      return ok({ id: call.id, part: block, pretty: input.pretty, ...bodyView(shown, headers, input.offset, input.length), ...maskMeta(ctx) });
    }
    return ok({ id: call.id, part: block, ...chunkText(value, input.offset, input.length), ...maskMeta(ctx) });
  }));

  server.registerTool('search_calls', {
    description: 'Search Alfred\'s live call log (no cycle needed): by project (e.g. odeysys), direction, supplier, text, status, failed, slow, time range. '
      + 'Returns short rows (id, direction, method, url, status, durationMs, time) newest first, or the chosen fields. Scans at most '
      + `${SCAN_CAP} recent calls per direction for the status/time/slow filters and says so when the cap is hit.`,
    inputSchema: {
      ...SearchSchema,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(25),
      fields: FieldsSchema,
      paths: PathsSchema,
      mask: MaskSchema,
    },
  }, (input) => run(async () => {
    const ctx = await maskContext(client, input.mask);
    const result = await searchCalls(client, input, input.offset + input.limit);
    const page = result.calls.slice(input.offset);
    const selective = !!(input.fields?.length || input.paths?.length);
    const parts = partsFor(input.fields, input.paths);
    const rows = await Promise.all(page.map(async (summary) => {
      const call = maskCall(ctx, parts.length ? await withParts(client, { id: summary.id, source: summary.source ?? 'external' }, summary, parts) : summary);
      if (!selective) return toRow(call);
      const sel = select(call, input.fields, input.paths, {}, 0, 2000);
      return { id: call.id, ...sel.values, ...(sel.missing.length ? { missing: sel.missing } : {}) };
    }));
    // A page of full rows can outgrow one reply; fewer rows are returned and nextOffset says so.
    const fitted = fitItems(rows, 400);
    const end = input.offset + fitted.items.length;
    return ok({
      calls: fitted.items, offset: input.offset, nextOffset: result.more || fitted.cut ? end : null,
      scanned: result.scanned, scanCapHit: result.scanCapHit, ...(result.softCapHit ? { softCheckCapHit: true } : {}), ...maskMeta(ctx),
    });
  }));
}

