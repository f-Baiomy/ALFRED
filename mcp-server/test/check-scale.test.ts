import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallDbSummary, CallRecord, CapturedStatement } from '../src/frontend.ts';
import { dropIndexesForTests } from '../src/tools/check.ts';
import type { FakeAlfred } from './fake-alfred.ts';
import { world } from './harness.ts';

/**
 * check_calls at the size of a long listening session: each batch costs what the first did, the same problem on
 * hundreds of calls is one group, and none of the shortcuts loses a call or a diff.
 */

const T = Date.now() - 3_600_000;
const at = (ms: number) => new Date(T + ms).toISOString();
const CY = 'cy-big';

function call(id: string, ms: number, path: string, req: unknown, res: unknown, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    id, method: 'POST', timestamp: at(ms), duration_ms: 50, state: 'COMPLETED', source: 'internal', service_name: 'odeysys',
    original_url: `http://localhost:8080${path}`, url: `http://host.docker.internal:9001${path}`,
    request: { headers: {}, body: JSON.stringify(req) }, response: { status: 200, headers: {}, body: JSON.stringify(res) }, ...extra,
  };
}

function add(fake: FakeAlfred, record: CallRecord, source: 'internal' | 'external' = 'internal'): void {
  fake.addCall(source, record);
  fake.state.cycleEntries.get(CY)!.push({ capturedId: `cap-${record.id}`, capturedAt: record.timestamp, source, record });
}

function errorLine(fake: FakeAlfred, id: string, message: string, type = 'java.lang.IllegalStateException'): void {
  fake.state.signals[id] = { logErrors: 1 };
  fake.state.callLogs[id] = {
    setup: 'OK', matchedBy: 'CAUGHT', thread: 't', lines: [{
      sourceId: 's', sourceName: 'app', lineId: `l-${id}`, at: at(0), offsetMs: 5, level: 'ERROR', thread: 't', logger: 'com.x.BookingService',
      message, matchedBy: 'CAUGHT', raw: message, exception: { type, message, stack: null },
    }],
  };
}

function bigCycle(fake: FakeAlfred, n: number): void {
  fake.addCycle({ id: CY, name: 'Long session', status: 'RECORDING' });
  for (let i = 0; i < n; i++) {
    add(fake, call(`c${i}`, i * 100, `/api/item/${i}`, { itemId: `ITM-${i}x`, qty: 1 }, { itemId: `ITM-${i}x`, qty: 1, price: '10.00' }));
  }
}

test('9,000 calls: a batch after them costs one page per source and reads only its own bodies', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 9_000);
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.isError, false, first.text);
    assert.equal(first.json.checked, 9_000);
    assert.equal(first.json.clean, 9_000);

    for (let i = 0; i < 5; i++) add(w.fake, call(`n${i}`, 1_000_000 + i, `/api/item/n${i}`, { itemId: `ITM-${i}x`, qty: 2 }, {}));
    w.fake.log.length = 0;
    const batch = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(batch.json.checked, 5);
    assert.equal(w.fake.requests('GET', '/detail').length, 5, 'only the new calls\' bodies are read');
    const pages = w.fake.requests('GET', '/session-cycles/cy-big/').filter((r) => r.query.get('paged'));
    assert.ok(pages.length <= 4, `listing the cycle again took ${pages.length} requests`);
    // the new calls carry ITM-0x..ITM-4x on with another qty: the earlier calls still serve as where it came from
    assert.match(batch.text, /Δ changed qty: 1 \(#1 res qty\) → 2 \(#9001 req qty\) via itm-0x/);
  } finally { await w.close(); }
});

test('the same error on 500 calls is one group, a different error on the same endpoint another', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 600);
    for (let i = 0; i < 500; i++) errorLine(w.fake, `c${i}`, `Booking ${1000 + i} failed for agency ${i % 7}`);
    errorLine(w.fake, 'c550', 'Connection pool exhausted', 'java.sql.SQLTransientConnectionException');
    const r = await w.call('check_calls', { cycle: CY });
    assert.equal(r.json.flaggedCalls, 501);
    assert.equal(r.json.totalGroups, 2);
    assert.match(r.text, /G1 · 500 calls · POST \/api\/item\/:id · LOG_ERROR/);
    assert.match(r.text, /all 500: #1-#200 … \+300 more \(last #500\)/);
    assert.match(r.text, /G2 · 1 call · POST \/api\/item\/:id · LOG_ERROR[\s\S]*Connection pool exhausted/);
    assert.ok(r.text.length < 16_000);
  } finally { await w.close(); }
});

test('groups are paged with the window held still', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 40);
    for (let i = 0; i < 30; i++) errorLine(w.fake, `c${i}`, `Failure kind ${'abcdefghijklmnopqrstuvwxyzABCD'[i]}`);
    const p1 = await w.call('check_calls', { cycle: CY, limit: 10 });
    assert.equal(p1.json.totalGroups, 30);
    assert.equal(p1.json.next, 10);
    add(w.fake, call('later', 999_999, '/api/x', {}, {}));
    const p2 = await w.call('check_calls', { cycle: CY, limit: 10, offset: 10, untilCallId: p1.json.lastCallId });
    assert.deepEqual(p2.json.groups.map((g: { group: string }) => g.group), ['G11', 'G12', 'G13', 'G14', 'G15', 'G16', 'G17', 'G18', 'G19', 'G20']);
    assert.equal(p2.json.checked, 40, 'the call that arrived meanwhile is not in this window');
  } finally { await w.close(); }
});

test('a supplier call captured after its batch but timed before it is still checked', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 10);
    const first = await w.call('check_calls', { cycle: CY });
    const late: CallRecord = {
      ...call('late-supplier', 450, '/x', {}, {}), source: 'external', original_url: 'https://pay.example.test/charge', url: 'https://pay.example.test/charge',
      response: { status: 503, headers: {}, body: 'down' },
    };
    add(w.fake, late, 'external');
    add(w.fake, call('next', 5_000, '/api/next', {}, {}));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(r.json.checked, 2);
    assert.match(r.text, /OUT POST https:\/\/pay\.example\.test\/charge → 503/);
  } finally { await w.close(); }
});

test('a call removed from the cycle makes the next read start over, not skip one', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 10);
    const first = await w.call('check_calls', { cycle: CY });
    const entries = w.fake.state.cycleEntries.get(CY)!;
    entries.splice(entries.findIndex((e) => e.record.id === 'c3'), 1);
    add(w.fake, call('after-removal', 5_000, '/api/x', {}, {}));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(r.json.checked, 1);
    assert.match(r.text, /Clean \(1\): #10/, 'numbered from the cycle as it is now');
  } finally { await w.close(); }
});

test('a dropped index loses no diff: the bodies are read again from Alfred', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 10);
    const first = await w.call('check_calls', { cycle: CY });
    dropIndexesForTests();
    add(w.fake, call('drift', 5_000, '/api/x', { itemId: 'ITM-3x', qty: 9 }, {}));
    const r = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.match(r.text, /Δ changed qty: 1 \(#4 res qty\) → 9 \(#11 req qty\) via itm-3x/);
  } finally { await w.close(); }
});

test('the sweep re-judges only the calls whose mark changed since they were checked', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 50);
    await w.call('check_calls', { cycle: CY });
    errorLine(w.fake, 'c20', 'Mail not sent');
    w.fake.log.length = 0;
    const r = await w.call('check_calls', { cycle: CY, sweep: true });
    assert.match(r.text, /sweep .*: 1 checked .*49 unchanged since checked/);
    assert.match(r.text, /G1 · 1 call[\s\S]*Mail not sent/);
    assert.equal(w.fake.requests('GET', '/detail').length, 0, 'no body read again');
    assert.match((await w.call('check_calls', { cycle: CY, sweep: true, sinceCallId: 'c1' })).text, /sweep or sinceCallId/);
  } finally { await w.close(); }
});

test('a call whose statements are still arriving gets its diffs in a later check, not never', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 3);
    w.fake.state.captureProjects[0].enabled = true;
    const book = call('book', 1_000, '/api/book', { itemId: 'ITM-1x', price: '12.00' }, { ok: true });
    add(w.fake, book);
    const insert: CapturedStatement = {
      id: 1, callId: 'book', thread: 't', seq: 1, kind: 'INSERT', table: 'orders', fingerprint: 'f', sql: 'INSERT INTO orders (item_id, price) VALUES (?, ?)',
      params: [[{ type: 'VARCHAR', value: 'ITM-1x' }, { type: 'DECIMAL', value: '10.00' }]], outcome: { kind: 'UPDATED', affected: 1 },
      startedAt: at(1_000), durationMicros: 10, offsetMicros: 10, undone: false, expected: false, storedRows: 0,
    };
    w.fake.state.statements['book'] = [insert];
    const summary = { callId: 'book', statementCount: 1, writeCount: 1, deleteCount: 0, failedCount: 0, transactionCount: 1, rolledBackCount: 0,
      dbMicros: 10, droppedCount: 0, flags: [], lastSeq: 1, complete: false, endedEarly: false } as CallDbSummary;
    w.fake.state.dbSummaries['book'] = summary;
    const first = await w.call('check_calls', { cycle: CY });
    assert.match(first.text, /Writes still arriving for 1 call/);
    assert.doesNotMatch(first.text, /db price/);

    w.fake.state.dbSummaries['book'] = { ...summary, complete: true };
    const later = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.match(later.text, /Δ changed price: "12\.00" \(#4 req price\) → "10\.00" \(#4 db price\) via itm-1x/);
  } finally { await w.close(); }
});
