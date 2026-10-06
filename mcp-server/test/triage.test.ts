import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { emptyResultOf, softFailureOf, type CallRecord } from '../src/frontend.ts';
import { world } from './harness.ts';
import { CYCLE, IN1, IN2, OUT1, T0 } from './fixtures.ts';
import type { FakeAlfred } from './fake-alfred.ts';

const at = (ms: number) => new Date(T0 + ms).toISOString();

/** The seeded booking cycle plus: a supplier call of IN2 that answered 503, an OTA error 322 inside a 200 under IN1, and a 307. */
function addTrouble(fake: FakeAlfred): void {
  const failingSupplier: CallRecord = {
    id: 'out-payment-503', method: 'POST', timestamp: at(61_000), duration_ms: 900, state: 'COMPLETED', source: 'external',
    original_url: 'https://pay.example.test/charge', url: 'https://pay.example.test/charge', parentCallId: IN2, parentSeq: 3,
    request: { headers: {}, body: '{}' }, response: { status: 503, headers: {}, body: 'down' },
  };
  const otaError: CallRecord = {
    id: 'out-g94-322', method: 'POST', timestamp: at(11_400), duration_ms: 1440, state: 'COMPLETED', source: 'external',
    original_url: 'https://g94.example.test/AAResWebServices', url: 'https://g94.example.test/AAResWebServices', parentCallId: IN1, parentSeq: 31,
    request: { headers: {}, body: '<x/>' },
    response: { status: 200, headers: {}, body: '<soap:Envelope><soap:Body><ns1:OTA_AirAvailRS><ns1:Errors><ns1:Error Code="322" ShortText="No availability" Type="ERR" /></ns1:Errors></ns1:OTA_AirAvailRS></soap:Body></soap:Envelope>' },
  };
  const redirect: CallRecord = {
    id: 'in-user-details', method: 'GET', timestamp: at(-5_000), duration_ms: 48, state: 'COMPLETED', source: 'internal', service_name: 'odeysys',
    original_url: 'http://localhost:8080/odeysysadmin/Admin2/userDetails', url: 'http://host.docker.internal:9001/odeysysadmin/Admin2/userDetails',
    request: { headers: {}, body: '' }, response: { status: 307, headers: {}, body: '' },
  };
  fake.addCall('external', failingSupplier);
  fake.addCall('external', otaError);
  fake.addCall('internal', redirect);
  const entries = fake.state.cycleEntries.get(CYCLE)!;
  for (const [source, record] of [['external', failingSupplier], ['external', otaError], ['internal', redirect]] as const) {
    entries.push({ capturedId: `cap-${record.id}`, capturedAt: record.timestamp, source, record });
  }
}

/** The number each call has in the cycle (run order, OPTIONS hidden) - as get_cycle shows it. */
function numbers(fake: FakeAlfred): Map<string, number> {
  const sorted = [...fake.state.cycleEntries.get(CYCLE)!].sort((a, b) => Date.parse(a.record.timestamp) - Date.parse(b.record.timestamp));
  return new Map(sorted.map((e, i) => [e.record.id, i + 1]));
}

test('triage on a cycle: every group in reading order, each call once with its evidence', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    const n = numbers(w.fake);
    const r = await w.call('triage', { cycle: 'at payment' });
    assert.equal(r.isError, false, r.text);
    const t = r.text;
    // 1: IN2 failed (500) and its supplier call failed (503) - the supplier call is evidence, shown by its number.
    assert.match(t, new RegExp(`1 · Failed, with failing supplier calls \\(1\\)\\n  #${n.get(IN2)} IN  POST \\S+fare-confirmation → 500`));
    assert.match(t, new RegExp(`↳ #${n.get('out-payment-503')} POST pay\\.example\\.test → 503`));
    // 3: the redirect counts at the default threshold.
    assert.match(t, new RegExp(`3 · Other failed calls \\(1\\)\\n  #${n.get('in-user-details')} IN  GET \\S+userDetails → 307`));
    // 4: IN1 answered 200, but its statement #42 failed and was swallowed, and a supplier call hid an OTA 322.
    assert.match(t, /4 · Succeeded, but something under it failed \(hidden failures\) \(1\)/);
    assert.match(t, new RegExp(`↳ #${n.get('out-g94-322')} POST g94\\.example\\.test → 200 ✖ 322: No availability`));
    assert.match(t, /✖ DB #42 CALL LOG_FLIGHTSEARCH_HIT_DETAILS_SP_V6 failed 42000 PROCEDURE does not exist · swallowed · rolled back \(statement 5642\)/);
    assert.match(t, /at GenericDAOImpl\.executeSQLQuery\(GenericDAOImpl\.java:927\)/);
    // Supplier calls made by a call of the cycle are listed under it, never as entries of their own.
    for (const id of [OUT1, 'out-payment-503', 'out-g94-322']) assert.doesNotMatch(t, new RegExp(`^  #${n.get(id)} `, 'm'));
    assert.deepEqual(r.json.totals, { 1: 1, 2: 0, 3: 1, 4: 1, 5: 0, 6: 0 });
    assert.equal(r.json.calls, 6);
  } finally { await w.close(); }
});

test('triage reads the saved marks: one marks request, one failures request, no body', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    w.fake.log.length = 0;
    await w.call('triage', { cycle: CYCLE });
    assert.equal(w.fake.requests('GET', '/triage/calls').length, 1);
    assert.equal(w.fake.requests('GET', '/db-capture/failures').length, 1);
    assert.equal(w.fake.requests('GET', '/detail').length, 0, 'no body read');
    assert.equal(w.fake.requests('GET', '/db-capture/calls/').length, 0, 'no statement list loaded');
  } finally { await w.close(); }
});

test('minStatus re-ranks: at 400 the redirect is no longer a failure', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    const r = await w.call('triage', { cycle: CYCLE, minStatus: 400 });
    assert.deepEqual(r.json.totals, { 1: 1, 2: 0, 3: 0, 4: 1, 5: 0, 6: 1 });
    assert.match(r.text, /6 · Everything else[\s\S]*#1 - nothing flagged/);
  } finally { await w.close(); }
});

test('a call with no saved mark is still listed - under 6, and the header says why', async () => {
  const w = await world();
  try {
    w.fake.state.unmarked.add(IN2);
    const r = await w.call('triage', { cycle: CYCLE });
    assert.match(r.text, /1 have no saved mark/);
    assert.equal(r.json.totals[6], 1);
  } finally { await w.close(); }
});

test('one group can be paged on its own', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    const r = await w.call('triage', { cycle: CYCLE, group: 4 });
    assert.doesNotMatch(r.text, /1 · Failed/);
    assert.match(r.text, /4 · Succeeded/);
    assert.deepEqual(r.json.shown, { 4: 1 });
  } finally { await w.close(); }
});

test('triage on live calls: a window of a project, failures newest first, the rest counted', async () => {
  const w = await world();
  try {
    const r = await w.call('triage', { project: 'odeysys', from: at(-4_000_000), to: at(200_000) });
    assert.equal(r.isError, false, r.text);
    // in-old-0, -5, -10, ... answered 404 (6 of the 30), IN2 answered 500.
    assert.match(r.text, /3 · Other failed calls \(7\)/);
    assert.match(r.text, /in-fare-…|in-fare-c…/);
    assert.match(r.text, /4 · Succeeded, but something under it failed[\s\S]*in-fligh…/);
    assert.equal(r.json.calls, 33);
    assert.match(r.text, /more calls in the window with nothing flagged/);
    assert.equal(w.fake.requests('GET', '/triage/live')[0].query.get('project'), 'odeysys');
  } finally { await w.close(); }
});

test('cycle and live scope together is refused', async () => {
  const w = await world();
  try {
    const r = await w.call('triage', { cycle: CYCLE, project: 'odeysys' });
    assert.equal(r.isError, true);
  } finally { await w.close(); }
});

test('get_cycle opens with the attention line and takes its flags from the marks, without reading bodies', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    const n = numbers(w.fake);
    w.fake.log.length = 0;
    const r = await w.call('get_cycle', { cycle: CYCLE, includeDb: false, includeComments: false });
    const second = r.text.split('\n')[1];
    assert.match(second, new RegExp(`^Needs attention - 1: #${n.get(IN2)} \\(500, 1 supplier call failed\\) · 3: #${n.get('in-user-details')} \\(307\\) · 4: #${n.get(IN1)} \\(1 supplier call failed, 1 failed statement\\)`));
    assert.match(r.text, /✖ 322: No availability/);
    assert.equal(w.fake.requests('GET', '/detail').length, 0, 'flags came from the saved marks');
  } finally { await w.close(); }
});

test('get_cycle still judges a call with no mark from its body', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    w.fake.state.unmarked.add('out-g94-322');
    const r = await w.call('get_cycle', { cycle: CYCLE, includeDb: false, includeComments: false });
    assert.match(r.text, /✖ 322: No availability/);
    assert.ok(w.fake.requests('GET', '/out-g94-322/detail').length >= 1);
  } finally { await w.close(); }
});

test('get_call carries the call\'s triage group, its failing supplier calls and its failed statements', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    const r = await w.call('get_call', { id: IN1 });
    assert.equal(r.json.attention.priority, 4);
    assert.equal(r.json.attention.needsAttention, false);
    assert.deepEqual(r.json.attention.failingSupplierCalls.map((s: { id: string }) => s.id), ['out-g94-322']);
    assert.equal(r.json.attention.failingSupplierCalls[0].softFailure.code, '322');
    assert.equal(r.json.dbFailures.failedCount, 1);
    assert.equal(r.json.dbFailures.swallowedCount, 1);
    assert.equal(r.json.dbFailures.statements[0].seq, 42);
  } finally { await w.close(); }
});

test('db_statements failedOnly reads the failed-statement index, not every statement', async () => {
  const w = await world();
  try {
    w.fake.log.length = 0;
    const r = await w.call('db_statements', { callId: IN1, failedOnly: true });
    assert.equal(r.json.total, 1);
    assert.equal(r.json.statements[0].seq, 42);
    assert.match(r.json.statements[0].outcome, /FAILED \(swallowed\) 42000/);
    assert.equal(w.fake.requests('GET', '/statements').length, 0);
    const none = await w.call('db_statements', { callId: IN2, failedOnly: true });
    assert.equal(none.json.error, 'not_found', 'a call with no capture still says so');
  } finally { await w.close(); }
});

test('search_cycle and search_calls: dbFailed finds the 200 with a failed statement, needsAttention the 500 and the 307', async () => {
  const w = await world();
  try {
    addTrouble(w.fake);
    const db = await w.call('search_cycle', { cycle: CYCLE, dbFailed: true });
    assert.deepEqual(db.json.calls.map((c: { id: string }) => c.id), [IN1]);
    const attention = await w.call('search_cycle', { cycle: CYCLE, needsAttention: true, direction: 'inbound' });
    assert.deepEqual(attention.json.calls.map((c: { id: string }) => c.id).sort(), [IN2, 'in-user-details'].sort());
    const at400 = await w.call('search_cycle', { cycle: CYCLE, needsAttention: true, direction: 'inbound', minStatus: 400 });
    assert.deepEqual(at400.json.calls.map((c: { id: string }) => c.id), [IN2]);
    const live = await w.call('search_calls', { project: 'odeysys', dbFailed: true });
    assert.deepEqual(live.json.calls.map((c: { id: string }) => c.id), [IN1]);
    assert.equal(w.fake.requests('GET', '/detail').length, 0, 'the marks answered, no body was read');
  } finally { await w.close(); }
});

test('the shared soft-failure vectors: the TypeScript gives what the file says (the Java runs the same file)', () => {
  const file = JSON.parse(readFileSync(new URL('../../specs/007-alfred-mcp-server/soft-failure-vectors.json', import.meta.url), 'utf8'));
  assert.ok(file.vectors.length > 40);
  for (const v of file.vectors) {
    const call = { error: v.error, response: v.status === null ? undefined : { status: v.status, headers: {}, body: v.body } } as unknown as CallRecord;
    const soft = softFailureOf(call);
    assert.deepEqual(soft ? { kind: soft.kind, code: soft.code, message: soft.message } : null, v.softFailure, v.name);
    const empty = emptyResultOf(call);
    assert.deepEqual(empty ? [...empty.emptyKeys] : null, v.emptyKeys, v.name);
  }
});

test('triage over a big cycle never sends more call ids in one URL than the gateway accepts (414)', async () => {
  const w = await world();
  try {
    const entries = w.fake.state.cycleEntries.get(CYCLE)!;
    for (let i = 0; i < 250; i++) {
      const record: CallRecord = {
        id: `bulk-${String(i).padStart(4, '0')}-0000-0000-0000-000000000000`, method: 'GET', timestamp: at(100_000 + i), duration_ms: 5,
        state: 'COMPLETED', source: 'internal', service_name: 'odeysys', original_url: 'http://localhost:8080/x', url: 'http://h:9001/x',
        request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '' },
      };
      w.fake.addCall('internal', record);
      entries.push({ capturedId: `cap-${record.id}`, capturedAt: record.timestamp, source: 'internal', record });
    }
    const r = await w.call('triage', { cycle: 'at payment' });
    assert.equal(r.isError, false, r.text);
    const tooLong = w.fake.log.filter((q) => (q.query.get('callIds') ?? '').split(',').filter(Boolean).length > 100);
    assert.deepEqual(tooLong.map((q) => q.path), []);
  } finally { await w.close(); }
});
