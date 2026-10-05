import type { CallDbSummary, CallRecord, CapturedStatement } from '../src/frontend.ts';
import type { FakeAlfred } from './fake-alfred.ts';

/**
 * A small world shaped like the real responses captured from Alfred on 2026-10-05 (odeysys flight
 * search 500d0cdc…: 41 statements, an HQL fan-out #19-#25, a swallowed failure at #42), with every
 * value synthetic - no recorded body, token or row is copied into the repo.
 */

export const T0 = Date.parse('2026-10-05T01:34:15.738Z');
export const TOKEN = 'Bearer test-token-not-real-0123456789';
export const IN1 = 'in-flight-search';
export const IN2 = 'in-fare-confirmation';
export const OUT1 = 'out-sabre-search';
export const OUT2 = 'out-sabre-search-2';
export const BIG = 'in-big-body';
export const BIN = 'out-binary';
export const CYCLE = 'cy-booking';

const at = (ms: number) => new Date(T0 + ms).toISOString();

function inbound(id: string, ms: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id, method: 'POST', timestamp: at(ms), duration_ms: 20035.45, state: 'COMPLETED', service_name: 'odeysys', source: 'internal',
    original_url: 'http://localhost:8080/odeysysadmin/Booking2/flight-search/search',
    url: 'http://host.docker.internal:9001/odeysysadmin/Booking2/flight-search/search',
    request: {
      headers: { 'Content-Type': 'application/json', Authorization: TOKEN, Cookie: 'JSESSIONID=fake-session' },
      body: JSON.stringify({ tripType: 1, routes: [{ origin: 'CAI', destination: 'DXB', date: '31-10-2026' }], password: 'pw-not-real' }),
    },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ results: [{ fare: 14694.8, airline: 'EK' }], token: 'resp-secret-xyz' }) },
    ...overrides,
  };
}

function outbound(id: string, ms: number, parent: string | null, seq: number | null): CallRecord {
  return {
    id, method: 'POST', timestamp: at(ms), duration_ms: 2800, state: 'COMPLETED', source: 'external', supplierName: 'SabreNdc',
    original_url: 'https://ndc.example.test/api/FlightSearch/Search', url: 'https://ndc.example.test/api/FlightSearch/Search',
    parentCallId: parent, parentSeq: seq,
    request: { headers: { 'Content-Type': 'application/json', 'x-api-key': 'key-not-real' }, body: '{"q":1}' },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"offers":[]}' },
  };
}

function statement(seq: number, overrides: Partial<CapturedStatement> = {}): CapturedStatement {
  return {
    id: 5600 + seq, callId: IN1, thread: 'default task-5', seq, kind: 'SELECT', sql: `select * from T${seq} where ID=?`, fingerprint: `fp${seq}`,
    table: `T${seq}`, params: [[{ type: 'INTEGER', value: String(seq) }]], outcome: { kind: 'ROWS', columns: [{ name: 'ID', type: 'INT' }], rowsRead: 1 },
    startedAt: at(seq * 400), durationMicros: 50_000, offsetMicros: seq * 400_000, txId: `tx-${seq}`, connectionId: 'conn-1',
    codeLocation: 'GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)',
    callers: ['GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)', 'SystemSettingService.getTags(SystemSettingService.java:75)'],
    undone: false, expected: false, storedRows: 1, origin: null, ...overrides,
  };
}

export function captureStatements(): CapturedStatement[] {
  const list: CapturedStatement[] = [];
  for (let seq = 1; seq <= 43; seq++) {
    if (seq === 28 || seq === 29 || seq === 30) continue; // supplier calls sit in the sequence here
    const origin = seq >= 19 && seq <= 25
      ? { id: 'odeysys-q178', kind: 'HQL' as const, text: 'from FlightTagModel fld where fld.status=?', method: 'list' }
      : null;
    if (seq === 42) {
      list.push(statement(42, {
        kind: 'CALL', sql: 'CALL LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6 (?,?)', table: 'LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6', undone: true, storedRows: 0,
        params: [[{ type: 'VARCHAR', value: 'CAI' }, { type: 'VARCHAR', value: 'secret-col-value' }]],
        outcome: { kind: 'FAILED', sqlState: '42000', vendorCode: 1305, message: 'PROCEDURE does not exist', chain: [], swallowed: true },
        codeLocation: 'GenericDAOImpl.executeSQLQuery(GenericDAOImpl.java:927)',
        callers: ['GenericDAOImpl.executeSQLQuery(GenericDAOImpl.java:927)', 'FlightSearchLogger.log(FlightSearchLogger.java:112)'],
      }));
      continue;
    }
    if (seq === 43) {
      list.push(statement(43, { kind: 'ROLLBACK', sql: 'ROLLBACK', table: null, outcome: { kind: 'TX_END', txResult: 'ROLLED_BACK' }, durationMicros: 0 }));
      continue;
    }
    list.push(statement(seq, {
      origin,
      ...(seq === 19 ? { table: 'TT_TS_FL_TAG', sql: 'select * from TT_TS_FL_TAG where STATUS=?', outcome: { kind: 'ROWS', columns: [{ name: 'API_KEY', type: 'VARCHAR' }, { name: 'ID', type: 'INT' }], rowsRead: 2 } } : {}),
      ...(seq > 19 && seq <= 25 ? { table: 'TT_TS_FL_TAG_COUNTRY', sql: 'select * from TT_TS_FL_TAG_COUNTRY where CONTENT_ID=?' } : {}),
    }));
  }
  return list;
}

export function captureSummary(): CallDbSummary {
  return {
    callId: IN1, statementCount: 40, writeCount: 0, deleteCount: 0, failedCount: 1, transactionCount: 25, rolledBackCount: 1, dbMicros: 2_000_000,
    droppedCount: 0, lastSeq: 43, complete: true, endedEarly: false,
    flags: [
      { type: 'FAILED_SWALLOWED', severity: 'BAD', seqs: [42], detail: { error: '42000', table: 'LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6' } },
      { type: 'QUERY_FAN_OUT', severity: 'WARN', seqs: [19, 20, 21, 22, 23, 24, 25], group: 'odeysys-q178',
        detail: { query: 'from FlightTagModel fld where fld.status=?', table: 'TT_TS_FL_TAG', rows: '2', statements: '7', extra: '6', parents: '2', perRow: '3', tables: 'TT_TS_FL_TAG_COUNTRY', extraMs: '300' } },
    ],
  };
}

/** Seeds the fake with the whole world. */
export function seed(fake: FakeAlfred): void {
  const in1 = inbound(IN1, 0);
  const in2 = inbound(IN2, 60_000, {
    original_url: 'http://localhost:8080/odeysysadmin/v2/booking/fare-confirmation', url: 'http://host.docker.internal:9001/odeysysadmin/v2/booking/fare-confirmation',
    response: { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"payment failed"}' }, duration_ms: 6465,
  });
  const big = inbound(BIG, 120_000, { response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: Array.from({ length: 2500 }, (_, i) => ({ i, name: `item-${i}-padding-padding` })) }) } });
  const bin = { ...outbound(BIN, 130_000, null, null), response: { status: 200, headers: { 'content-type': 'image/png' }, body: '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000' } };
  const out1 = outbound(OUT1, 11_268, IN1, 29);
  const out2 = outbound(OUT2, 11_300, IN1, 30);
  for (const c of [in1, in2, big]) fake.addCall('internal', c);
  for (const c of [out1, out2, bin]) fake.addCall('external', c);
  // Older calls so a time-bounded search has something to stop at.
  for (let i = 0; i < 30; i++) {
    fake.addCall('internal', inbound(`in-old-${i}`, -3_600_000 - i * 1000, { response: { status: i % 5 === 0 ? 404 : 200, headers: {}, body: '{}' }, duration_ms: 100 + i * 50 }));
  }
  fake.state.dbSummaries[IN1] = captureSummary();
  fake.state.statements[IN1] = captureStatements();
  fake.state.rows[5600 + 19] = { columns: [{ name: 'API_KEY', type: 'VARCHAR' }, { name: 'ID', type: 'INT' }], rows: [[{ type: 'VARCHAR', value: 'row-api-key-1' }, { type: 'INT', value: '1' }], [{ type: 'VARCHAR', value: 'row-api-key-2' }, { type: 'INT', value: '2' }]], total: 2 };
  fake.addCycle({ id: CYCLE, name: 'booking fails at payment' }, [
    { source: 'internal', record: in1 }, { source: 'external', record: out1 }, { source: 'internal', record: in2 },
  ]);
  fake.addCycle({ id: 'cy-other', name: 'booking fails at login' });
}
