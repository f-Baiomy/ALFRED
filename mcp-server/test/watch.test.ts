import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlfredClient } from '../src/alfred-client.ts';
import type { CallRecord } from '../src/frontend.ts';
import { waitForCalls } from '../src/tools/watch.ts';
import { FakeAlfred } from './fake-alfred.ts';
import { world } from './harness.ts';

/**
 * What ends a wait (wait_for_calls, and check_calls' waitSec): the pause after a burst of calls, a failing call, a call
 * checked too early getting its late lines, the user's comment on the board - and what must not: messages that change
 * nothing for the cycle waited on.
 */

const CY = 'cy-watch';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function rec(id: string, agoMs: number, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    id, method: 'GET', timestamp: ago(agoMs), duration_ms: 50, state: 'COMPLETED', source: 'internal', service_name: 'odeysys',
    original_url: `http://localhost:8080/api/${id}`, url: `http://host.docker.internal:9001/api/${id}`,
    request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '{}' }, ...extra,
  };
}

function push(fake: FakeAlfred, record: CallRecord): void {
  fake.addCall(record.source ?? 'internal', record);
  fake.state.cycleEntries.get(CY)!.push({ capturedId: `cap-${record.id}`, capturedAt: record.timestamp, source: record.source ?? 'internal', record });
}

/** A call event as the backend broadcasts it: the call, and the recording cycles that captured it (none for a call only prepared). */
const event = (id: string, state: string, cycles: string[]) => JSON.stringify({ call: { id, state }, capturedByCycleIds: cycles });

/** Waits until the sockets a test will broadcast on are open - the others a wait opens may come first or last. */
async function sockets(fake: FakeAlfred, ...paths: string[]): Promise<void> {
  const open = () => paths.every((path) => fake.openSockets().includes(path));
  for (let i = 0; i < 200 && !open(); i++) await sleep(25);
  assert.ok(open(), `waited for ${paths.join(' ')}, open: ${fake.openSockets().join(' ')}`);
}

function running(id: string, agoMs: number): CallRecord {
  return { ...rec(id, agoMs), source: 'external', state: 'IN_PROGRESS', duration_ms: undefined as unknown as number, response: undefined };
}

async function cycleWorld(): Promise<Awaited<ReturnType<typeof world>>> {
  const w = await world();
  w.fake.addCycle({ id: CY, name: 'Watch', status: 'RECORDING' });
  push(w.fake, rec('base', 60_000));
  return w;
}

test('a pause is not started over by messages that change nothing for the cycle', async () => {
  const w = await cycleWorld();
  try {
    const started = Date.now();
    let doneAt = 0;
    const waiting = w.call('wait_for_calls', { cycleId: CY, sinceCallId: 'base', timeoutSec: 20, settleSec: 1 }).then((r) => { doneAt = Date.now(); return r; });
    await sockets(w.fake, '/ws/internal-calls', '/ws/session-cycles');
    push(w.fake, rec('first', 0));
    w.fake.broadcast('/ws/internal-calls', event('first', 'COMPLETED', [CY]));
    // for the next 3.6 s, one of each kind of message that is not a new call of this cycle
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      w.fake.broadcast('/ws/internal-calls', JSON.stringify({ type: 'ws-messages-appended', callId: 'some-socket-call' }));
      w.fake.broadcast('/ws/internal-calls', JSON.stringify({ type: 'calls-cleared' }));
      w.fake.broadcast('/ws/session-cycles', JSON.stringify({ type: 'cycle-updated', cycleId: CY }));
      w.fake.broadcast('/ws/internal-calls', event('elsewhere', 'COMPLETED', ['another-cycle']));
      w.fake.broadcast('/ws/internal-calls', event('still-going', 'IN_PROGRESS', []));
    }
    const r = await waiting;
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.newCalls.map((c: { id: string }) => c.id), ['first']);
    assert.equal(r.json.timedOut, false);
    // the call, 0.4 s to read it, a 1 s pause - not the 3.6 s of messages and a pause after them
    assert.ok(doneAt - started < 2_800, `returned after ${doneAt - started} ms`);
  } finally { await w.close(); }
});

test('a call another cycle captured, or one only prepared, makes no read of this cycle at all', async () => {
  const w = await cycleWorld();
  try {
    const waiting = w.call('wait_for_calls', { cycleId: CY, sinceCallId: 'base', timeoutSec: 3, settleSec: 1 });
    await sockets(w.fake, '/ws/internal-calls', '/ws/calls');
    const reads = () => w.fake.requests('GET', `/session-cycles/${CY}/`).length;
    const before = reads();
    for (let i = 0; i < 5; i++) {
      w.fake.broadcast('/ws/internal-calls', event('elsewhere', 'COMPLETED', ['another-cycle']));
      w.fake.broadcast('/ws/calls', event('prepared', 'IN_PROGRESS', []));
      w.fake.broadcast('/ws/internal-calls', JSON.stringify({ type: 'calls-cleared' }));
    }
    await sleep(1_000);
    assert.equal(reads(), before, 'nothing in them could be a new call of this cycle');
    // one that is does
    push(w.fake, rec('mine', 0));
    w.fake.broadcast('/ws/internal-calls', event('mine', 'COMPLETED', [CY]));
    const r = await waiting;
    assert.deepEqual(r.json.newCalls.map((c: { id: string }) => c.id), ['mine']);
  } finally { await w.close(); }
});

test('a burst that never pauses is returned a while after its first call', async () => {
  const w = await cycleWorld();
  try {
    const client = new AlfredClient(w.fake.url);
    const started = Date.now();
    const waiting = waitForCalls(client, CY, 'base', 30_000, 'any', 3_000, undefined, { burstMs: 2_000 });
    await sockets(w.fake, '/ws/internal-calls');
    let n = 0;
    const timer = setInterval(() => {
      const id = `b${n++}`;
      push(w.fake, rec(id, 0));
      w.fake.broadcast('/ws/internal-calls', event(id, 'COMPLETED', [CY]));
    }, 500);
    try {
      const r = await waiting;
      assert.equal(r.timedOut, false);
      assert.ok(r.newEntries.length >= 2, `${r.newEntries.length}`);
      // the pause (3 s) never came: the burst's own limit (2 s after its first call) did
      assert.ok(Date.now() - started < 6_000, `returned after ${Date.now() - started} ms`);
    } finally { clearInterval(timer); }
  } finally { await w.close(); }
});

test('a failing call ends the wait a second after it, not after the whole pause', async () => {
  const w = await cycleWorld();
  try {
    const client = new AlfredClient(w.fake.url);
    const started = Date.now();
    const waiting = waitForCalls(client, CY, 'base', 30_000, 'any', 8_000, undefined, { minStatus: 400 });
    await sockets(w.fake, '/ws/internal-calls');
    push(w.fake, rec('fine', 0));
    w.fake.broadcast('/ws/internal-calls', event('fine', 'COMPLETED', [CY]));
    await sleep(600);
    push(w.fake, rec('bad', 0, { response: { status: 500, headers: {}, body: '{}' } }));
    w.fake.broadcast('/ws/internal-calls', event('bad', 'COMPLETED', [CY]));
    const r = await waiting;
    assert.deepEqual(r.newEntries.map((e) => e.call.id), ['fine', 'bad']);
    assert.ok(Date.now() - started < 4_000, `returned after ${Date.now() - started} ms, the pause was 8 s`);
  } finally { await w.close(); }
});

test('a call running when the wait began counts as new when it finishes, wherever it sits', async () => {
  const w = await cycleWorld();
  try {
    const client = new AlfredClient(w.fake.url);
    const slow = running('slow', 3_000);
    push(w.fake, slow);
    push(w.fake, rec('after-slow', 2_000));
    const entry = w.fake.state.cycleEntries.get(CY)!.find((e) => e.record.id === 'slow')!;
    // since the call after it: the finished slow call is before sinceCallId
    const waiting = waitForCalls(client, CY, 'after-slow', 20_000, 'any', 600, undefined, { watch: new Set(['slow']) });
    await sockets(w.fake, '/ws/calls');
    entry.record = { ...slow, state: 'COMPLETED', duration_ms: 2_500, response: { status: 200, headers: {}, body: '{}' } };
    w.fake.broadcast('/ws/calls', event('slow', 'COMPLETED', [CY]));
    const r = await waiting;
    assert.deepEqual(r.newEntries.map((e) => e.call.id), ['slow']);
  } finally { await w.close(); }
});

test('check_calls waitSec: a call a review passed over, running then, ends the wait when it finishes and is checked', async () => {
  const w = await cycleWorld();
  try {
    const slow = running('slow', 3_000);
    push(w.fake, slow);
    push(w.fake, rec('after-slow', 2_000));
    const entry = w.fake.state.cycleEntries.get(CY)!.find((e) => e.record.id === 'slow')!;
    const first = await w.call('check_calls', { cycle: CY });
    assert.equal(first.json.lastCallId, 'after-slow');
    assert.deepEqual(first.json.pending, [2], first.text);
    const started = Date.now();
    const waiting = w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId, waitSec: 30, settleSec: 1 });
    await sockets(w.fake, '/ws/calls');
    entry.record = { ...slow, state: 'COMPLETED', duration_ms: 2_500, response: { status: 200, headers: {}, body: '{}' } };
    w.fake.broadcast('/ws/calls', event('slow', 'COMPLETED', [CY]));
    const r = await waiting;
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.checked, 1, r.text);
    assert.deepEqual(r.json.pending, []);
    assert.ok(Date.now() - started < 8_000, `${Date.now() - started} ms`);
  } finally { await w.close(); }
});

test('a wait with a pause passes over a call that hung, and stops at one that is still running', async () => {
  const w = await cycleWorld();
  try {
    const client = new AlfredClient(w.fake.url);
    push(w.fake, running('hung', 600_000));
    push(w.fake, rec('behind-the-hung-one', 1_000));
    const passed = await waitForCalls(client, CY, 'base', 5_000, 'any', 300);
    assert.deepEqual(passed.newEntries.map((e) => e.call.id), ['behind-the-hung-one']);

    const other = await world();
    try {
      other.fake.addCycle({ id: CY, name: 'Watch', status: 'RECORDING' });
      push(other.fake, rec('base', 60_000));
      push(other.fake, running('just-started', 3_000));
      push(other.fake, rec('behind-the-running-one', 1_000));
      const stopped = await waitForCalls(new AlfredClient(other.fake.url), CY, 'base', 1_500, 'any', 300);
      assert.equal(stopped.timedOut, true, 'it waits for the call that is running');
      assert.deepEqual(stopped.newEntries, []);
    } finally { await other.close(); }
  } finally { await w.close(); }
});

test('a wake is asked once the socket is open, so a change that came just before it is not lost', async () => {
  const w = await cycleWorld();
  try {
    const client = new AlfredClient(w.fake.url);
    const started = Date.now();
    const r = await waitForCalls(client, CY, 'base', 20_000, 'any', 0, { sockets: ['/ws/board'], changed: async () => true, label: 'the board changed' });
    assert.equal(r.woke, 'the board changed');
    assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms - no message was ever sent`);
  } finally { await w.close(); }
});

test('a wake whose socket is cut is asked every few seconds instead', async () => {
  const w = await cycleWorld();
  try {
    const client = new AlfredClient(w.fake.url);
    let changed = false;
    const started = Date.now();
    const waiting = waitForCalls(client, CY, 'base', 20_000, 'any', 0, { sockets: ['/ws/board'], changed: async () => changed, label: 'back' }, { fallbackMs: 600 });
    await sockets(w.fake, '/ws/board', '/ws/calls');
    w.fake.dropSockets();
    changed = true;
    const r = await waiting;
    assert.equal(r.woke, 'back');
    assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
  } finally { await w.close(); }
});

test('check_calls waitSec with a board cursor: the user\'s comment ends the wait', async () => {
  const w = await cycleWorld();
  try {
    const first = await w.call('check_calls', { cycle: CY });
    w.fake.board.changes = { entries: [], cycles: [], cursor: '7.0', more: false };
    const started = Date.now();
    const waiting = w.call('check_calls', { cycle: CY, sinceCallId: first.json.lastCallId, waitSec: 30, settleSec: 1, boardCursor: 'now' });
    await sockets(w.fake, '/ws/board');
    w.fake.board.changes = {
      entries: [{ id: 8, actor: 'USER', kind: 'COMMENT', text: 'why is this slow?', oldValue: null, newValue: null, at: ago(0), project: 'odeysys', number: 1, title: 'Slow', status: 'INBOX', cycleId: CY }],
      cycles: [], cursor: '7.1', more: false,
    };
    w.fake.broadcast('/ws/board', JSON.stringify({ type: 'board-changed' }));
    const r = await waiting;
    assert.equal(r.isError, false, r.text);
    assert.ok(Date.now() - started < 6_000, `${Date.now() - started} ms, not the 30 s`);
    assert.equal(r.json.waited, 'the board changed');
    assert.equal(r.json.board.changes.length, 1);
    // "now" was pinned once, and every ask after it was for the user's changes after that point, one entry is enough
    const asks = w.fake.requests('GET', '/board/changes');
    assert.equal(asks[0].query.get('cursor'), 'now');
    const probes = asks.filter((a) => a.query.get('limit') === '1').slice(1);
    assert.ok(probes.length >= 2, 'before the wait, when the socket opened, when the message came');
    for (const p of probes) {
      assert.equal(p.query.get('cursor'), '7.0');
      assert.equal(p.query.get('actor'), 'USER');
      assert.equal(p.query.get('cycleId'), CY);
    }
  } finally { await w.close(); }
});

test('the client knows Alfred\'s clock from the Date of its answers, and renews it every minute', async () => {
  const fake = await new FakeAlfred().start();
  const real = Date.now;
  try {
    fake.clockSkewMs = 600_000; // Alfred's clock is ten minutes ahead
    const client = new AlfredClient(fake.url);
    assert.ok(Math.abs(client.now() - Date.now()) < 100, 'before it has heard from Alfred it can only use its own');
    await client.get('/session-cycles');
    assert.ok(Math.abs(client.now() - (Date.now() + 600_000)) < 2_000, `${client.now() - Date.now()}`);
    // the first answer stays the offset until the minute is over
    fake.clockSkewMs = 0;
    await client.get('/session-cycles');
    assert.ok(Math.abs(client.now() - (Date.now() + 600_000)) < 2_000);
    // a minute later: Alfred's clock was set right meanwhile
    Date.now = () => real() + 61_000;
    await client.get('/session-cycles');
    assert.ok(Math.abs(client.now() - real()) < 2_000, `${client.now() - real()}`);
    // a difference inside the one-second resolution of the header is no difference
    Date.now = real;
    const same = new AlfredClient(fake.url);
    await same.get('/session-cycles');
    assert.ok(Math.abs(same.now() - Date.now()) < 5, `${same.now() - Date.now()}`);
  } finally {
    Date.now = real;
    await fake.stop();
  }
});
