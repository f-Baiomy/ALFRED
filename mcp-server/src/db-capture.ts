import { seg, type AlfredClient } from './alfred-client.ts';
import { chunks, MAX_IDS } from './triage.ts';
import {
  analyzeCapture, suppliersOf, toCallRecord,
  type CallDbAnalysis, type CallDbCapture, type CallDbSummary, type CallRecord, type CallStatementsPage, type CallSummaryDto,
  type CapturedStatement, type DbFindingSummary,
} from './frontend.ts';
import { notFound } from './reply.ts';

const STATEMENT_PAGE = 500;

export async function dbSummaries(client: AlfredClient, callIds: readonly string[]): Promise<Record<string, CallDbSummary>> {
  if (callIds.length === 0) return {};
  // ids travel in the URL: at most MAX_IDS per request, or the gateway answers 414
  const parts = await Promise.all(chunks([...callIds], MAX_IDS).map((chunk) =>
    client.get<Record<string, CallDbSummary>>('/db-capture/summaries', { query: { callIds: chunk.join(',') } })));
  return Object.assign({}, ...parts);
}

/**
 * A call's whole capture, assembled the way the database window loads it: every statements page
 * (statements, transactions, supplier markers) plus the summary that carries the backend's flags.
 * No summary means the call was not captured.
 */
export async function loadCapture(client: AlfredClient, callId: string): Promise<CallDbCapture & { readonly statements: readonly CapturedStatement[] }> {
  const summaries = await dbSummaries(client, [callId]);
  const summary = summaries[callId];
  if (!summary) throw notFound(`Call ${callId} has no database capture.`);
  const statements: CapturedStatement[] = [];
  const transactions: CallStatementsPage['transactions'][number][] = [];
  const markers: CallStatementsPage['supplierMarkers'][number][] = [];
  for (let afterSeq = 0; ;) {
    const page = await client.get<CallStatementsPage>(`/db-capture/calls/${seg(callId)}/statements`, { query: { afterSeq, limit: STATEMENT_PAGE } });
    statements.push(...page.statements);
    for (const tx of page.transactions) if (!transactions.some((t) => t.txId === tx.txId)) transactions.push(tx);
    for (const m of page.supplierMarkers) if (!markers.some((x) => x.seq === m.seq)) markers.push(m);
    if (!page.hasMore || page.statements.length === 0) break;
    afterSeq = Math.max(...page.statements.map((s) => s.seq));
  }
  return { summary, statements, transactions, supplierMarkers: markers };
}

/** The supplier calls an inbound call made (the db-agent's parent link) - their time counts in the analysis. */
export async function childrenOf(client: AlfredClient, callId: string): Promise<CallRecord[]> {
  const list = await client.get<CallSummaryDto[]>(`/calls/${seg(callId)}/children`).catch(() => [] as CallSummaryDto[]);
  return list.map((dto) => toCallRecord(dto, 'external'));
}

/**
 * The window's summary line, time breakdown, query totals and findings - computed by the
 * frontend's own analyzeCapture, never by code of this server's (SC-003).
 */
export function analysisOf(call: CallRecord, capture: CallDbCapture, children: readonly CallRecord[]): CallDbAnalysis {
  return analyzeCapture(call, capture, suppliersOf(call.id, [...children]));
}

export function nonNoteFindings(analysis: CallDbAnalysis): readonly DbFindingSummary[] {
  return (analysis.findings ?? []).filter((f) => f.severity !== 'note');
}
