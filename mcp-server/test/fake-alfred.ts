import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CallDbSummary, CallRecord, CallStatementsPage, CapturedStatement, Comment, CycleSpacer, Redaction, SessionCycle, RowsPage, RecordedQueryResult,
} from '../src/frontend.ts';

/**
 * An in-memory Alfred speaking the same HTTP shapes as the real backend (summaries without bodies,
 * snake_case wire fields, captured-call wrappers with their own ids, 404s for unknown ids), so the
 * tools are tested against what they really receive. Every request is logged for assertions.
 */

export interface StoredCall {
  readonly source: 'internal' | 'external';
  readonly record: CallRecord;
}

export interface FakeState {
  calls: StoredCall[];
  cycles: SessionCycle[];
  cycleEntries: Map<string, { capturedId: string; capturedAt: string; source: 'internal' | 'external'; record: CallRecord }[]>;
  spacers: Map<string, CycleSpacer[]>;
  comments: Comment[];
  redactions: Redaction[];
  variables: { variables: Record<string, string>; fallbacks: Record<string, string>; secrets: string[] };
  dbSummaries: Record<string, CallDbSummary>;
  statements: Record<string, CapturedStatement[]>;
  rows: Record<number, RowsPage>;
  query: RecordedQueryResult;
  trace: { seq: number; where: string; index: number; column?: string }[];
}

export function emptyState(): FakeState {
  return {
    calls: [], cycles: [], cycleEntries: new Map(), spacers: new Map(), comments: [], redactions: [],
    variables: { variables: {}, fallbacks: {}, secrets: [] }, dbSummaries: {}, statements: {}, rows: {},
    query: { columns: [], rows: [], total: 0 }, trace: [],
  };
}

export interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: any;
}

/** The wire summary of a call: what GET /calls and /summary return - no headers, no bodies. */
export function summaryOf(record: CallRecord): Record<string, unknown> {
  return {
    id: record.id, url: record.url, method: record.method, timestamp: record.timestamp, status: record.response?.status ?? null,
    error: record.error ?? null, supplierName: record.supplierName ?? null, state: record.state ?? 'COMPLETED',
    original_url: record.original_url, duration_ms: record.duration_ms, session_id: null, operation_id: null,
    service_name: record.service_name ?? null, timing: record.timing ?? null, parent_call_id: record.parentCallId ?? null, parent_seq: record.parentSeq ?? null,
  };
}

function detailOf(record: CallRecord, part: string | null): Record<string, unknown> {
  const req = record.request ?? {};
  const res = record.response ?? { status: 0 };
  switch (part) {
    case 'request-headers': return { request: { headers: req.headers } };
    case 'request-body': return { request: { body: req.body } };
    case 'response-headers': return { response: { status: res.status, headers: res.headers } };
    case 'response-body': return { response: { status: res.status, body: res.body } };
    default: return { request: req, response: res, relive: null };
  }
}

function timeOf(r: CallRecord): number {
  return new Date(r.timestamp).getTime();
}

function sortCalls<T extends { record: CallRecord }>(list: T[], sort: string | null): T[] {
  const copy = [...list];
  switch (sort) {
    case 'oldest': return copy;
    case 'oldest-call': return copy.sort((a, b) => timeOf(a.record) - timeOf(b.record));
    case 'newest-call': return copy.sort((a, b) => timeOf(b.record) - timeOf(a.record));
    case 'slowest': return copy.sort((a, b) => (b.record.duration_ms ?? -1) - (a.record.duration_ms ?? -1));
    default: return copy.reverse();
  }
}

function matchesSearch(r: CallRecord, q: string): boolean {
  if (!q) return true;
  const hay = [r.method, r.url, r.original_url, r.error, String(r.response?.status ?? ''), JSON.stringify(r.request?.headers ?? {}),
    r.request?.body, JSON.stringify(r.response?.headers ?? {}), r.response?.body].join('\n').toLowerCase();
  return hay.includes(q.toLowerCase());
}

export class FakeAlfred {
  readonly state: FakeState = emptyState();
  readonly log: LoggedRequest[] = [];
  private server?: Server;
  private nextId = 1;

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  requests(method: string, pathPart: string): LoggedRequest[] {
    return this.log.filter((r) => r.method === method && r.path.includes(pathPart));
  }

  addCall(source: 'internal' | 'external', record: CallRecord): void {
    this.state.calls.push({ source, record });
  }

  addCycle(cycle: Partial<SessionCycle> & { id: string; name: string }, entries: { source: 'internal' | 'external'; record: CallRecord }[] = []): void {
    this.state.cycles.push({ createdAt: '2026-10-05T00:00:00Z', assignedTo: null, status: 'PAUSED', reliveRunId: null, ...cycle });
    this.state.cycleEntries.set(cycle.id, entries.map((e) => ({ ...e, capturedId: `cap-${e.record.id}`, capturedAt: e.record.timestamp })));
    this.state.spacers.set(cycle.id, []);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://x');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    this.log.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
    const send = (status: number, value?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    try {
      const result = this.route(req.method!, url.pathname.split('/').filter(Boolean).map(decodeURIComponent), url.searchParams, body);
      send(result[0], result[1]);
    } catch (error) {
      send(500, { error: String(error) });
    }
  }

  private route(method: string, p: string[], q: URLSearchParams, body: any): [number, unknown?] {
    const s = this.state;
    const live = (seg: string) => (seg === 'internal-calls' ? 'internal' : 'external');
    // ---- live calls
    if ((p[0] === 'calls' || p[0] === 'internal-calls') && p.length === 1 && method === 'GET') {
      const source = live(p[0]);
      const services = (q.get('serviceNames') ?? '').split(',').filter(Boolean);
      const list = sortCalls(s.calls.filter((c) => c.source === source), q.get('sort'))
        .filter((c) => matchesSearch(c.record, q.get('search') ?? ''))
        .filter((c) => !services.length || services.includes(c.record.service_name ?? 'unknown'))
        .filter((c) => !q.get('supplier') || new URL(c.record.url).hostname === q.get('supplier'));
      const offset = Number(q.get('offset') ?? 0);
      const limit = Math.min(Number(q.get('limit') ?? 10), 200);
      return [200, { calls: list.slice(offset, offset + limit).map((c) => summaryOf(c.record)), total: list.length }];
    }
    if ((p[0] === 'calls' || p[0] === 'internal-calls') && p.length === 3) {
      const found = s.calls.find((c) => c.source === live(p[0]) && c.record.id === p[1]);
      if (p[2] === 'children' && p[0] === 'calls') {
        return [200, s.calls.filter((c) => c.source === 'external' && c.record.parentCallId === p[1]).map((c) => summaryOf(c.record))];
      }
      if (!found) return [404];
      if (p[2] === 'summary') return [200, summaryOf(found.record)];
      if (p[2] === 'detail') return [200, detailOf(found.record, q.get('part'))];
    }
    if (p[0] === 'calls' && p[1] === 'export-metadata' && method === 'POST') return [200, { supplierName: null, credentialsUsed: null, apiKey: null, url: null }];
    if (p[0] === 'call-overlaps') return [200, []];
    // ---- session cycles
    if (p[0] === 'session-cycles') {
      if (p.length === 1 && method === 'GET') return [200, s.cycles];
      if (p.length === 1 && method === 'POST') {
        const cycle: SessionCycle = { id: `cy-${this.nextId++}`, name: body.name, createdAt: new Date().toISOString(), assignedTo: null, status: 'RECORDING', reliveRunId: null };
        s.cycles.push(cycle);
        s.cycleEntries.set(cycle.id, []);
        s.spacers.set(cycle.id, []);
        return [201, cycle];
      }
      const index = s.cycles.findIndex((c) => c.id === p[1]);
      if (index < 0) return [404];
      const cycle = s.cycles[index];
      const entries = s.cycleEntries.get(cycle.id)!;
      if (p.length === 2 && method === 'GET') return [200, cycle];
      if (p.length === 2 && method === 'PATCH') return [200, (s.cycles[index] = { ...cycle, name: body.name ?? cycle.name })];
      if (p.length === 2 && method === 'DELETE') {
        if (cycle.status === 'RECORDING') return [409];
        s.cycles.splice(index, 1);
        return [204];
      }
      if (p[2] === 'record' || p[2] === 'pause') {
        const status = p[2] === 'record' ? 'RECORDING' : 'PAUSED';
        return [200, cycle.reliveRunId ? cycle : (s.cycles[index] = { ...cycle, status })];
      }
      if (p[2] === 'spacers') {
        const list = s.spacers.get(cycle.id)!;
        if (p.length === 3 && method === 'GET') return [200, list];
        if (p.length === 3 && method === 'POST') {
          const spacer = { id: `sp-${this.nextId++}`, cycleId: cycle.id, label: body.label, afterCallId: body.afterCallId, anchorTimestamp: body.anchorTimestamp } as CycleSpacer;
          list.push(spacer);
          return [201, spacer];
        }
        const i = list.findIndex((x) => x.id === p[3]);
        if (i < 0) return [404];
        if (method === 'DELETE') { list.splice(i, 1); return [204]; }
        if (p[4] === 'move') return [200, (list[i] = { ...list[i], afterCallId: body.afterCallId, anchorTimestamp: body.anchorTimestamp })];
        return [200, (list[i] = { ...list[i], label: body.label })];
      }
      if (p[2] === 'call-overlaps') return [200, []];
      if (p[2] === 'calls' || p[2] === 'internal-calls') {
        const source = live(p[2]);
        if (p.length === 3 && method === 'GET') {
          const list = sortCalls(entries.filter((e) => e.source === source), q.get('sort'))
            .filter((e) => !q.get('requestId') || e.record.id.includes(q.get('requestId')!));
          const offset = Number(q.get('offset') ?? 0);
          const limit = Number(q.get('limit') ?? 10);
          return [200, { calls: list.slice(offset, offset + limit).map((e) => ({ id: e.capturedId, capturedAt: e.capturedAt, call: summaryOf(e.record) })), total: list.length }];
        }
        if (p[3] === 'copy') {
          let added = 0;
          let skipped = 0;
          for (const record of body.calls as CallRecord[]) {
            if (entries.some((e) => e.source === source && e.record.id === record.id)) { skipped++; continue; }
            entries.push({ capturedId: `cap-${record.id}`, capturedAt: new Date().toISOString(), source, record });
            added++;
          }
          return [200, { added, skipped }];
        }
        if (p[3] === 'remove') {
          let removed = 0;
          for (const id of body.callIds as string[]) {
            const i = entries.findIndex((e) => e.source === source && e.capturedId === id);
            if (i >= 0) { entries.splice(i, 1); removed++; }
          }
          return [200, { removed, notFound: body.callIds.length - removed }];
        }
        if (p[4] === 'detail') {
          const entry = entries.find((e) => e.source === source && e.record.id === p[3]);
          return entry ? [200, detailOf(entry.record, q.get('part'))] : [404];
        }
      }
    }
    // ---- comments
    if (p[0] === 'comments') {
      if (method === 'GET') return [200, s.comments.filter((c) => c.callId === q.get('callId'))];
      if (method === 'POST') {
        const comment: Comment = { id: `cm-${this.nextId++}`, createdAt: new Date().toISOString(), ...body };
        s.comments.push(comment);
        return [200, comment];
      }
      if (method === 'DELETE') {
        const i = s.comments.findIndex((c) => c.id === p[1]);
        if (i < 0) return [404];
        s.comments.splice(i, 1);
        return [204];
      }
    }
    if (p[0] === 'redactions') return [200, s.redactions];
    if (p[0] === 'settings' && p[1] === 'variables') return [200, s.variables];
    // ---- database capture
    if (p[0] === 'db-capture') {
      if (p[1] === 'summaries') {
        const ids = (q.get('callIds') ?? '').split(',');
        return [200, Object.fromEntries(ids.filter((id) => s.dbSummaries[id]).map((id) => [id, s.dbSummaries[id]]))];
      }
      if (p[1] === 'calls' && p[3] === 'statements' && p.length === 4) {
        const all = s.statements[p[2]] ?? [];
        const after = Number(q.get('afterSeq') ?? 0);
        const limit = Number(q.get('limit') ?? 500);
        const page = all.filter((st) => st.seq > after).slice(0, limit);
        const result: CallStatementsPage = { statements: page, transactions: [], supplierMarkers: [], hasMore: all.filter((st) => st.seq > after).length > limit };
        return [200, result];
      }
      if (p[1] === 'calls' && p[3] === 'statements' && p[4] === 'query') return [200, s.query];
      if (p[1] === 'calls' && p[3] === 'trace') return [200, { hits: s.trace }];
      if (p[1] === 'calls' && p[3] === 'export') {
        const statements = s.statements[p[2]];
        if (!statements) return [404];
        return [200, { summary: s.dbSummaries[p[2]], transactions: [], supplierMarkers: [], statements: statements.map((st) => ({ ...st, rows: s.rows[st.id]?.rows ?? null })) }];
      }
      if (p[1] === 'statements') {
        const st = Object.values(s.statements).flat().find((x) => x.id === Number(p[2]));
        if (!st) return [404];
        if (p[3] === 'rows') return [200, s.rows[st.id] ?? { columns: [], rows: [], total: 0 }];
        return [200, st];
      }
    }
    return [404, { error: `fake: no route for ${method} /${p.join('/')}` }];
  }
}
