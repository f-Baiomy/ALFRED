import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCapture, suppliersOf, toCallRecord, type CallSummaryDto, type Redaction } from '../src/frontend.ts';
import { summaryOf } from './fake-alfred.ts';
import { world } from './harness.ts';
import { captureStatements, captureSummary, IN1, IN2 } from './fixtures.ts';

const dto = (v: unknown) => v as CallSummaryDto;
const apiKeyColumn: Redaction = { id: 'r-db', scope: 'call', callId: IN1, kind: 'db-column', name: 'API_KEY', createdAt: '' };

test('db_overview is analyzeCapture on the same capture - summary, time, findings (SC-003)', async () => {
  const w = await world();
  try {
    const r = await w.call('db_overview', { callId: IN1, queries: 100 });
    assert.equal(r.isError, false, r.text);
    const call = toCallRecord(dto(summaryOf(w.fake.state.calls.find((c) => c.record.id === IN1)!.record)), 'internal');
    const children = w.fake.state.calls.filter((c) => c.record.parentCallId === IN1).map((c) => toCallRecord(dto(summaryOf(c.record)), 'external'));
    const expected = analyzeCapture(call, { summary: captureSummary(), statements: captureStatements(), transactions: [], supplierMarkers: [] }, suppliersOf(IN1, children));
    assert.equal(r.json.summary, expected.summary);
    assert.deepEqual(r.json.time, expected.time);
    assert.deepEqual(r.json.findings, expected.findings);
    assert.equal(r.json.queryCount, expected.queries.length);
    const sources = r.json.findings.map((f: { source: string }) => f.source);
    assert.ok(sources.includes('QUERY_FAN_OUT') && sources.includes('FAILED_SWALLOWED'));
  } finally { await w.close(); }
});

test('a call without capture says so', async () => {
  const w = await world();
  try {
    const r = await w.call('db_overview', { callId: IN2 });
    assert.equal(r.json.error, 'not_found');
    assert.match(r.json.message, /no database capture/);
  } finally { await w.close(); }
});

test('db_statements filters and pages', async () => {
  const w = await world();
  try {
    const failed = await w.call('db_statements', { callId: IN1, failedOnly: true });
    assert.deepEqual(failed.json.statements.map((s: { seq: number }) => s.seq), [42]);
    assert.match(failed.json.statements[0].outcome, /FAILED \(swallowed\) 42000/);
    assert.equal(failed.json.statements[0].at, 'GenericDAOImpl.executeSQLQuery(GenericDAOImpl.java:927)');
    const table = await w.call('db_statements', { callId: IN1, table: 'tt_ts_fl_tag_country' });
    assert.deepEqual(table.json.statements.map((s: { seq: number }) => s.seq), [20, 21, 22, 23, 24, 25]);
    const kind = await w.call('db_statements', { callId: IN1, kind: 'call' });
    assert.equal(kind.json.total, 1);
    const page = await w.call('db_statements', { callId: IN1, offset: 10, limit: 5 });
    assert.equal(page.json.total, 40);
    assert.equal(page.json.nextOffset, 15);
    const text = await w.call('db_statements', { callId: IN1, text: 'LOG_FLIGHTSEARCH' });
    assert.equal(text.json.total, 1);
  } finally { await w.close(); }
});

test('db_statement: full SQL, params, rows page, call chain and origin query', async () => {
  const w = await world();
  try {
    const r = await w.call('db_statement', { statementId: 5619 });
    assert.equal(r.json.seq, 19);
    assert.equal(r.json.sql, 'select * from TT_TS_FL_TAG where STATUS=?');
    assert.deepEqual(r.json.params, [['INTEGER:19']]);
    assert.deepEqual(r.json.callers, ['GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)', 'SystemSettingService.getTags(SystemSettingService.java:75)']);
    assert.equal(r.json.origin.kind, 'HQL');
    assert.deepEqual(r.json.rows.columns, ['API_KEY:VARCHAR', 'ID:INT']);
    assert.deepEqual(r.json.rows.rows, [['row-api-key-1', '1'], ['row-api-key-2', '2']]);
  } finally { await w.close(); }
});

test('db_query passes the request through and cuts long cells, saying so', async () => {
  const w = await world();
  try {
    w.fake.state.query = { columns: ['n', 'sql'], rows: [['19', 'x'.repeat(1000)]], total: 1, statementSeqs: [19] };
    const r = await w.call('db_query', { callId: IN1, mode: 'sql', text: 'select n, sql from statements', limit: 10 });
    const sent = w.fake.requests('POST', '/statements/query')[0].body;
    assert.deepEqual({ mode: sent.mode, text: sent.text, offset: sent.offset, limit: sent.limit }, { mode: 'sql', text: 'select n, sql from statements', offset: 0, limit: 10 });
    assert.match(r.json.rows[0][1], /… \(1000 chars/);
    assert.deepEqual(r.json.statementSeqs, [19]);
  } finally { await w.close(); }
});

test('trace_value maps hits and never echoes the value', async () => {
  const w = await world();
  try {
    w.fake.state.trace = [{ seq: 19, where: 'ROW', index: 0, column: 'ID' }];
    const r = await w.call('trace_value', { callId: IN1, value: 'secret-col-value' });
    assert.deepEqual(r.json.hits, [{ seq: 19, where: 'ROW', index: 0, column: 'ID' }]);
    assert.ok(!r.text.includes('secret-col-value'));
  } finally { await w.close(); }
});

test('masking reaches database data: rows, params, query cells (C1)', async () => {
  const w = await world();
  try {
    w.fake.state.redactions = [apiKeyColumn];
    w.fake.state.variables = { variables: { s: 'secret-col-value' }, fallbacks: {}, secrets: ['s'] };
    w.fake.state.query = { columns: ['API_KEY', 'note'], rows: [['row-api-key-1', 'has secret-col-value inside']], total: 1 };
    await w.call('session_settings', { maskSecrets: true });

    const st = await w.call('db_statement', { statementId: 5619 });
    assert.ok(!st.text.includes('row-api-key-1'), 'redacted column hidden in rows');
    assert.equal(st.json.masked, true);
    assert.ok(st.json.maskedValues >= 2);

    const failed = await w.call('db_statement', { statementId: 5642, rowsLimit: 0 });
    assert.ok(!failed.text.includes('secret-col-value'), 'secret variable hidden in params');

    const query = await w.call('db_query', { callId: IN1, text: 'x' });
    assert.ok(!query.text.includes('row-api-key-1') && !query.text.includes('secret-col-value'));
    assert.ok(query.json.maskedValues >= 2);

    const overview = await w.call('db_overview', { callId: IN1 });
    assert.equal(overview.json.masked, true);

    const unmasked = await w.call('db_statement', { statementId: 5619, mask: false });
    assert.ok(unmasked.text.includes('row-api-key-1'), 'masking off: verbatim');
  } finally { await w.close(); }
});
