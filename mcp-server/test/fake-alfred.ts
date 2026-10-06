import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import {
  emptyResultOf, softFailureOf,
  type AttentionMark, type CallDbSummary, type CallRecord, type CallStatementsPage, type CapturedStatement, type Comment, type CycleSpacer,
  type Redaction, type SessionCycle, type RowsPage, type RecordedQueryResult, type TriageEntry,
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
  rules: Record<string, unknown>[];
  interceptionEnabled: boolean;
  reliveCycles: Record<string, unknown>[];
  /** Run details by relive cycle id, newest first. */
  runs: Map<string, Record<string, unknown>[]>;
  services: { name: string; listenPort: number | null; upstreamPort: number | null; enabled: boolean }[];
  captureProjects: { project: string; enabled: boolean; inboundLogging: boolean; attached: boolean; agent: null }[];
  /** Calls triage has no saved mark for (recorded before triage existed, or past its row cap). */
  unmarked: Set<string>;
  /** /call-logs answers by call id (specs/008-logs-call-link); a missing call is 404. */
  callLogs: Record<string, { setup: string; matchedBy: string | null; thread: string | null; lines: Record<string, unknown>[] }>;
}

export function emptyState(): FakeState {
  return {
    calls: [], cycles: [], cycleEntries: new Map(), spacers: new Map(), comments: [], redactions: [], callLogs: {},
    variables: { variables: {}, fallbacks: {}, secrets: [] }, dbSummaries: {}, statements: {}, rows: {},
    query: { columns: [], rows: [], total: 0 }, trace: [],
    rules: [], interceptionEnabled: true, reliveCycles: [], runs: new Map(),
    services: [
      { name: 'odeysys', listenPort: 8080, upstreamPort: 9001, enabled: true },
      { name: 'core-service', listenPort: 8083, upstreamPort: 9003, enabled: false },
      { name: 'unknown', listenPort: null, upstreamPort: null, enabled: true },
    ],
    captureProjects: [
      { project: 'odeysys', enabled: false, inboundLogging: true, attached: true, agent: null },
      { project: 'core-service', enabled: false, inboundLogging: false, attached: false, agent: null },
    ],
    unmarked: new Set(),
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
    interception: record.interception ?? null,
  };
}

function detailOf(record: CallRecord, part: string | null): Record<string, unknown> {
  const req = record.request ?? {};
  const res = record.response ?? { status: 0 };
  // As the real backend answers a part: the other half of that side, and the other side, as explicit nulls.
  switch (part) {
    case 'request-headers': return { request: { headers: req.headers ?? null, body: null }, response: null };
    case 'request-body': return { request: { headers: null, body: req.body ?? null }, response: null };
    case 'response-headers': return { request: null, response: { status: res.status, headers: res.headers ?? null, body: null } };
    case 'response-body': return { request: null, response: { status: res.status, headers: null, body: res.body ?? null } };
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

const STALE_MS = 5 * 60_000;

/** backend-triage's Priority, for the fake: the same groups from the same facts. */
function needs(m: AttentionMark, minStatus: number, now: number): boolean {
  return !!m.error || (m.status ?? -1) >= minStatus || (m.state === 'IN_PROGRESS' && now - m.startedAt > STALE_MS);
}

function priorityOf(m: AttentionMark, failingChildren: number, minStatus: number, now: number): TriageEntry['priority'] {
  if (needs(m, minStatus, now)) return failingChildren ? 1 : m.failedStatements ? 2 : 3;
  if (failingChildren || m.failedStatements) return 4;
  return m.softFailure || m.emptyKeys.length ? 5 : 6;
}

export class FakeAlfred {
  readonly state: FakeState = emptyState();
  readonly log: LoggedRequest[] = [];
  private server?: Server;
  private nextId = 1;
  /** Open WebSocket connections by path - Alfred's change signals, served by a minimal RFC 6455 server (text frames only). */
  private readonly sockets: { path: string; socket: Duplex }[] = [];

  get url(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets.splice(0)) s.socket.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Paths with an open WebSocket right now. */
  openSockets(): string[] {
    return this.sockets.map((s) => s.path);
  }

  /** Sends one text frame to every socket open on `path`, as the backend does on a change. */
  broadcast(path: string, text: string): void {
    const payload = Buffer.from(text, 'utf8');
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
      : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return h; })();
    for (const s of this.sockets.filter((x) => x.path === path)) s.socket.write(Buffer.concat([header, payload]));
  }

  private upgrade(req: IncomingMessage, socket: Duplex): void {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const entry = { path: new URL(req.url!, 'http://x').pathname, socket };
    this.sockets.push(entry);
    const drop = () => { const i = this.sockets.indexOf(entry); if (i >= 0) this.sockets.splice(i, 1); };
    socket.on('data', (chunk: Buffer) => {
      // A client close frame (opcode 8): answer with one and end - the clients here never send data.
      if ((chunk[0] & 0x0f) === 8) { drop(); socket.end(Buffer.from([0x88, 0])); }
    });
    socket.on('close', drop);
    socket.on('error', drop);
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

  /** Every call the fake knows - live first, then cycle copies - by id. */
  private records(): Map<string, { source: 'internal' | 'external'; record: CallRecord }> {
    const out = new Map<string, { source: 'internal' | 'external'; record: CallRecord }>();
    for (const c of this.state.calls) out.set(c.record.id, c);
    for (const list of this.state.cycleEntries.values()) for (const e of list) if (!out.has(e.record.id)) out.set(e.record.id, e);
    return out;
  }

  /** The mark backend-triage would have saved for this call. */
  private markOf(source: 'internal' | 'external', r: CallRecord): AttentionMark {
    const statements = this.state.statements[r.id] ?? [];
    return {
      callId: r.id, direction: source === 'internal' ? 'INBOUND' : 'OUTBOUND', project: source === 'internal' ? r.service_name ?? null : null,
      parentCallId: source === 'external' ? r.parentCallId ?? null : null, method: r.method, url: r.url,
      status: r.response?.status ?? null, error: r.error ?? null, startedAt: Date.parse(r.timestamp), durationMs: r.duration_ms ?? null,
      state: r.state ?? 'COMPLETED', softFailure: softFailureOf(r), emptyKeys: [...(emptyResultOf(r)?.emptyKeys ?? [])], failingChildren: 0,
      failedStatements: this.state.dbSummaries[r.id]?.failedCount ?? 0,
      swallowedStatements: statements.filter((st) => st.outcome.kind === 'FAILED' && st.outcome.swallowed).length,
    };
  }

  private entryOf(id: string, minStatus: number): TriageEntry | null {
    const all = this.records();
    const found = all.get(id);
    if (!found || this.state.unmarked.has(id)) return null;
    const now = Date.now();
    const mark = this.markOf(found.source, found.record);
    const failing = [...all.values()].filter((c) => c.source === 'external' && c.record.parentCallId === id && !this.state.unmarked.has(c.record.id))
      .map((c) => this.markOf(c.source, c.record)).filter((c) => needs(c, minStatus, now) || !!c.softFailure)
      .sort((a, b) => a.startedAt - b.startedAt);
    return {
      ...mark, failingChildren: failing.length, priority: priorityOf(mark, failing.length, minStatus, now),
      needsAttention: needs(mark, minStatus, now), failingSupplierCalls: failing,
    };
  }

  /** Live calls with no parent in the window - what /triage/live and /triage/counts look at. */
  private liveWindow(q: URLSearchParams, minStatus: number): TriageEntry[] {
    const since = q.get('since') ? Date.parse(q.get('since')!) : Date.now() - 3_600_000;
    const to = q.get('to') ? Date.parse(q.get('to')!) : Number.MAX_SAFE_INTEGER;
    const project = q.get('project');
    return this.state.calls
      .filter((c) => c.source === 'internal' || !c.record.parentCallId)
      .filter((c) => !project || (c.source === 'internal' && (c.record.service_name ?? null) === project))
      .map((c) => this.entryOf(c.record.id, minStatus)).filter((e): e is TriageEntry => !!e)
      .filter((e) => e.startedAt >= since && e.startedAt <= to)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private route(method: string, p: string[], q: URLSearchParams, body: any): [number, unknown?] {
    const s = this.state;
    // ---- triage (the saved marks of backend-triage)
    if (p[0] === 'triage') {
      const minStatus = Math.max(300, Math.min(600, Number(q.get('minStatus') ?? 300)));
      if (p[1] === 'calls') {
        const ids = [...new Set((q.get('callIds') ?? '').split(',').filter(Boolean))];
        if (ids.length > 500) return [400, { error: `At most 500 call ids per request, got ${ids.length}` }];
        return [200, Object.fromEntries(ids.map((id) => [id, this.entryOf(id, minStatus)]).filter(([, e]) => e))];
      }
      if (p[1] === 'live') {
        const max = Number(q.get('maxPriority') ?? 5);
        return [200, this.liveWindow(q, minStatus).filter((e) => e.priority <= max).slice(0, Number(q.get('limit') ?? 200))];
      }
      if (p[1] === 'counts') {
        const counts: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        for (const e of this.liveWindow(q, 300)) counts[e.priority]++;
        return [200, counts];
      }
    }
    const live = (seg: string) => (seg === 'internal-calls' ? 'internal' : 'external');
    // ---- projects and their switches
    if (p[0] === 'internal-calls' && p[1] === 'feature-enabled') return [200, { enabled: true }];
    if (p[0] === 'internal-calls' && p[1] === 'services' && p.length === 2) return [200, s.services];
    if (p[0] === 'internal-calls' && p[1] === 'services' && p[3] === 'logging-enabled' && method === 'POST') {
      const svc = s.services.find((x) => x.name === p[2]);
      if (!svc) return [404];
      svc.enabled = !!body.enabled;
      const cap = s.captureProjects.find((c) => c.project === p[2]);
      if (cap) cap.inboundLogging = svc.enabled;
      return [200, s.services];
    }
    if (p[0] === 'db-capture' && p[1] === 'projects' && p.length === 2) return [200, s.captureProjects];
    if (p[0] === 'db-capture' && p[1] === 'projects' && p[3] === 'enabled' && method === 'PUT') {
      const cap = s.captureProjects.find((c) => c.project === p[2]);
      if (!cap) return [400, { error: 'unknown project' }];
      if (body.enabled && !cap.inboundLogging) return [409, { error: 'inbound logging is off' }];
      cap.enabled = !!body.enabled;
      return [200, s.captureProjects];
    }
    // ---- interception rules and Relive (read-only here)
    if (p[0] === 'interception' && p[1] === 'enabled') return [200, { enabled: s.interceptionEnabled }];
    if (p[0] === 'interception' && p[1] === 'rules' && p.length === 2) return [200, s.rules];
    if (p[0] === 'interception' && p[1] === 'rules' && p.length === 3) {
      const rule = s.rules.find((r) => r['id'] === p[2]);
      return rule ? [200, rule] : [404];
    }
    if (p[0] === 'relive-cycles' && p.length === 1) return [200, s.reliveCycles];
    if (p[0] === 'relive-cycles' && p[2] === 'runs' && p.length === 3) {
      const limit = Number(q.get('limit') ?? 50);
      return [200, (s.runs.get(p[1]) ?? []).slice(0, limit).map(({ definition: _d, stepResults: _r, ...row }) => row)];
    }
    if (p[0] === 'relive-cycles' && p[2] === 'runs' && p.length === 4) {
      const run = (s.runs.get(p[1]) ?? []).find((r) => r['id'] === p[3]);
      return run ? [200, run] : [404];
    }
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
          const services = (q.get('serviceNames') ?? '').split(',').filter(Boolean);
          const list = sortCalls(entries.filter((e) => e.source === source), q.get('sort'))
            .filter((e) => !q.get('requestId') || e.record.id.includes(q.get('requestId')!))
            .filter((e) => matchesSearch(e.record, q.get('search') ?? ''))
            .filter((e) => !services.length || services.includes(e.record.service_name ?? 'unknown'))
            .filter((e) => !q.get('supplier') || new URL(e.record.url).hostname === q.get('supplier'));
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
      if (method === 'GET' && p[1] === 'counts') {
        const ids = new Set((q.get('callIds') ?? '').split(',').filter(Boolean));
        if (ids.size > 500) return [400];
        const out: Record<string, { total: number; byBlock: Record<string, number> }> = {};
        for (const c of s.comments.filter((x) => ids.has(x.callId))) {
          const entry = (out[c.callId] ??= { total: 0, byBlock: {} });
          entry.total++;
          entry.byBlock[c.block] = (entry.byBlock[c.block] ?? 0) + 1;
        }
        return [200, out];
      }
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
    if (p[0] === 'call-logs' && p.length === 2) {
      const found = s.callLogs[p[1]];
      if (!found) return [404];
      const offset = Number((q.get('after') ?? 'o:0').slice(2));
      const limit = Number(q.get('limit') ?? 200);
      const page = found.lines.slice(offset, offset + limit);
      return [200, { callId: p[1], setup: found.setup, matchedBy: found.matchedBy, thread: found.thread, clockSkewMs: 200, lines: page,
        next: offset + limit < found.lines.length ? `o:${offset + limit}` : null }];
    }
    if (p[0] === 'settings' && p[1] === 'variables') return [200, s.variables];
    // ---- database capture
    if (p[0] === 'db-capture') {
      if (p[1] === 'summaries') {
        const ids = (q.get('callIds') ?? '').split(',');
        return [200, Object.fromEntries(ids.filter((id) => s.dbSummaries[id]).map((id) => [id, s.dbSummaries[id]]))];
      }
      if (p[1] === 'failures') {
        const ids = [...new Set((q.get('callIds') ?? '').split(',').filter(Boolean))];
        if (ids.length > 500) return [400, { error: `At most 500 call ids per request, got ${ids.length}` }];
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          const failed = (s.statements[id] ?? []).filter((st) => st.outcome.kind === 'FAILED').sort((a, b) => a.seq - b.seq);
          if (!failed.length) continue;
          out[id] = {
            callId: id, failedCount: failed.length, swallowedCount: failed.filter((st) => st.outcome.swallowed).length,
            statements: failed.slice(0, 50).map((st) => ({
              id: st.id, seq: st.seq, kind: st.kind, table: st.table, sql: st.sql, sqlState: st.outcome.sqlState ?? null,
              vendorCode: st.outcome.vendorCode ?? null, message: st.outcome.message ?? null, swallowed: !!st.outcome.swallowed, undone: st.undone,
              durationMicros: st.durationMicros, codeLocation: st.codeLocation, callers: st.callers ?? null,
            })),
          };
        }
        return [200, out];
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
