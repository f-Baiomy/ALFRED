import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyseFlows, normValue, parseBody, writtenColumns, type Side } from '../src/flow-diff.ts';
import type { CallDbSummary, CallRecord, CapturedStatement } from '../src/frontend.ts';
import type { FakeAlfred } from './fake-alfred.ts';
import { world } from './harness.ts';

/**
 * check_calls (listen and review in batches): every call of a cycle checked in code - marks, slow calls and the hop
 * diffs of the flows the calls carry - so nothing is skipped and Claude reads only what is flagged.
 */

const T = Date.parse('2026-10-13T09:00:00Z');
const at = (s: number) => new Date(T + s * 1000).toISOString();
const DAY = '2026-11-02';
const CY = 'cy-flow';
const PASSENGERS = [{ firstName: 'Jane', lastName: 'Doe' }, { firstName: 'Omar', lastName: 'Haddad' }];
const OFFER = { offerId: 'OF-1', flight: 'EK001', departure: `${DAY}T08:15`, arrival: `${DAY}T12:40`, fare: { total: '412.00', currency: 'USD' } };

function inbound(id: string, s: number, method: string, path: string, req: unknown, res: unknown, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    id, method, timestamp: at(s), duration_ms: 300, state: 'COMPLETED', source: 'internal', service_name: 'odeysys',
    original_url: `http://localhost:8080${path}`, url: `http://host.docker.internal:9001${path}`,
    request: { headers: { 'X-Request-Id': `r-${id}` }, body: req === undefined ? '' : JSON.stringify(req) },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(res) }, ...extra,
  };
}

function outbound(id: string, s: number, parent: string, path: string, req: unknown, res: unknown): CallRecord {
  return {
    id, method: 'POST', timestamp: at(s), duration_ms: 120, state: 'COMPLETED', source: 'external', parentCallId: parent, parentSeq: 2,
    original_url: `https://ndc.example.test${path}`, url: `https://ndc.example.test${path}`,
    request: { headers: {}, body: JSON.stringify(req) }, response: { status: 200, headers: {}, body: JSON.stringify(res) },
  };
}

function insert(callId: string): CapturedStatement {
  return {
    id: 9001, callId, thread: 't', seq: 3, kind: 'INSERT', table: 'booking', fingerprint: 'f',
    sql: 'INSERT INTO booking (pnr, offer_id, fare_total, currency) VALUES (?, ?, ?, ?)',
    params: [[{ type: 'VARCHAR', value: 'K7Q2ZP' }, { type: 'VARCHAR', value: 'OF-1' }, { type: 'DECIMAL', value: '412.00' }, { type: 'VARCHAR', value: 'USD' }]],
    outcome: { kind: 'UPDATED', affected: 1 }, startedAt: at(45), durationMicros: 900, offsetMicros: 3000, undone: false, expected: false, storedRows: 0,
  };
}

/** search → confirm → book → view: the departure moves at confirm, book loses a passenger to the supplier and saves the old fare. */
function seedFlow(fake: FakeAlfred): Record<string, string> {
  const confirmed = { total: '437.50', currency: 'USD' };
  const booking = { pnr: 'K7Q2ZP', status: 'CONFIRMED', flight: 'EK001', fare: confirmed, passengers: PASSENGERS };
  const calls: { source: 'internal' | 'external'; record: CallRecord }[] = [
    { source: 'internal', record: { ...inbound('in-pre', 0, 'OPTIONS', '/api/search', undefined, ''), response: { status: 204, headers: {} } } },
    { source: 'internal', record: inbound('in-search', 1, 'POST', '/api/search', { from: 'DXB', to: 'LHR' }, { offers: [OFFER] }) },
    { source: 'external', record: outbound('out-search', 2, 'in-search', '/AirShopping', { from: 'DXB' }, { offers: [{ id: 'OF-1', price: '412.00' }] }) },
    { source: 'internal', record: inbound('in-confirm', 20, 'POST', '/api/confirm', { offerId: 'OF-1' },
      { ...OFFER, departure: `${DAY}T09:15`, fare: confirmed }) },
    { source: 'internal', record: inbound('in-book', 45, 'POST', '/api/bookings', { offerId: 'OF-1', fare: confirmed, passengers: PASSENGERS }, booking) },
    { source: 'external', record: outbound('out-book', 46, 'in-book', '/OrderCreate', { offerId: 'OF-1', passengers: PASSENGERS.slice(0, 1) },
      { order: { pnr: 'K7Q2ZP', status: 'CONFIRMED' } }) },
    { source: 'internal', record: inbound('in-view', 70, 'GET', '/api/bookings/K7Q2ZP', undefined, booking) },
  ];
  for (const c of calls) fake.addCall(c.source, c.record);
  fake.addCycle({ id: CY, name: 'Flow check', status: 'RECORDING' }, calls);
  fake.state.statements['in-book'] = [insert('in-book')];
  fake.state.dbSummaries['in-book'] = {
    callId: 'in-book', statementCount: 1, writeCount: 1, deleteCount: 0, failedCount: 0, transactionCount: 1, rolledBackCount: 0,
    dbMicros: 900, droppedCount: 0, flags: [], lastSeq: 3, complete: true, endedEarly: false,
  } as CallDbSummary;
  fake.state.signals['in-book'] = { logErrors: 1 };
  fake.state.callLogs['in-book'] = {
    setup: 'OK', matchedBy: 'CAUGHT', thread: 't', lines: [{
      sourceId: 's', sourceName: 'app', lineId: 'caught:1', at: at(45), offsetMs: 200, level: 'ERROR', thread: 't',
      logger: 'com.x.ConfirmationMailer', message: 'Failed to send booking confirmation', matchedBy: 'CAUGHT', raw: 'ERROR ...',
      exception: { type: 'java.lang.NullPointerException', message: 'contact is null', stack: 'at ConfirmationMailer.send(ConfirmationMailer.java:74)' },
    }],
  };
  // the number each call has in the cycle (OPTIONS hidden, run order)
  return { search: '#1', outSearch: '#2', confirm: '#3', book: '#4', outBook: '#5', view: '#6' };
}

// ------------------------------------------------------------------------------------------------ the engine

test('flow diff: a value that changed, a list that lost an item and a row saved with the old value - and nothing for the rest', () => {
  const side = (callId: string, kind: Side['kind'], at: number, root: unknown, table?: string): Side => ({ callId, kind, at, root, table });
  const a = analyseFlows([
    side('search', 'res', 1, { offers: [OFFER, { offerId: 'OF-2', flight: 'BA1', departure: `${DAY}T10:00` }] }),
    side('confirm', 'req', 2, { offerId: 'OF-1' }),
    side('confirm', 'res', 3, { ...OFFER, departure: `${DAY}T09:15:00Z`, fare: { total: 437.5, currency: 'usd' } }),
    side('book', 'req', 4, { offerId: 'OF-1', fare: { total: '437.50', currency: 'USD' }, passengers: PASSENGERS }),
    side('book', 'db', 5, { OFFER_ID: 'OF-1', FARE_TOTAL: '412.00' }, 'booking'),
    side('supplier', 'req', 6, { offerId: 'OF-1', passengers: PASSENGERS.slice(0, 1) }),
  ]);
  const lines = a.diffs.map((d) => `${d.kind} ${d.key} ${d.from.callId}:${d.from.value} → ${d.to.callId}:${d.to.value}`);
  assert.ok(lines.includes(`changed departure search:"${DAY}T08:15" → confirm:"${DAY}T09:15:00Z"`), lines.join('\n'));
  assert.ok(lines.includes('changed faretotal search:"412.00" → confirm:437.5'), lines.join('\n'));
  assert.ok(lines.includes('changed faretotal book:"437.50" → book:"412.00"'), 'the row against the request of the same call');
  assert.ok(lines.includes('count passengers book:2 items → supplier:1 items'), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes('currency')), 'USD and usd are the same value');
  assert.ok(!lines.some((l) => l.includes('BA1') || l.includes('OF-2')), 'an offer never chosen is not part of the flow');
  assert.deepEqual(a.flows.map((f) => [...f.callIds].sort()), [['book', 'confirm', 'search', 'supplier']]);
});

test('flow diff: a value that went missing from a snapshot that otherwise mirrors the earlier one', () => {
  const full = { orderId: 'ORD-77', status: 'OK', total: '10', currency: 'EUR', email: 'a@b.c', phone: '1' };
  const { email: _e, ...without } = full;
  const a = analyseFlows([
    { callId: 'a', kind: 'res', at: 1, root: full },
    { callId: 'b', kind: 'res', at: 2, root: without },
    { callId: 'c', kind: 'req', at: 3, root: { orderId: 'ORD-77' } },
  ]);
  assert.deepEqual(a.diffs.map((d) => `${d.kind} ${d.key} ${d.to.callId}`), ['missing email b']);
});

test('flow diff: an id in most calls (the agency, the user) links nothing', () => {
  const sides: Side[] = Array.from({ length: 8 }, (_, i) => ({ callId: `c${i}`, kind: 'req' as const, at: i, root: { agencyId: 'AG-948', page: i } }));
  const a = analyseFlows(sides);
  assert.deepEqual(a.contextAnchors, ['ag-948']);
  assert.deepEqual(a.diffs, []);
  assert.deepEqual(a.flows, []);
});

test('values compare by meaning: numbers, date-times and case', () => {
  assert.equal(normValue('412.00'), normValue(412));
  assert.equal(normValue('2026-11-02 08:15:00'), normValue('2026-11-02T08:15Z'));
  assert.notEqual(normValue('2026-11-02T08:15'), normValue('2026-11-02T09:15'));
  assert.notEqual(normValue('2026-11-02T08:15+04:00'), normValue('2026-11-02T08:15'));
  assert.equal(normValue('CONFIRMED'), normValue('confirmed'));
  assert.equal(normValue('007'), '007', 'a code with a leading zero stays text');
});

test('written columns in parameter order; XML bodies become trees', () => {
  assert.deepEqual(writtenColumns('insert into BOOKING (PNR, CREATED, FARE) values (?, SYSDATE, ?)'), { table: 'BOOKING', columns: ['PNR', 'FARE'] });
  assert.deepEqual(writtenColumns('UPDATE booking SET status = ?, fare = ? WHERE pnr = ?'), { table: 'booking', columns: ['status', 'fare', 'pnr'] });
  assert.equal(writtenColumns('SELECT 1 FROM dual'), null);
  assert.deepEqual(parseBody('<Order id="ORD-77"><Pax>Jane</Pax><Pax>Omar</Pax></Order>'), { Order: { id: 'ORD-77', Pax: ['Jane', 'Omar'] } });
  assert.equal(parseBody('not a body'), undefined);
});

// ------------------------------------------------------------------------------------------------ the tool

test('check_calls on a whole cycle: every call accounted for, the drifts flagged with both sides, the clean ones listed', async () => {
  const w = await world();
  try {
    const n = seedFlow(w.fake);
    const r = await w.call('check_calls', { cycle: CY });
    assert.equal(r.isError, false, r.text);
    const t = r.text;
    assert.match(t, /6 checked \(4 entries, 2 supplier calls under them, 1 OPTIONS skipped\) - 2 flagged, 2 clean/);
    // confirm: the departure moved between search and confirm
    assert.match(t, new RegExp(`${n.confirm} IN  POST \\S+/api/confirm → 200[\\s\\S]*?Δ changed departure: "${DAY}T08:15" \\(${n.search} res offers\\[0\\]\\.departure\\) → "${DAY}T09:15" \\(${n.confirm} res departure\\) via of-1`));
    // book: its own ERROR line, the passenger its supplier call lost, and the row saved with the old fare
    assert.match(t, new RegExp(`${n.book} IN  POST \\S+/api/bookings → 200`));
    assert.match(t, /▤ ERROR ConfirmationMailer: Failed to send booking confirmation \[java\.lang\.NullPointerException\]/);
    assert.match(t, new RegExp(`Δ count passengers: 2 items \\(${n.book} req passengers\\) → 1 items \\(${n.outBook} req passengers\\)`));
    assert.match(t, new RegExp(`Δ changed faretotal: "437\\.50" \\(${n.book} req fare\\.total\\) → "412\\.00" \\(${n.book} db fare_total\\)`));
    // and the response that shows the right fare over the wrong row
    assert.match(t, new RegExp(`Δ changed faretotal: "412\\.00" \\(${n.book} db fare_total\\) → "437\\.50" \\(${n.book} res fare\\.total\\) via k7q2zp`));
    // supplier calls count under the inbound call that made them
    assert.match(t, /Flows \(1\)[\s\S]*\n  #1 #3 #4 #6 via of-1/);
    assert.match(t, new RegExp(`Clean \\(2\\): ${n.search} ${n.view}`));
    assert.deepEqual(r.json.flagged, [3, 4]);
    assert.equal(r.json.checked, 6);
    assert.equal(r.json.lastCallId, 'in-view');
    assert.doesNotMatch(t, /requestid|x-request-id/i, 'per-request ids are never a diff');
  } finally { await w.close(); }
});

test('check_calls after a call: only the later calls are reported, the earlier ones still serve as where a value came from', async () => {
  const w = await world();
  try {
    const n = seedFlow(w.fake);
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: 'out-search' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /the calls after #2: 4 checked/);
    assert.match(r.text, new RegExp(`Δ changed departure: "${DAY}T08:15" \\(${n.search} res`));
    assert.doesNotMatch(r.text, new RegExp(`^  ${n.search} `, 'm'));
    assert.match((await w.call('check_calls', { cycle: CY, sinceCallId: 'nope' })).text, /not in cycle/);
  } finally { await w.close(); }
});

test('check_calls stops a batch at a call still running and gives its checks to the next batch', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    const entries = w.fake.state.cycleEntries.get(CY)!;
    const book = entries.find((e) => e.record.id === 'in-book')!;
    book.record = { ...book.record, state: 'IN_PROGRESS' } as CallRecord;
    const r = await w.call('check_calls', { cycle: CY });
    assert.equal(r.json.lastCallId, 'in-confirm');
    assert.deepEqual(r.json.pending, [4, 5, 6]);
    assert.match(r.text, /3 still running \(next time\)/);
  } finally { await w.close(); }
});

test('check_calls reads each finished body once: a second check costs no detail request', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    await w.call('check_calls', { cycle: CY });
    w.fake.log.length = 0;
    await w.call('check_calls', { cycle: CY });
    assert.equal(w.fake.requests('GET', '/detail').length, 0);
    assert.equal(w.fake.requests('GET', '/statements').length, 0);
  } finally { await w.close(); }
});

test('wait_for_calls settleSec: returns the whole burst once the user pauses, not at the first call', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    const started = Date.now();
    const waiting = w.call('wait_for_calls', { cycleId: CY, sinceCallId: 'in-view', timeoutSec: 20, settleSec: 1 });
    for (let i = 0; i < 50 && w.fake.openSockets().length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    const add = (id: string, s: number) => {
      const record = inbound(id, s, 'GET', `/api/x/${id}`, undefined, {});
      w.fake.state.cycleEntries.get(CY)!.push({ capturedId: `cap-${id}`, capturedAt: record.timestamp, source: 'internal', record });
      w.fake.broadcast('/ws/internal-calls', '{"type":"new-call"}');
    };
    add('later-1', 80);
    await new Promise((r) => setTimeout(r, 600));
    add('later-2', 81);
    const r = await waiting;
    assert.equal(r.json.timedOut, false);
    assert.deepEqual(r.json.newCalls.map((c: { id: string }) => c.id), ['later-1', 'later-2']);
    assert.ok(Date.now() - started < 10_000);
  } finally { await w.close(); }
});
