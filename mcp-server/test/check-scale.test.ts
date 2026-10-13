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
    // it ended moments ago: its statements may still be on their way, whatever the capture says about being complete
    const book = { ...call('book', 1_000, '/api/book', { itemId: 'ITM-1x', price: '12.00' }, { ok: true }), timestamp: new Date(Date.now() - 2_000).toISOString() };
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
    // it was judged in the first check: here it is only reported again, and the header says so without counting backwards
    assert.deepEqual(later.json.lateWrites, [4]);
    assert.match(later.text, /: 0 checked \(0 entries, 1 earlier call reported again \(their writes arrived\)\)/);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ paging: one frozen batch

/** Forty different words for forty different errors (the fingerprint sets digits aside, so letters tell them apart). */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const kind = (i: number) => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));

/** Everything after the first page of a batch: no mark, log line, statement or body is read for it again. */
const reads = (fake: FakeAlfred, from: number) => fake.log.slice(from)
  .filter((r) => r.path === '/triage/calls' || r.path.startsWith('/call-logs/') || r.path.startsWith('/db-capture/') || r.path.includes('/detail')).length;

test('a sweep\'s 40 groups are all there across the pages, and each page counts the same 40', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 60);
    for (let i = 0; i < 40; i++) errorLine(w.fake, `c${i}`, `Failure kind ${kind(i)}`);
    const first = await w.call('check_calls', { cycle: CY, sweep: true, limit: 5 });
    assert.equal(first.json.totalGroups, 40, first.text);
    assert.equal(first.json.next, 5);
    const after = w.fake.log.length;
    const seen: string[] = first.json.groups.map((g: { exampleCallId: string }) => g.exampleCallId);
    let next: number | null = first.json.next;
    let pages = 1;
    while (next !== null) {
      const page = await w.call('check_calls', { cycle: CY, sweep: true, limit: 5, offset: next, untilCallId: first.json.lastCallId });
      assert.equal(page.isError, false, page.text);
      assert.equal(page.json.totalGroups, 40, `the page from group ${next + 1}\n${page.text}`);
      assert.equal(page.json.checked, first.json.checked);
      assert.deepEqual(page.json.groups.map((g: { group: string }) => g.group), Array.from({ length: 5 }, (_, i) => `G${next! + i + 1}`));
      seen.push(...page.json.groups.map((g: { exampleCallId: string }) => g.exampleCallId));
      next = page.json.next;
      pages++;
    }
    assert.equal(pages, 8);
    assert.equal(new Set(seen).size, 40, 'every group once');
    assert.equal(reads(w.fake, after), 0, 'the later pages are the first page\'s batch again, not another check');
  } finally { await w.close(); }
});

test('a sweep page asked for with no first page behind it judges the whole window again - not the nothing a sweep would find after a check', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 40);
    for (let i = 0; i < 40; i++) errorLine(w.fake, `c${i}`, `Failure kind ${kind(i)}`);
    await w.call('check_calls', { cycle: CY }); // everything is checked now: a plain sweep would have nothing to say
    const page = await w.call('check_calls', { cycle: CY, sweep: true, limit: 5, offset: 5, untilCallId: 'c39' });
    assert.equal(page.json.totalGroups, 40, page.text);
    assert.deepEqual(page.json.groups.map((g: { group: string }) => g.group), ['G6', 'G7', 'G8', 'G9', 'G10']);
  } finally { await w.close(); }
});

test('a listen batch with a late-comer and a late-write head is paged from one frozen batch; a mark that changes between pages moves nothing', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 12);
    w.fake.state.captureProjects[0].enabled = true;
    const young = (id: string, agoMs: number): CallRecord => ({ ...call(id, 0, `/api/new/${id}`, {}, {}), timestamp: ago(agoMs), service_name: 'core-service' });
    await w.call('check_calls', { cycle: CY });
    // book: it ended a moment ago and its statements are still on their way
    const book: CallRecord = { ...call('book', 0, '/api/book', { itemId: 'ITM-1x', price: '12.00' }, { ok: true }), timestamp: ago(2_000) };
    add(w.fake, book);
    const insert: CapturedStatement = {
      id: 1, callId: 'book', thread: 't', seq: 1, kind: 'INSERT', table: 'orders', fingerprint: 'f', sql: 'INSERT INTO orders (item_id, price) VALUES (?, ?)',
      params: [[{ type: 'VARCHAR', value: 'ITM-1x' }, { type: 'DECIMAL', value: '10.00' }]], outcome: { kind: 'UPDATED', affected: 1 },
      startedAt: ago(2_000), durationMicros: 10, offsetMicros: 10, undone: false, expected: false, storedRows: 0,
    };
    w.fake.state.statements['book'] = [insert];
    const summary = { callId: 'book', statementCount: 1, writeCount: 1, deleteCount: 0, failedCount: 0, transactionCount: 1, rolledBackCount: 0,
      dbMicros: 10, droppedCount: 0, flags: [], lastSeq: 1, complete: false, endedEarly: false } as CallDbSummary;
    w.fake.state.dbSummaries['book'] = summary;
    const a = await w.call('check_calls', { cycle: CY, sinceCallId: 'c11' });
    assert.equal(a.json.lastCallId, 'book');
    assert.match(a.text, /Writes still arriving for 1 call/);

    // a supplier call reported after its parent's batch but timed before it, then 25 calls with 25 different errors; book's capture completes
    add(w.fake, { ...call('late-supplier', 450, '/x', {}, {}), source: 'external', original_url: 'https://pay.example.test/charge', url: 'https://pay.example.test/charge',
      response: { status: 503, headers: {}, body: 'down' } }, 'external');
    for (let i = 0; i < 25; i++) {
      add(w.fake, young(`n${i}`, 1_900 - i));
      errorLine(w.fake, `n${i}`, `Failure kind ${kind(i)}`);
    }
    w.fake.state.dbSummaries['book'] = { ...summary, complete: true };

    const first = await w.call('check_calls', { cycle: CY, sinceCallId: a.json.lastCallId, limit: 5 });
    assert.equal(first.isError, false, first.text);
    // 25 new calls + the late supplier call are checked; book comes back with its diff
    assert.equal(first.json.checked, 26, first.text);
    assert.equal(first.json.totalGroups, 27, first.text);
    assert.deepEqual(first.json.lateWrites, [14]);
    const after = w.fake.log.length;
    const seen: string[] = first.json.groups.map((g: { exampleCallId: string }) => g.exampleCallId);
    // a mark changes between the pages
    errorLine(w.fake, 'n3', 'Something that was not there on the first page');
    let next: number | null = first.json.next;
    while (next !== null) {
      const page = await w.call('check_calls', { cycle: CY, sinceCallId: a.json.lastCallId, untilCallId: first.json.lastCallId, limit: 5, offset: next });
      assert.equal(page.json.totalGroups, 27, page.text);
      assert.equal(page.json.checked, 26);
      assert.deepEqual(page.json.lateWrites, [14]);
      assert.doesNotMatch(page.text, /Something that was not there/, 'the batch is the first page\'s');
      seen.push(...page.json.groups.map((g: { exampleCallId: string }) => g.exampleCallId));
      next = page.json.next;
    }
    assert.equal(new Set(seen).size, 27);
    assert.ok(seen.includes('late-supplier') && seen.includes('book') && seen.includes('n0') && seen.includes('n24'), seen.join(' '));
    assert.equal(reads(w.fake, after), 0);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ a call that never finishes, far back

test('a call that never finishes, far back in the cycle, does not make every read start there', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: CY, name: 'Long session', status: 'RECORDING' });
    const hung = { ...call('hung', 0, '/slow', {}, {}), source: 'external', state: 'IN_PROGRESS', duration_ms: undefined as unknown as number, response: undefined } as CallRecord;
    add(w.fake, hung, 'external');
    for (let i = 0; i < 450; i++) add(w.fake, { ...call(`s${i}`, 100 + i, `/supplier/${i}`, {}, {}), source: 'external' }, 'external');
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.isError, false, first.text);
    assert.deepEqual(first.json.stale.map((s: { callId: string }) => s.callId), ['hung']);

    w.fake.log.length = 0;
    add(w.fake, { ...call('s450', 99_999, '/supplier/450', {}, {}), source: 'external' }, 'external');
    const second = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(second.json.checked, 1, second.text);
    const outbound = w.fake.requests('GET', '/session-cycles/cy-big/calls').filter((r) => r.query.get('paged'));
    // the new tail from the last known call, and the hung call by its own id - not every page from the hung call on
    assert.equal(outbound.length, 2, outbound.map((r) => r.query.toString()).join('\n'));
    assert.deepEqual(outbound.filter((r) => !r.query.get('requestId')).map((r) => r.query.get('offset')), ['450'], 'the tail starts at the last known call');
    assert.equal(outbound.filter((r) => r.query.get('requestId') === 'hung').length, 1);

    // it finishes: the by-id read finds it, and it is the next batch's
    const entry = w.fake.state.cycleEntries.get(CY)!.find((e) => e.record.id === 'hung')!;
    entry.record = { ...entry.record, state: 'COMPLETED', duration_ms: 70, response: { status: 200, headers: {}, body: '{}' } } as CallRecord;
    const third = await w.call('check_calls', { cycle: CY, sinceCallId: second.json.lastCallId });
    assert.equal(third.json.checked, 1, third.text);
    assert.deepEqual(third.json.stale, []);
  } finally { await w.close(); }
});

// ------------------------------------------------------------------------------------------------ the wait for late writes

test('check_calls waitSec: a call whose writes are still arriving ends the wait when it has had time to settle, not when waitSec runs out', async () => {
  const w = await world();
  try {
    bigCycle(w.fake, 3);
    w.fake.state.captureProjects[0].enabled = true;
    // it ended nine seconds ago: unsettled for another second
    const book: CallRecord = { ...call('book', 0, '/api/book', { itemId: 'ITM-1x', price: '12.00' }, { ok: true }), timestamp: ago(9_000) };
    add(w.fake, book);
    const insert: CapturedStatement = {
      id: 1, callId: 'book', thread: 't', seq: 1, kind: 'INSERT', table: 'orders', fingerprint: 'f', sql: 'INSERT INTO orders (item_id, price) VALUES (?, ?)',
      params: [[{ type: 'VARCHAR', value: 'ITM-1x' }, { type: 'DECIMAL', value: '10.00' }]], outcome: { kind: 'UPDATED', affected: 1 },
      startedAt: ago(9_000), durationMicros: 10, offsetMicros: 10, undone: false, expected: false, storedRows: 0,
    };
    w.fake.state.statements['book'] = [insert];
    w.fake.state.dbSummaries['book'] = { callId: 'book', statementCount: 1, writeCount: 1, deleteCount: 0, failedCount: 0, transactionCount: 1, rolledBackCount: 0,
      dbMicros: 10, droppedCount: 0, flags: [], lastSeq: 1, complete: false, endedEarly: false } as CallDbSummary;
    const first = await w.call('check_calls', { cycle: CY });
    assert.match(first.text, /Writes still arriving for 1 call/);
    const started = Date.now();
    const later = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId, waitSec: 30, settleSec: 1 });
    assert.ok(Date.now() - started < 8_000, `woken by the clock, not after the 30 s: ${Date.now() - started} ms`);
    assert.match(later.text, /Δ changed price: "12\.00" \(#4 req price\) → "10\.00" \(#4 db price\) via itm-1x/);
    assert.equal(later.json.waited, 'late log lines / SQL arrived');
  } finally { await w.close(); }
});

test('a dropped index is rebuilt without reporting the old calls again', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: CY, name: 'Long session', status: 'RECORDING' });
    w.fake.state.captureProjects[0].enabled = true;
    // Two calls on one item, the second changes the quantity: a diff, reported by the first check. The first call also has a captured write,
    // so indexing it again takes longer than the second - which is then indexed before it, the order that makes it "follow" a call indexed late.
    add(w.fake, call('first', 100, '/api/item/first', { itemId: 'ITM-9x', qty: 1 }, {}));
    add(w.fake, call('second', 200, '/api/item/second', { itemId: 'ITM-9x', qty: 2 }, {}));
    const insert: CapturedStatement = {
      id: 7, callId: 'first', thread: 't', seq: 1, kind: 'INSERT', table: 'orders', fingerprint: 'f', sql: 'INSERT INTO orders (item_id, qty) VALUES (?, ?)',
      params: [[{ type: 'VARCHAR', value: 'ITM-9x' }, { type: 'INTEGER', value: '1' }]], outcome: { kind: 'UPDATED', affected: 1 },
      startedAt: at(100), durationMicros: 10, offsetMicros: 10, undone: false, expected: false, storedRows: 0,
    };
    w.fake.state.statements['first'] = [insert];
    w.fake.state.dbSummaries['first'] = { callId: 'first', statementCount: 1, writeCount: 1, deleteCount: 0, failedCount: 0, transactionCount: 1, rolledBackCount: 0,
      dbMicros: 10, droppedCount: 0, flags: [], lastSeq: 1, complete: true, endedEarly: false } as CallDbSummary;
    const first = await w.call('check_calls', { cycle: CY });
    assert.match(first.text, /Δ changed qty/);

    dropIndexesForTests();
    add(w.fake, call('third', 300, '/api/item/third', { itemId: 'ITM-8x', qty: 1 }, {}));
    const next = await w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId });
    assert.equal(next.json.checked, 1, next.text);
    assert.deepEqual(next.json.lateWrites, [], 'the calls the rebuilt index holds were judged long ago');
    assert.doesNotMatch(next.text, /Δ/);
  } finally { await w.close(); }
});
