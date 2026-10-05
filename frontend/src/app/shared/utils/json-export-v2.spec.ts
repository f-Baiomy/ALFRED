import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture, ExportedDbStatement, StatementOrigin, TypedValue } from '../../core/models/db-capture.model';
import { Comment } from '../../core/models/comment.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { stmt } from './db-capture.fixtures.spec-helper';
import { exportBlob, readExportFile } from './export-file-io';
import { parseImportedCalls } from './import-parser';
import { buildJsonExportV2, utf8Length } from './json-export-v2';

/**
 * Version 2 of the .json export: smaller, line-structured, indexed - and it must lose nothing. The yardstick is
 * version 1 (buildBulkExportPayload): importing either file must give the same calls.
 */
const FORM = { supplierName: 'NDC', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging' as const, description: 'flight search' };
const v = (type: string, value: string | null): TypedValue => ({ type, value });
const HQL: StatementOrigin = { id: 'a:q1', kind: 'HQL', text: 'from Org o where o.id = :id', method: 'list', params: [{ name: ':id', value: '948' }] };
const OFFERS = JSON.stringify({ offers: Array.from({ length: 40 }, (_, i) => ({ id: i, price: 100 + i, carrier: 'EK' })) });
const PRETTY = JSON.stringify({ error: 'x'.repeat(300) }, null, 2); // JSON, but not compact: must stay byte-for-byte text

function makeCapture(): CallDbCapture {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => [v('BIGINT', String(i)), v('VARCHAR', i === 3 ? null : `row ${i}`)]);
  const select: ExportedDbStatement = {
    ...stmt(1, 'SELECT', 'SELECT id, name FROM t WHERE g = ?', { callId: 'in-1', params: [[v('BIGINT', '948')]], origin: HQL, connectionId: 'c1', dataSource: 'Oracle 19c', thread: 'task-1' }),
    outcome: { kind: 'ROWS', rowsRead: 50, columns: [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }] },
    storedRows: 50,
    // odd cells: another type than its column, extra fields, a null cell
    rows: [...rows(50), [v('VARCHAR', '7'), { type: 'CLOB', value: 'abc', truncatedAt: 3 }], [null as unknown as TypedValue, v('VARCHAR', 'z')]],
  };
  const second: ExportedDbStatement = {
    ...stmt(2, 'SELECT', 'SELECT 1 FROM t2', { callId: 'in-1', origin: HQL, connectionId: 'c2', dataSource: 'Oracle 19c', thread: 'task-1' }),
  };
  const update: ExportedDbStatement = {
    ...stmt(3, 'UPDATE', 'UPDATE t SET name = ? WHERE id = ?', {
      callId: 'in-1', params: [[v('VARCHAR', 'n'), v('BIGINT', '1')]], dataSource: 'Oracle 19c', thread: 'task-1', connectionId: 'c1',
      origin: { ...HQL, params: [{ name: ':id', value: '***REDACTED***' }] }, // same id, different content: kept whole
      beforeImage: { source: 'AGENT_READ', rowCount: 1, columns: [{ name: 'name', type: 'VARCHAR' }] },
    }),
    outcome: { kind: 'UPDATED', affected: 1 },
    beforeImageRows: [[v('VARCHAR', 'old')]],
  };
  return {
    summary: {
      callId: 'in-1', statementCount: 3, writeCount: 1, deleteCount: 0, failedCount: 0, transactionCount: 1, rolledBackCount: 0, dbMicros: 3000,
      flags: [{ type: 'SLOW', severity: 'WARN', seqs: [1], detail: { ms: '61', table: 't' } }],
    } as never,
    transactions: [{ callId: 'in-1', txId: 'tx-1', firstSeq: 1, lastSeq: 3, outcome: 'COMMITTED', heldMicros: 9000, statementCount: 3, writeCount: 1 }],
    supplierMarkers: [{ seq: 4, method: 'POST', url: 'https://ndc.example/api/FlightSearch/Search' }],
    statements: [select, second, update],
  };
}

/** One instance: the fixture helper numbers statements, so a second build would differ in ids alone. */
const CAPTURE = makeCapture();
const capture = () => CAPTURE;

function calls(): CallRecord[] {
  return [
    {
      id: 'in-1', original_url: 'http://localhost:9001/search', url: 'http://host.docker.internal:8080/search', method: 'POST',
      request: { headers: { 'Content-Type': 'application/json' }, body: '{"from":"DXB","to":"LHR"}' }, timestamp: '2026-10-05T01:00:00.000Z',
      duration_ms: 21000, response: { status: 200, headers: { 'content-type': 'application/json' }, body: OFFERS }, state: 'COMPLETED',
      source: 'internal', service_name: 'odeysys', dbCapture: capture(),
    },
    {
      id: 'out-1', original_url: 'https://ndc.example/api/FlightSearch/Search', url: 'https://ndc.example/api/FlightSearch/Search', method: 'POST',
      request: { headers: {}, body: '{"q":1}' }, timestamp: '2026-10-05T01:00:05.000Z', duration_ms: 4100,
      response: { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: OFFERS }, // the same body again
      state: 'COMPLETED', source: 'external', parentCallId: 'in-1', parentSeq: 4,
      interception: { applied: [{ ruleId: 'r1', ruleName: 'slow it', action: 'DELAY' }] } as never,
    },
    {
      id: 'out-2', original_url: 'https://ndc2.example/x', url: 'https://ndc2.example/x', method: 'POST', request: { headers: {}, body: '' },
      timestamp: '2026-10-05T01:00:06.000Z', duration_ms: 50, error: 'Client disconnected.', state: 'ERROR', source: 'external',
      response: { status: 502, headers: {}, body: PRETTY },
    },
    {
      id: 'ws-1', original_url: 'wss://live.example/s', url: 'wss://live.example/s', method: 'GET', timestamp: '2026-10-05T01:00:07.000Z',
      duration_ms: 10, response: { status: 101, headers: {} }, state: 'COMPLETED', source: 'external',
      wsMessages: [{ id: 'm1', direction: 'SERVER', text: 'héllo – ünïcode ✓', timestamp: '2026-10-05T01:00:07.100Z' } as never],
    },
    {
      id: 'in-2', original_url: 'http://localhost:9001/slow', url: 'http://host.docker.internal:8080/slow', method: 'GET',
      timestamp: '2026-10-05T01:00:08.000Z', state: 'IN_PROGRESS', source: 'internal', service_name: 'odeysys', request: { headers: {} },
    } as CallRecord,
  ];
}

const COMMENTS = new Map<string, readonly Comment[]>([
  ['in-1', [{ id: 'k1', callId: 'in-1', block: 'response-body', lineIndex: 0, lineText: '{', comment: 'why 21 s?', createdAt: '' } as Comment]],
]);

function build(list = calls()): string[] {
  return buildJsonExportV2({ calls: list, form: FORM, commentsByCallId: COMMENTS, exportedAt: '2026-10-05T02:00:00Z', redactedValueCount: 2 });
}

describe('json export version 2', () => {
  it('imports to exactly what version 1 imports to - and keeps the parent link version 1 never wrote', () => {
    const v1 = parseImportedCalls(JSON.parse(JSON.stringify(buildBulkExportPayload(calls(), FORM, COMMENTS, '2026-10-05T02:00:00Z', [], 'all', 2))));
    const v2 = parseImportedCalls(JSON.parse(build().join('\n')));
    const without = (cs: readonly CallRecord[]) => cs.map(({ parentCallId: _p, parentSeq: _s, supplierName: _n, ...c }) => c);
    expect(without(v2.calls)).toEqual(without(v1.calls));
    expect(v2.redactedValueCount).toBe(2);
    const out = v2.calls.find((c) => c.id === 'out-1')!;
    expect([out.parentCallId, out.parentSeq]).toEqual(['in-1', 4]);
    // the database capture comes back cell for cell - odd cells, origins, hoisted values and all
    const { layout: _layout, ...original } = capture();
    expect(v2.calls.find((c) => c.id === 'in-1')!.dbCapture).toEqual(original);
  });

  it('is one valid JSON document whose every record is one line', () => {
    const lines = build();
    const file = JSON.parse(lines.join('\n'));
    expect(file.alfredExport).toBe(2);
    expect(Object.keys(file).slice(0, 4)).toEqual(['alfredExport', 'format', 'exportedAt', 'guide']);
    for (const [name, section] of Object.entries(file.layout as Record<string, { lines: number[]; count: number }>)) {
      if (!section.count) continue;
      for (let n = section.lines[0]; n <= section.lines[1]; n++) {
        expect(() => JSON.parse(lines[n - 1].replace(/,$/, ''))).withContext(`${name} line ${n}`).not.toThrow();
      }
      expect(lines[section.lines[0] - 2]).toBe(`"${name}":[`);
    }
  });

  it('points at every call, body and statement by line AND by exact byte offset', () => {
    const lines = build();
    const text = lines.join('\n');
    const bytes = new TextEncoder().encode(text);
    const at = (offset: number, size: number) => JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + size)).replace(/,$/, ''));
    const file = JSON.parse(text);
    expect(utf8Length(text)).toBe(bytes.length);
    for (const e of file.index) {
      expect(JSON.parse(lines[e.line - 1].replace(/,$/, '')).callId).toBe(e.callId);
      expect(at(e.offset, e.bytes).callId).toBe(e.callId);
      if (e.res?.offset !== undefined) expect(at(e.res.offset, e.res.bytes).refs.some((r: { call: string }) => r.call === e.callId)).toBeTrue();
      if (e.db) {
        expect(JSON.parse(lines[e.db.line - 1].replace(/,$/, '')).callId).toBe(e.callId);
        expect(new TextDecoder().decode(bytes.subarray(e.db.offset, e.db.offset + 12))).toBe('{"callId":"' + e.callId[0]);
        const statementLines = new TextDecoder().decode(bytes.subarray(e.db.statementsOffset, e.db.statementsOffset + e.db.statementsBytes)).split('\n');
        expect(statementLines.length).toBe(e.db.statements);
        expect(statementLines.map((l) => JSON.parse(l.replace(/,$/, '')).seq)).toEqual([1, 2, 3]);
      }
    }
    const layout = file.layout.bodies;
    expect(new TextDecoder().decode(bytes.subarray(layout.offset, layout.offset + layout.bytes)).split('\n').length).toBe(layout.count);
  });

  it('stores a body once however many calls carry it, compact JSON as JSON, anything else verbatim', () => {
    const file = JSON.parse(build().join('\n'));
    const offers = file.bodies.filter((b: { json?: unknown }) => b.json);
    expect(offers.length).toBe(1);
    expect(offers[0].refs).toEqual([{ call: 'in-1', side: 'response' }, { call: 'out-1', side: 'response' }]);
    expect(JSON.stringify(offers[0].json)).toBe(OFFERS);
    expect(file.bodies.find((b: { text?: string }) => b.text === PRETTY)).toBeDefined();
    const small = file.calls.find((c: { callId: string }) => c.callId === 'in-1');
    expect(small.request.body).toBe('{"from":"DXB","to":"LHR"}'); // short: inline
    expect(small.response.bodyRef).toBe(offers[0].body);
    expect(file.index.find((e: { callId: string }) => e.callId === 'out-1').res.shared).toBeTrue();
  });

  it('stores database rows as values under their columns, and statements without what they all share', () => {
    const file = JSON.parse(build().join('\n'));
    const header = file.dbCalls[0];
    expect(header.common).toEqual({ thread: 'task-1', dataSource: 'Oracle 19c' });
    expect(header.origins['a:q1']).toEqual(HQL);
    const [first, second, third] = file.dbStatements;
    expect(first.rowValues[0]).toEqual(['0', 'row 0']);
    expect(first.rowValues[3]).toEqual(['3', null]);
    expect(first.thread).toBeUndefined();
    expect(first.origin).toBe('a:q1');
    expect(second.connectionId).toBe('c2');
    expect(third.origin.params[0].value).toBe('***REDACTED***');
    expect(third.beforeValues).toEqual([['old']]);
  });

  it('opens with a guide, the layout and the highlights - failures first', () => {
    const file = JSON.parse(build().join('\n'));
    expect(file.guide.readFirst).toContain('index');
    expect(file.guide.counts).toEqual({ calls: 5, bodies: 2, dbStatements: 3 });
    expect(file.highlights[0]).toEqual(jasmine.objectContaining({ what: 'FAILED', callId: 'out-2' }));
    const kinds = file.highlights.map((h: { what: string }) => h.what);
    expect(kinds).toContain('COMMENT');
    expect(kinds).toContain('DB_SLOW');
    expect(kinds).toContain('IN_PROGRESS');
    const slow = file.highlights.find((h: { what: string }) => h.what === 'DB_SLOW');
    expect(JSON.parse(build()[slow.line - 1].replace(/,$/, '')).seq).toBe(1);
    expect(file.index.map((e: { callId: string }) => e.callId)).toEqual(['in-1', 'out-1', 'out-2', 'ws-1', 'in-2']);
  });

  it('is much smaller than version 1 for the same calls', () => {
    const big = calls().map((c) => (c.dbCapture ? { ...c, dbCapture: { ...c.dbCapture, statements: Array.from({ length: 40 }, () => c.dbCapture!.statements[0]) } } : c));
    const v1 = JSON.stringify(buildBulkExportPayload(big, FORM, COMMENTS, 'x'), null, 2).length;
    const v2 = build(big).join('\n').length;
    expect(v2).toBeLessThan(v1 * 0.5);
  });

  it('writes and reads an empty export, a streamed file and a gzip file the same way', async () => {
    expect(JSON.parse(build([]).join('\n')).index).toEqual([]);
    const lines = build();
    const whole = parseImportedCalls(JSON.parse(lines.join('\n'))).calls;
    expect(parseImportedCalls(await readExportFile(await exportBlob(lines, false))).calls).toEqual(whole);
    const gz = await exportBlob(lines, true);
    expect(gz.size).toBeLessThan(lines.join('\n').length);
    expect(parseImportedCalls(await readExportFile(gz)).calls).toEqual(whole);
    // a version-1 file goes through the same reader
    const v1 = JSON.stringify(buildBulkExportPayload(calls(), FORM, COMMENTS, 'x'), null, 2);
    expect(parseImportedCalls(await readExportFile(new Blob([v1]))).calls.length).toBe(5);
  });
});
