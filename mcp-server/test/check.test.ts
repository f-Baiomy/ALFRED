import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyseFlows, FlowIndex, normValue, parseBody, writtenColumns, type Side } from '../src/flow-diff.ts';
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
  const sides: Side[] = Array.from({ length: 40 }, (_, i) => ({ callId: `c${i}`, kind: 'req' as const, at: i, root: { agencyId: 'AG-948', page: i } }));
  const a = analyseFlows(sides);
  assert.deepEqual(a.contextAnchors, ['ag-948']);
  assert.deepEqual(a.diffs, []);
  assert.deepEqual(a.flows, []);
});

test('flow diff: in a short cycle the id all calls carry is the flow, not context', () => {
  const sides: Side[] = Array.from({ length: 8 }, (_, i) => ({ callId: `c${i}`, kind: 'req' as const, at: i, root: { bookingId: 'BK-9481', seat: `1${String.fromCharCode(65 + i)}` } }));
  const a = analyseFlows(sides);
  assert.deepEqual(a.contextAnchors, [], 'under 30 calls nothing is context');
  assert.equal(a.flows.length, 1);
  assert.ok(a.diffs.some((d) => d.key === 'seat'), 'the seat that changed between the calls is a diff');
});

test('flow index: a call indexed late names the calls that now follow it, in order', () => {
  const index = new FlowIndex();
  const side = (callId: string, at: number, seat: string): Side => ({ callId, kind: 'req', at, root: { bookingId: 'BK-9481', seat } });
  assert.deepEqual(index.add('first', [side('first', 1, '1A')]), [], 'the first call has nothing after it');
  assert.deepEqual(index.add('third', [side('third', 3, '3C')]), [], 'a call at the end has nothing after it');
  assert.deepEqual(index.add('second', [side('second', 2, '2B')]), ['third'], 'slotted in before third');
  assert.deepEqual(index.add('second', [side('second', 2, '2B')]), [], 'a call indexed again is ignored');
  const diffs = index.diffsFor(new Set(['third']));
  assert.deepEqual(diffs.map((d) => `${d.from.callId}→${d.to.callId}`), ['second→third'], 'third is compared with the call just before it, which arrived after it');
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
    assert.match(t, /6 checked \(4 entries, 2 supplier calls under them, 1 OPTIONS skipped\) - 2 flagged in 2 groups, 2 clean/);
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
    // the error first, then the drift; each a group of its own
    assert.deepEqual(r.json.groups.map((g: { group: string; calls: number[] }) => [g.group, g.calls]), [['G1', [4]], ['G2', [3]]]);
    // and each group names itself for the JSON: a stable key, its members, its example, its endpoint, how bad it is
    const [errorGroup, driftGroup] = r.json.groups;
    assert.match(errorGroup.key, /^[0-9a-f]{12}$/);
    assert.notEqual(errorGroup.key, driftGroup.key);
    assert.deepEqual([errorGroup.callIds, errorGroup.exampleCallId, errorGroup.endpoint, errorGroup.severity, errorGroup.signals],
      [['in-book'], 'in-book', 'POST /api/bookings', 0, ['LOG_ERROR']]);
    assert.deepEqual([driftGroup.callIds, driftGroup.exampleCallId, driftGroup.severity, driftGroup.signals], [['in-confirm'], 'in-confirm', 1, []]);
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

/** A cycle row as production has it: still running is an OUTBOUND call (an inbound one enters the cycle only when it is done). */
function addToCycle(w: { fake: FakeAlfred }, source: 'internal' | 'external', record: CallRecord): void {
  w.fake.addCall(source, record);
  w.fake.state.cycleEntries.get(CY)!.push({ capturedId: `cap-${record.id}`, capturedAt: record.timestamp, source, record });
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function runningSupplier(id: string, startedAgoMs: number): CallRecord {
  return { ...asRunning(outbound(id, 0, 'nobody', `/Slow/${id}`, {}, {})), timestamp: ago(startedAgoMs), parentCallId: undefined };
}

/** The record of a call that has not finished: no duration, no answer yet. */
function asRunning(record: CallRecord): CallRecord {
  return { ...record, state: 'IN_PROGRESS', duration_ms: undefined as unknown as number, response: undefined };
}

function finishedInbound(id: string, startedAgoMs: number, path = `/api/x/${id}`): CallRecord {
  return { ...inbound(id, 0, 'GET', path, undefined, {}), timestamp: ago(startedAgoMs) };
}

test('check_calls: a call running now ends a listen batch - the calls behind it wait for the next one', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    addToCycle(w, 'internal', finishedInbound('between', 4000));
    addToCycle(w, 'external', runningSupplier('slow-supplier', 3000));
    addToCycle(w, 'internal', finishedInbound('behind', 2000));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: 'in-view' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.checked, 1, 'only the call before the running one');
    assert.equal(r.json.lastCallId, 'between');
    assert.deepEqual(r.json.pending, [8], 'the running call, nothing else');
    assert.deepEqual(r.json.stale, []);
    assert.match(r.text, /1 still running \(next time\)/);
    assert.doesNotMatch(r.text, /Never completed/);

    // it finishes: it and the call behind it are the next batch
    const entry = w.fake.state.cycleEntries.get(CY)!.find((e) => e.record.id === 'slow-supplier')!;
    entry.record = { ...entry.record, state: 'COMPLETED', duration_ms: 2500, response: { status: 200, headers: {}, body: '{}' } } as CallRecord;
    const next = await w.call('check_calls', { cycle: CY, sinceCallId: r.json.lastCallId });
    assert.equal(next.json.checked, 2, next.text);
    assert.deepEqual(next.json.pending, []);
    assert.equal(next.json.lastCallId, 'behind');
  } finally { await w.close(); }
});

test('check_calls: a call that never completed is passed over, reported once, and checked when it does finish', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    // out-book was running when the cycle was recorded and never finished - it is minutes old by now
    const entries = w.fake.state.cycleEntries.get(CY)!;
    const hung = entries.find((e) => e.record.id === 'out-book')!;
    hung.record = asRunning(hung.record);
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.isError, false, first.text);
    // the calls behind it were checked: everything else but OPTIONS and the hung call itself
    assert.equal(first.json.checked, 5, first.text);
    assert.equal(first.json.lastCallId, 'in-view');
    assert.deepEqual(first.json.pending, [], 'it is not waited for - it is stale, not running');
    assert.equal(first.json.stale.length, 1);
    const [row] = first.json.stale;
    assert.deepEqual([row.callId, row.number, row.endpoint, row.startedAt], ['out-book', 5, 'POST /OrderCreate', at(46)]);
    assert.ok(row.ageSec > 300, `${row.ageSec}`);
    assert.match(first.text, /Never completed \(1\): #5 POST \/OrderCreate · running \d+ min · started 09:00:46/);
    // a finding of its own: a flagged group with the hung call as its example
    const group = first.json.groups.find((g: { exampleCallId: string }) => g.exampleCallId === 'out-book');
    assert.ok(group, first.text);
    assert.equal(group.severity, 0);
    assert.match(first.text, /G\d · 1 call · POST \/OrderCreate · never completed/);

    // asked again: still listed as never completed, but it is no group again - it has its outcome
    const again = await w.call('check_calls', { cycle: CY });
    assert.equal(again.json.stale.length, 1);
    assert.ok(!again.json.groups.some((g: { exampleCallId: string }) => g.exampleCallId === 'out-book'), again.text);
    assert.match(again.text, /Never completed \(1\): #5 /);

    // it finally completes: although it sits before sinceCallId, it is the next batch's late-comer
    hung.record = { ...hung.record, state: 'COMPLETED', duration_ms: 120, response: { status: 200, headers: {}, body: '{"order":{"pnr":"K7Q2ZP"}}' } } as CallRecord;
    addToCycle(w, 'internal', finishedInbound('after-hang', 1000));
    const late = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(late.json.checked, 2, late.text);
    assert.deepEqual(late.json.stale, []);
    assert.match(late.text, /#5 /);
    assert.equal(late.json.lastCallId, 'after-hang');
  } finally { await w.close(); }
});

test('check_calls sweep: a running call, young or hung, never cuts it - everything else is checked', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    const entries = w.fake.state.cycleEntries.get(CY)!;
    const hung = entries.find((e) => e.record.id === 'out-book')!;
    hung.record = asRunning(hung.record);
    addToCycle(w, 'external', runningSupplier('young-supplier', 1500));
    addToCycle(w, 'internal', finishedInbound('after-young', 500));
    const r = await w.call('check_calls', { cycle: CY, sweep: true });
    assert.equal(r.isError, false, r.text);
    // search, out-search, confirm, book, view and the call after the young one - not the two that are still running
    assert.equal(r.json.checked, 6, r.text);
    assert.deepEqual(r.json.pending, [7]);
    assert.deepEqual(r.json.stale.map((s: { callId: string }) => s.callId), ['out-book']);
    assert.equal(r.json.lastCallId, 'after-young');
  } finally { await w.close(); }
});

test('check_calls re-judges a call checked before its log lines arrived - in the next batch, with no new call and no sweep', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    const entries = w.fake.state.cycleEntries.get(CY)!;
    const view = entries.find((e) => e.record.id === 'in-view')!;
    // just captured: no mark yet, its ERROR line is still on its way
    view.record = { ...view.record, timestamp: new Date(Math.max(Date.now() - 1000, T + 80_000)).toISOString() } as CallRecord;
    w.fake.state.unmarked.add('in-view');
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.isError, false, first.text);
    assert.doesNotMatch(first.text, /GET \/api\/bookings\/:id/, 'checked by status only: looks clean');
    assert.equal(first.json.recheckPending, 1);
    assert.match(first.text, /Still settling \(1\)/);

    w.fake.state.unmarked.delete('in-view');
    w.fake.state.signals['in-view'] = { logErrors: 1 };
    const next = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(next.json.rechecked, 1, `${first.text}
=====
${next.text}`);
    assert.equal(next.json.flaggedCalls, 1, next.text);
    assert.match(next.text, /1 earlier call re-judged \(logs \/ SQL arrived late\)/);
    assert.match(next.text, /GET \/api\/bookings\/:id · .*LOG_ERROR/);

    // a later page of the same batch counts the same groups (the re-judged call stays in them)
    const page2 = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId, untilCallId: next.json.lastCallId, offset: 1 });
    assert.equal(page2.json.totalGroups, next.json.totalGroups, page2.text);

    // unchanged since: not reported again
    const again = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(again.json.rechecked ?? 0, 0, again.text);
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

test('wait_for_calls settleSec: a call still running is no reason to return - its end is', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    // a supplier call (the only kind a cycle holds while it runs), started a moment ago
    const record = runningSupplier('slow-1', 2_000);
    const entry = { capturedId: 'cap-slow', capturedAt: record.timestamp, source: 'external' as const, record };
    w.fake.state.cycleEntries.get(CY)!.push(entry);
    const idle = await w.call('wait_for_calls', { cycleId: CY, sinceCallId: 'in-view', timeoutSec: 2, settleSec: 1 });
    assert.equal(idle.json.timedOut, true, idle.text);

    const waiting = w.call('wait_for_calls', { cycleId: CY, sinceCallId: 'in-view', timeoutSec: 20, settleSec: 1 });
    for (let i = 0; i < 50 && w.fake.openSockets().length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    entry.record = { ...record, state: 'COMPLETED', duration_ms: 2_000, response: { status: 200, headers: {}, body: '{}' } };
    w.fake.broadcast('/ws/calls', JSON.stringify({ call: { id: 'slow-1', state: 'COMPLETED' }, capturedByCycleIds: [CY] }));
    const done = await waiting;
    assert.equal(done.json.timedOut, false);
    assert.deepEqual(done.json.newCalls.map((c: { id: string }) => c.id), ['slow-1']);
  } finally { await w.close(); }
});

test('check_calls waitSec: one call waits for the burst, checks it and brings the user\'s board changes', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    await w.call('check_calls', { cycle: CY });
    const waiting = w.call('check_calls', { cycle: CY, sinceCallId: 'in-view', waitSec: 20, settleSec: 1, boardCursor: 'now' });
    for (let i = 0; i < 50 && w.fake.openSockets().length < 4; i++) await new Promise((r) => setTimeout(r, 50));
    // the user's comment lands while the wait runs (the board's own cursor logic is the backend's; the fake answers what is set)
    w.fake.board.changes = {
      entries: [{ id: 3, actor: 'USER', kind: 'COMMENT', text: 'is the fare right?', oldValue: null, newValue: null, at: at(90),
        project: 'odeysys', number: 1, title: 'Fare', status: 'INBOX', cycleId: CY }],
      cycles: [], cursor: '3.1', more: false,
    };
    const record = { ...inbound('later-1', 80, 'GET', '/api/x/1', undefined, {}), response: { status: 500, headers: {}, body: '{}' } } as CallRecord;
    w.fake.state.cycleEntries.get(CY)!.push({ capturedId: 'cap-later', capturedAt: record.timestamp, source: 'internal', record });
    w.fake.broadcast('/ws/internal-calls', '{"type":"new-call"}');
    const r = await waiting;
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.checked, 1, r.text);
    assert.equal(r.json.flaggedCalls, 1);
    assert.equal(r.json.lastCallId, 'later-1');
    assert.deepEqual(r.json.board.changes, ['odeysys #1 "Fare" (INBOX) - 2026-10-13T09:01:30.000Z User: is the fare right?']);
    assert.equal(r.json.board.cursor, '3.1');
    assert.equal(w.fake.requests('GET', '/board/changes')[0].query.get('cycleId'), CY);
    assert.match((await w.call('check_calls', { cycle: CY, waitSec: 5 })).text, /waitSec waits for the calls after sinceCallId/);
  } finally { await w.close(); }
});

test('check_calls waitSec: a call checked too early wakes the wait when its log lines arrive', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    const view = w.fake.state.cycleEntries.get(CY)!.find((e) => e.record.id === 'in-view')!;
    view.record = { ...view.record, timestamp: new Date(Math.max(Date.now() - 1000, T + 80_000)).toISOString() } as CallRecord;
    w.fake.state.unmarked.add('in-view');
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.json.recheckPending, 1);
    const started = Date.now();
    const waiting = w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId, waitSec: 30, settleSec: 1 });
    for (let i = 0; i < 50 && w.fake.openSockets().length < 5; i++) await new Promise((r) => setTimeout(r, 50));
    w.fake.state.unmarked.delete('in-view');
    w.fake.state.signals['in-view'] = { logErrors: 1 };
    w.fake.broadcast('/ws/triage', '{"type":"marks-changed"}');
    const r = await waiting;
    assert.equal(r.json.rechecked, 1, r.text);
    assert.ok(Date.now() - started < 10_000, 'woken by the mark, not the 30 s timeout');
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ groups: what makes two flagged calls the same problem

function plainCycle(w: { fake: FakeAlfred }): void {
  w.fake.addCycle({ id: CY, name: 'Groups', status: 'RECORDING' });
}

function payment(id: string, s: number, status: number, extra: Partial<CallRecord> = {}): CallRecord {
  return { ...inbound(id, s, 'POST', '/api/pay', {}, {}), response: { status, headers: {}, body: '{}' }, ...extra };
}

function supplierCall(id: string, s: number, parent: string, host: string, status: number): CallRecord {
  return { ...outbound(id, s, parent, '/charge', {}, {}), url: `https://${host}/charge`, original_url: `https://${host}/charge`, response: { status, headers: {}, body: '{}' } };
}

function logLine(fake: FakeAlfred, id: string, level: string, message: string): void {
  fake.state.callLogs[id] = {
    setup: 'OK', matchedBy: 'CAUGHT', thread: 't', lines: [{
      sourceId: 's', sourceName: 'app', lineId: `l-${id}`, at: at(0), offsetMs: 5, level, thread: 't', logger: 'com.x.BookingService',
      message, matchedBy: 'CAUGHT', raw: message,
    }],
  };
}

const members = (r: { json: { groups: { calls: number[] }[] } }) => r.json.groups.map((g) => g.calls);

test('groups: the same endpoint answering 400 and 500 is two groups, even with no log lines to tell them apart', async () => {
  const w = await world();
  try {
    plainCycle(w);
    for (const [id, status] of [['p1', 400], ['p2', 500], ['p3', 400], ['p4', 500]] as const) addToCycle(w, 'internal', payment(id, Number(id[1]), status));
    const r = await w.call('check_calls', { cycle: CY });
    assert.equal(r.json.flaggedCalls, 4, r.text);
    assert.deepEqual(members(r), [[1, 3], [2, 4]], r.text);
  } finally { await w.close(); }
});

test('groups: a call with no saved mark is grouped by its exact status too', async () => {
  const w = await world();
  try {
    plainCycle(w);
    for (const [id, status] of [['p1', 400], ['p2', 500], ['p3', 400]] as const) {
      addToCycle(w, 'internal', payment(id, Number(id[1]), status));
      w.fake.state.unmarked.add(id);
    }
    const r = await w.call('check_calls', { cycle: CY });
    assert.deepEqual(members(r), [[1, 3], [2]], r.text);
  } finally { await w.close(); }
});

test('groups: a supplier that failed with 503 and one that failed with 400 are different problems; the same supplier twice is one', async () => {
  const w = await world();
  try {
    plainCycle(w);
    addToCycle(w, 'internal', payment('i1', 1, 200));
    addToCycle(w, 'external', supplierCall('s1', 2, 'i1', 'a.example.test', 503));
    addToCycle(w, 'internal', payment('i2', 3, 200));
    addToCycle(w, 'external', supplierCall('s2', 4, 'i2', 'b.example.test', 400));
    addToCycle(w, 'internal', payment('i3', 5, 200));
    addToCycle(w, 'external', supplierCall('s3', 6, 'i3', 'a.example.test', 503));
    const r = await w.call('check_calls', { cycle: CY });
    assert.equal(r.json.totalGroups, 2, r.text);
    assert.deepEqual(members(r), [[1, 5], [3]], r.text);
  } finally { await w.close(); }
});

test('groups: different database flags are different groups', async () => {
  const w = await world();
  try {
    plainCycle(w);
    for (let i = 1; i <= 3; i++) addToCycle(w, 'internal', payment(`d${i}`, i, 200));
    w.fake.state.signals['d1'] = { dbFlags: ['SLOW'] };
    w.fake.state.signals['d2'] = { dbFlags: ['REPEATED_QUERY'] };
    w.fake.state.signals['d3'] = { dbFlags: ['SLOW'] };
    const r = await w.call('check_calls', { cycle: CY });
    assert.deepEqual(members(r), [[1, 3], [2]], r.text);
  } finally { await w.close(); }
});

test('groups: two WARN texts are two groups, and the evidence shows the line that warned', async () => {
  const w = await world();
  try {
    plainCycle(w);
    for (let i = 1; i <= 3; i++) addToCycle(w, 'internal', payment(`w${i}`, i, 200));
    for (const id of ['w1', 'w2', 'w3']) w.fake.state.signals[id] = { logWarnings: 1 };
    logLine(w.fake, 'w1', 'WARN', "Cache miss for 'k1'");
    logLine(w.fake, 'w2', 'WARN', 'Retrying payment gateway');
    logLine(w.fake, 'w3', 'WARN', "Cache miss for 'k2'");
    const r = await w.call('check_calls', { cycle: CY });
    assert.deepEqual(members(r), [[1, 3], [2]], r.text);
    assert.match(r.text, /▤ 1 warning line\n\s+▤ WARN BookingService: Cache miss for 'k1' \(\+5 ms, l-w1\)/);
    assert.match(r.text, /▤ WARN BookingService: Retrying payment gateway/);
  } finally { await w.close(); }
});

test('groups: an error past the first 500 log lines of a call is found, and tells its group apart', async () => {
  const w = await world();
  try {
    plainCycle(w);
    for (const id of ['e1', 'e2']) {
      addToCycle(w, 'internal', payment(id, Number(id[1]), 200));
      w.fake.state.signals[id] = { logErrors: 1 };
      const lines = Array.from({ length: 1_100 }, (_, i) => ({
        sourceId: 's', sourceName: 'app', lineId: `${id}:${i}`, at: at(0), offsetMs: i, level: 'INFO', thread: 't', logger: 'com.x.Noise', message: 'tick', matchedBy: 'CAUGHT', raw: 'tick',
      }));
      lines.push({ sourceId: 's', sourceName: 'app', lineId: `${id}:last`, at: at(0), offsetMs: 2_000, level: 'ERROR', thread: 't', logger: 'com.x.BookingService',
        message: id === 'e1' ? 'Seat map unavailable' : 'Fare rules unavailable', matchedBy: 'CAUGHT', raw: 'x' });
      w.fake.state.callLogs[id] = { setup: 'OK', matchedBy: 'CAUGHT', thread: 't', lines };
    }
    const r = await w.call('check_calls', { cycle: CY });
    assert.equal(r.json.totalGroups, 2, 'two different errors, both beyond the first page of lines');
    assert.match(r.text, /Seat map unavailable/);
    assert.match(r.text, /Fare rules unavailable/);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ a call that was running

test('check_calls: a call that was the only thing running in the first check is the next batch\'s late-comer', async () => {
  const w = await world();
  try {
    plainCycle(w);
    addToCycle(w, 'external', runningSupplier('only', 3000));
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.json.checked, 0);
    assert.deepEqual(first.json.pending, [1]);
    assert.equal(first.json.lastCallId, 'only');
    const entry = w.fake.state.cycleEntries.get(CY)![0];
    entry.record = { ...entry.record, state: 'COMPLETED', duration_ms: 100, response: { status: 200, headers: {}, body: '{}' } } as CallRecord;
    const next = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(next.json.checked, 1, `it sits before sinceCallId, but it was never checked\n${next.text}`);
    assert.deepEqual(next.json.pending, []);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ Alfred's clock, and how long a call keeps settling

test('check_calls reads how long ago on Alfred\'s clock, not this machine\'s', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    w.fake.clockSkewMs = -3_600_000; // Alfred's clock is an hour behind this machine's
    const stamp = (ms: number) => new Date(Date.now() + w.fake.clockSkewMs - ms).toISOString();
    addToCycle(w, 'internal', { ...finishedInbound('between', 0), timestamp: stamp(4000) });
    addToCycle(w, 'external', { ...runningSupplier('running-now', 0), timestamp: stamp(3000) });
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: 'in-view' });
    assert.equal(r.isError, false, r.text);
    // two seconds old by Alfred's clock: it is running and ends the batch - not an hour-old call that hung
    assert.deepEqual(r.json.pending, [8], r.text);
    assert.deepEqual(r.json.stale, []);
    assert.equal(r.json.checked, 1);
    assert.equal(r.json.lastCallId, 'between');
  } finally { await w.close(); }
});

test('check_calls looks again at a call for 30 s after it ended, and at one with no mark for longer', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    addToCycle(w, 'internal', finishedInbound('ended-45s-ago', 45_000));
    addToCycle(w, 'internal', finishedInbound('ended-20s-ago', 20_000));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: 'in-view' });
    assert.equal(r.json.checked, 2);
    assert.equal(r.json.recheckPending, 1, 'only the call that ended 20 s ago is still settling');

    const lost = await world();
    try {
      seedFlow(lost.fake);
      addToCycle(lost, 'internal', finishedInbound('ended-45s-ago', 45_000));
      lost.fake.state.unmarked.add('ended-45s-ago');
      const u = await lost.call('check_calls', { cycle: CY, sinceCallId: 'in-view' });
      assert.equal(u.json.recheckPending, 1, 'no mark yet: its mark may still come');
    } finally { await lost.close(); }
  } finally { await w.close(); }
});

test('check_calls sweep: the calls still settling are judged again and stay settling', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    addToCycle(w, 'internal', finishedInbound('just-ended', 5000));
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.json.recheckPending, 1);
    const sweep = await w.call('check_calls', { cycle: CY, sweep: true });
    assert.equal(sweep.json.checked, 1, `unchanged, but not settled yet\n${sweep.text}`);
    assert.equal(sweep.json.recheckPending, 1, 'and still to be looked at again');
  } finally { await w.close(); }
});

test('check_calls sweep: a call that became slow, because its endpoint\'s usual time moved, is judged again', async () => {
  const w = await world();
  try {
    plainCycle(w);
    const ep = (id: string, s: number, ms: number) => ({ ...inbound(id, s, 'GET', `/api/ep/${id}`, undefined, {}), duration_ms: ms });
    addToCycle(w, 'internal', ep('ep-1', 1, 600));
    addToCycle(w, 'internal', ep('ep-2', 2, 600));
    addToCycle(w, 'internal', ep('ep-3', 3, 100));
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.json.flaggedCalls, 0, 'with a usual time of 600 ms, 600 ms is not slow');
    for (let i = 4; i <= 7; i++) addToCycle(w, 'internal', ep(`ep-${i}`, 10 + i, 100));
    const sweep = await w.call('check_calls', { cycle: CY, sweep: true });
    // the four new calls, and the two that are now six times the usual 100 ms
    assert.equal(sweep.json.checked, 6, sweep.text);
    assert.equal(sweep.json.flaggedCalls, 2);
    assert.match(sweep.text, /⏱ 600 ms \(6× the usual 100 ms/);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ the picture, in JSON

test('check_calls names what could not be captured for every project in the batch - not only for the flagged calls', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    addToCycle(w, 'internal', { ...finishedInbound('quiet-one', 400_000), service_name: 'core-service' });
    const r = await w.call('check_calls', { cycle: CY });
    assert.ok(Array.isArray(r.json.captureGaps));
    assert.ok(r.json.captureGaps.some((g: string) => /^odeysys: database statements are not captured/.test(g)), JSON.stringify(r.json.captureGaps));
    assert.ok(r.json.captureGaps.some((g: string) => /^core-service: log lines are not caught/.test(g)), 'core-service had only a clean call');
    assert.match(r.text, /Not all evidence is available - odeysys: /);
    assert.doesNotMatch(r.text, /Not all evidence is available[^\n]*core-service/, 'the text note is for the flagged calls');
  } finally { await w.close(); }
});

test('check_calls: each listener has its own memory of what it checked', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    await w.call('check_calls', { cycle: CY, listener: 'runner' });
    const same = await w.call('check_calls', { cycle: CY, sweep: true, listener: 'runner' });
    assert.equal(same.json.checked, 0, 'the runner checked everything');
    const other = await w.call('check_calls', { cycle: CY, sweep: true, listener: 'session' });
    assert.equal(other.json.checked, 6, 'another listener has not');
    const shared = await w.call('check_calls', { cycle: CY, sweep: true });
    assert.equal(shared.json.checked, 6, 'nor has the shared one');
    const alsoShared = await w.call('check_calls', { cycle: CY, sweep: true, listener: 'shared' });
    assert.equal(alsoShared.json.checked, 0, 'no listener and "shared" are one');
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ robustness

test('check_calls: a lastCallId that left the cycle continues after the time it had, instead of failing the listener', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.json.lastCallId, 'in-view');
    const entries = w.fake.state.cycleEntries.get(CY)!;
    entries.splice(entries.findIndex((e) => e.record.id === 'in-view'), 1);
    addToCycle(w, 'internal', finishedInbound('after-removal', 3000));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: 'in-view' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.checked, 1, r.text);
    assert.equal(r.json.resumed, true);
    assert.match(r.text, /the calls from \d\d:\d\d:\d\d on \(call in-view is no longer in the cycle\)/);
    assert.equal(r.json.lastCallId, 'after-removal');
    assert.match((await w.call('check_calls', { cycle: CY, sinceCallId: 'never-returned' })).text, /not in cycle/, 'an id no reply ever returned is still refused');
  } finally { await w.close(); }
});

test('check_calls in a new process: what is before sinceCallId counts as checked, so the next batch is not the whole cycle again', async () => {
  const w = await world();
  try {
    plainCycle(w);
    for (let i = 0; i < 30; i++) addToCycle(w, 'internal', { ...inbound(`c${i}`, i, 'POST', `/api/item/c${i}`, {}, {}) });
    // another listener's memory stands for a process that never saw the first batches
    const batch = await w.call('check_calls', { cycle: CY, sinceCallId: 'c19', listener: 'restarted' });
    assert.equal(batch.json.checked, 10, batch.text);
    addToCycle(w, 'internal', { ...inbound('c30', 30, 'POST', '/api/item/c30', {}, {}) });
    const next = await w.call('check_calls', { cycle: CY, sinceCallId: batch.json.lastCallId, listener: 'restarted' });
    assert.equal(next.json.checked, 1, `not 31: ${next.text}`);
  } finally { await w.close(); }
});

test('check_calls: bodies Alfred could not give are asked for again, then given up on - and "no body" is not "could not read"', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    w.fake.failing.set('/detail', { status: 500, times: 1_000 });
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.json.indexFailed, 6, first.text);
    assert.match(first.text, /Bodies not readable for 6 calls/);
    assert.doesNotMatch(first.text, /Δ/, 'nothing to compare yet');

    // Alfred answers again: the same calls are indexed now, and the drifts are there
    w.fake.failing.clear();
    const second = await w.call('check_calls', { cycle: CY });
    assert.equal(second.json.indexFailed, undefined, second.text);
    assert.match(second.text, /Δ changed departure/);

    // a call Alfred has no copy of (404) simply has no body: counted as that, not retried
    const gone = await world();
    try {
      seedFlow(gone.fake);
      gone.fake.failing.set('/detail', { status: 404, times: 1_000 });
      const r = await gone.call('check_calls', { cycle: CY });
      assert.equal(r.json.indexFailed, undefined);
      assert.match(r.text, /No JSON\/XML body \(5\)/, 'five of the six: in-book also wrote a row, which is a side of its own');
    } finally { await gone.close(); }
  } finally { await w.close(); }
});

test('check_calls gives up on a call whose bodies stay unreadable after three tries', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    w.fake.failing.set('/detail', { status: 500, times: 1_000 });
    for (let i = 0; i < 3; i++) await w.call('check_calls', { cycle: CY });
    w.fake.log.length = 0;
    const fourth = await w.call('check_calls', { cycle: CY });
    assert.equal(fourth.json.indexFailed, undefined, fourth.text);
    assert.equal(w.fake.requests('GET', '/detail').length, 0, 'not asked for a fourth time');
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ hop diffs

test('hop diffs: a group shows the diffs of all its members, each distinct one once - and the leads before the missing keys', async () => {
  const w = await world();
  try {
    plainCycle(w);
    const item = (id: string, s: number, itemId: string, qty: number) => inbound(id, s, 'POST', `/api/item/${id}`, { itemId, qty }, { itemId, qty });
    addToCycle(w, 'internal', item('base-1', 1, 'ITM-0x', 1));
    addToCycle(w, 'internal', item('base-2', 2, 'ITM-1x', 1));
    addToCycle(w, 'internal', item('base-3', 3, 'ITM-2x', 1));
    // three later calls on the same endpoint, each carrying one of those on with another quantity (two with the same)
    addToCycle(w, 'internal', item('new-1', 100, 'ITM-0x', 2));
    addToCycle(w, 'internal', item('new-2', 101, 'ITM-1x', 2));
    addToCycle(w, 'internal', item('new-3', 102, 'ITM-2x', 3));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: 'base-3' });
    assert.equal(r.json.totalGroups, 1, r.text);
    assert.deepEqual(members(r), [[4, 5, 6]]);
    const lines = r.text.split('\n').filter((l) => l.includes('Δ changed qty'));
    assert.equal(lines.length, 2, r.text);
    assert.match(lines[0], /: 1 \(#1 res qty\) → 2 \(#4 req qty\) via itm-0x · 2 calls$/);
    assert.match(lines[1], /: 1 \(#3 res qty\) → 3 \(#6 req qty\) via itm-2x$/);
  } finally { await w.close(); }
});

test('hop diffs: 200 lines by default, the leads first when they run out', async () => {
  const w = await world();
  try {
    plainCycle(w);
    const keys = Array.from({ length: 10 }, (_, i) => `field${String.fromCharCode(97 + i)}`);
    const body = (changed: number) => Object.fromEntries(keys.map((k, i) => [k, i < 8 ? (i < changed ? `new-${i}` : `old-${i}`) : `x-${i}`]));
    addToCycle(w, 'internal', inbound('first', 1, 'POST', '/api/doc/first', { docId: 'DOC-77' }, { docId: 'DOC-77', ...body(0) }));
    // later: the first five values changed, the last two keys are gone
    const later = body(5);
    delete later['fieldi'];
    delete later['fieldj'];
    addToCycle(w, 'internal', inbound('second', 2, 'POST', '/api/doc/second', { docId: 'DOC-77' }, { docId: 'DOC-77', ...later }));
    const all = await w.call('check_calls', { cycle: CY });
    assert.equal(all.text.split('\n').filter((l) => l.includes('Δ ')).length, 7, all.text);
    assert.doesNotMatch(all.text, /more hop diffs/);
    const few = await w.call('check_calls', { cycle: CY, maxDiffs: 5 });
    const shown = few.text.split('\n').filter((l) => l.includes('Δ '));
    assert.equal(shown.length, 5);
    assert.ok(shown.every((l) => l.includes('Δ changed')), `the changed values come before the missing keys\n${few.text}`);
    assert.match(few.text, /… 2 more hop diffs - check_calls with a higher maxDiffs/);
  } finally { await w.close(); }
});

test('hop diffs: a call whose capture says it is not complete is indexed anyway once it has had time to settle', async () => {
  const w = await world();
  try {
    seedFlow(w.fake);
    w.fake.state.captureProjects[0].enabled = true;
    // the capture of in-book never completes - it is a day old, nothing more will come
    w.fake.state.dbSummaries['in-book'] = { ...w.fake.state.dbSummaries['in-book'], complete: false };
    const r = await w.call('check_calls', { cycle: CY });
    assert.doesNotMatch(r.text, /Writes still arriving/);
    assert.match(r.text, /Δ changed faretotal: "437\.50" \(#4 req fare\.total\) → "412\.00" \(#4 db fare_total\)/);
  } finally { await w.close(); }
});

test('hop diffs: a call indexed late is compared with the call that follows it - and that call is reported again with only what is new', async () => {
  const w = await world();
  try {
    plainCycle(w);
    w.fake.state.captureProjects[0].enabled = true;
    const part = (id: string, agoMs: number, qty: number, service: string) => ({ ...finishedInbound(id, agoMs, `/api/part/${id}`), service_name: service,
      request: { headers: {}, body: JSON.stringify({ partId: 'PRT-77x', qty }) }, response: { status: 200, headers: {}, body: '{}' } });
    addToCycle(w, 'internal', part('part-1', 9_000, 1, 'core-service'));
    // part-2 is odeysys with its capture still arriving; part-3 came after it and is settled at once
    addToCycle(w, 'internal', part('part-2', 8_000, 2, 'odeysys'));
    addToCycle(w, 'internal', part('part-3', 7_000, 3, 'core-service'));
    w.fake.state.dbSummaries['part-2'] = { callId: 'part-2', statementCount: 1, writeCount: 0, deleteCount: 0, failedCount: 0, transactionCount: 0, rolledBackCount: 0,
      dbMicros: 10, droppedCount: 0, flags: [], lastSeq: 1, complete: false, endedEarly: false } as CallDbSummary;
    const first = await w.call('check_calls', { cycle: CY });
    assert.match(first.text, /Δ changed qty: 1 \(#1 req qty\) → 3 \(#3 req qty\) via prt-77x/, first.text);
    assert.match(first.text, /Writes still arriving for 1 call/);

    w.fake.state.dbSummaries['part-2'] = { ...w.fake.state.dbSummaries['part-2'], complete: true };
    const later = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.match(later.text, /Δ changed qty: 1 \(#1 req qty\) → 2 \(#2 req qty\) via prt-77x/, 'part-2 against part-1');
    assert.match(later.text, /Δ changed qty: 2 \(#2 req qty\) → 3 \(#3 req qty\) via prt-77x/, 'part-3 against part-2, which came between');
    assert.doesNotMatch(later.text, /1 \(#1 req qty\) → 3 \(#3 req qty\)/, 'what part-3 was reported with before is not said again');
    assert.deepEqual(later.json.lateWrites, [2, 3]);
    assert.match(later.text, /0 checked \(0 entries, 2 earlier calls reported again \(their writes arrived\)\)/);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------- specs/018: small ids, shapes, actions

test('flow diff: a small id links the calls that carry it, under its own name - and a filter is compared only with another endpoint', () => {
  const side = (callId: string, kind: Side['kind'], at: number, root: unknown, endpoint: string): Side => ({ callId, kind, at, root, endpoint });
  const a = analyseFlows([
    side('lookup', 'res', 1, { branches: [{ branchId: 948, name: 'Cairo', status: 'ACTIVE' }] }, 'GET /branches'),
    side('s1', 'req', 2, { branchId: 948, status: 'OPEN', page: 1 }, 'POST /search'),
    side('s1', 'res', 3, { payload: [{ branchId: 948, status: 'PENDING' }] }, 'POST /search'),
    side('s2', 'req', 4, { branchId: 948, status: 'CLOSED', page: 2 }, 'POST /search'),
    side('export', 'req', 5, { branchId: 948, status: 'OPEN', page: 2 }, 'POST /export'),
    side('other', 'req', 6, { typeId: 948, status: 'X' }, 'POST /other'),
  ]);
  const lines = a.diffs.map((d) => `${d.kind} ${d.key} ${d.from.callId}:${d.from.value} → ${d.to.callId}:${d.to.value}`);
  assert.deepEqual(lines, ['changed status s2:"CLOSED" → export:"OPEN"'], 'the export carried another filter than the search before it');
  assert.deepEqual(a.flows.map((f) => [...f.callIds].sort()), [['export', 'lookup', 's1', 's2']], 'typeId 948 is another thing');
});

test('flow diff: an id list links each of its ids; a bare small id and a status number link nothing', () => {
  const a = analyseFlows([
    { callId: 'a', kind: 'req', at: 1, root: { agencyIds: [949, 10646], id: 5, status: 1 } },
    { callId: 'b', kind: 'res', at: 2, root: { agencyId: 949, name: 'Agency A' } },
    { callId: 'c', kind: 'req', at: 3, root: { id: 5, status: 1 } },
  ]);
  assert.deepEqual(a.flows.map((f) => [...f.callIds].sort()), [['a', 'b']]);
});

test('request shape: field names and kinds, never values - a null field matches anything', async () => {
  const { shapeOf } = await import('../src/tools/check.ts');
  const old = shapeOf({ branchId: 948, agencyIds: [949], pnr: null });
  assert.equal(old, shapeOf({ branchId: 1, agencyIds: [], pnr: null }));
  assert.equal(old, shapeOf({ agencyIds: [1, 2], branchId: 5 }), 'a null field left out, key order does not matter');
  assert.notEqual(old, shapeOf({ branchIds: [948], agencyIds: [949] }), 'branchId → branchIds is a new request');
  assert.notEqual(shapeOf({ filter: { branchId: 1 } }), shapeOf({ filter: { branchIds: [1] } }), 'two levels deep');
  assert.equal(shapeOf('text'), null);
});

test('actions: the pause that ends one is learned - automation ms apart and a person seconds apart both split per action', async () => {
  const { actionGap, actionsOf } = await import('../src/tools/check.ts');
  const call = (id: string, ms: number, path = '/odeysysadmin/Booking2/search'): CallRecord =>
    ({ ...inbound(id, 0, 'POST', path, {}, {}), timestamp: new Date(T + ms).toISOString(), duration_ms: 20 });
  // automation: bursts of 3 calls 5 ms apart, bursts 400 ms apart
  const auto: CallRecord[] = [];
  for (let b = 0; b < 6; b++) for (let i = 0; i < 3; i++) auto.push(call(`a${b}${i}`, b * 400 + i * 25));
  const gap = actionGap(auto);
  assert.ok(gap >= 250 && gap < 300, `learned ${gap} ms`);
  const numbers = new Map(auto.map((c, i) => [c.id, i + 1]));
  assert.deepEqual(actionsOf(auto, [], gap, numbers).map((a) => a.calls), [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 18]]);
  // too few calls to learn from: 3 s, and another area starts an action on its own
  const person = [call('p1', 0), call('p2', 900), call('p3', 1000, '/odeysysadmin/Users/profile')];
  assert.equal(actionGap(person), 3_000);
  const acts = actionsOf(person, [], 3_000, new Map([['p1', 1], ['p2', 2], ['p3', 3]]));
  assert.deepEqual(acts.map((a) => a.calls), [[1, 2], [3]]);
  assert.equal(acts[1].reason, 'area Users');
});

test('check_calls: each group lists its calls\' request shapes, so a fine verdict on the old request is judged again on a new one', async () => {
  const w = await world();
  try {
    plainCycle(w);
    addToCycle(w, 'internal', { ...payment('p1', 1, 500), request: { headers: {}, body: JSON.stringify({ branchId: 948 }) } });
    addToCycle(w, 'internal', { ...payment('p2', 2, 500), request: { headers: {}, body: JSON.stringify({ branchIds: [948] }) } });
    const r = await w.call('check_calls', { cycle: CY });
    assert.deepEqual(members(r), [[1, 2]], r.text);
    const g = (r.json.groups as { shapes: string[] }[])[0];
    assert.equal(g.shapes.length, 2, r.text);
  } finally { await w.close(); }
});
