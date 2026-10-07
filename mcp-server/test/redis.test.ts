import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CallStoreSummary, StoreCommandSummary } from '../src/frontend.ts';
import type { FakeState } from './fake-alfred.ts';
import { world } from './harness.ts';
import { IN1, IN2 } from './fixtures.ts';

/** Claude's Redis tools (specs/011-redis-capture, contracts/export-and-mcp.md). */

const cmd = (seq: number, over: Partial<StoreCommandSummary> = {}): StoreCommandSummary => ({
  id: 100 + seq, store: 'redis', seq, at: '2026-10-05T01:00:00.000Z', micros: 400, command: 'GET', keys: [`fare:rule:${seq}`], keysTotal: 1,
  rw: 'r', outcome: 'HIT', replyType: 'BULK', replyPreview: '{"fare":1}', bytes: 20, replyBytes: 40, hasBefore: false,
  code: 'com.tt.FareRuleService.load(FareRuleService.java:57)', client: 'lettuce 6.8.2', ...over,
});

const summary = (over: Partial<CallStoreSummary> = {}): CallStoreSummary => ({
  callId: IN1, project: 'odeysys', commands: 6, reads: 5, writes: 1, hits: 3, misses: 2, failed: 1, micros: 2400, dropped: 0, live: false, endedEarly: false, ...over,
});

function seed(state: FakeState): void {
  state.redis[IN1] = {
    commands: [
      cmd(1), cmd(2), cmd(3, { outcome: 'MISS', replyPreview: '(nil)' }),
      cmd(5, { outcome: 'MISS', keys: ['airport:DXB'], replyPreview: '(nil)' }),
      cmd(6, { command: 'SET', rw: 'w', outcome: 'OK', keys: ['session:abc'], argsText: 'token=sk_live_SECRET_123' }),
      cmd(7, { command: 'HGET', outcome: 'FAILED', error: 'WRONGTYPE Operation against a key holding the wrong kind of value' }),
    ],
    cold: [5],
    summary: summary(),
    details: {
      106: {
        row: cmd(6, { command: 'SET', rw: 'w', outcome: 'OK', keys: ['session:abc'] }), args: ['session:abc', '{"user":948}', 'EX', '900'], resp: 2,
        value: { format: 'json', text: '{"user":948}', partial: false, masked: false, bytes: 12 },
        writtenBy: { callId: 'in-earlier', seq: 4, at: '2026-10-05T00:59:00Z', method: 'POST', path: '/login' } as never,
      },
    },
    keys: [{ pattern: 'fare:rule:*', commands: 3, reads: 3, writes: 0, hits: 2, misses: 1, failed: 0, micros: 1200, lastWriter: null }],
  };
  state.redisHistory = [
    { callId: 'in-earlier', seq: 4, op: 'w', command: 'SET', at: '2026-10-05T00:59:00Z', outcome: 'OK', method: 'POST', path: '/login', status: 200 },
    { callId: IN1, seq: 6, op: 'w', command: 'SET', at: '2026-10-05T01:00:00Z', outcome: 'OK', method: 'POST', path: '/search', status: 200, sameValueAsPrevious: true },
  ];
}

test('redis_commands: in order, filtered, cold misses marked, Spring Cache / groups carried; a call without ⬢ says why', async () => {
  const w = await world();
  try {
    seed(w.fake.state);
    const all = await w.call('redis_commands', { callId: IN1 });
    assert.equal(all.isError, false, all.text);
    assert.deepEqual(all.json.commands.map((c: { seq: number }) => c.seq), [1, 2, 3, 5, 6, 7]);
    const misses = await w.call('redis_commands', { callId: IN1, filter: 'misses' });
    assert.deepEqual(misses.json.commands.map((c: { seq: number }) => c.seq), [3, 5]);
    assert.equal(misses.json.commands[1].cacheCold, true);
    const failed = await w.call('redis_commands', { callId: IN1, filter: 'failed' });
    assert.match(failed.json.commands[0].reply, /WRONGTYPE/);
    const byKey = await w.call('redis_commands', { callId: IN1, key: 'airport' });
    assert.equal(byKey.json.total, 1);
    const none = await w.call('redis_commands', { callId: IN2 });
    assert.equal(none.json.error, 'not_found');
    assert.match(none.json.message, /⬢ switch/);
  } finally { await w.close(); }
});

test('redis_commands commandId: the value decoded by Alfred, who wrote the key before', async () => {
  const w = await world();
  try {
    seed(w.fake.state);
    const r = await w.call('redis_commands', { callId: IN1, commandId: 106 });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.args, ['session:abc', '{"user":948}', 'EX', '900']);
    assert.equal(r.json.value.format, 'json');
    assert.equal(r.json.value.text, '{"user":948}');
    assert.equal(r.json.writtenBy.callId, 'in-earlier');
  } finally { await w.close(); }
});

test('redis_overview: counts, hit rate, key patterns and the window\'s findings', async () => {
  const w = await world();
  try {
    seed(w.fake.state);
    const r = await w.call('redis_overview', { callId: IN1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.commands, 6);
    assert.equal(r.json.hitRatePercent, 50);
    assert.equal(r.json.cacheCold, 1);
    assert.equal(r.json.keyPatterns[0].pattern, 'fare:rule:*');
    const titles = r.json.findings.map((f: { title: string }) => f.title);
    assert.ok(titles.includes('Redis command failed'), titles.join(' | '));
    assert.ok(titles.includes('Cache cold'), titles.join(' | '));
    assert.ok(titles.some((t: string) => /GETs one by one/.test(t)), titles.join(' | '));
  } finally { await w.close(); }
});

test('redis_key_history: every recorded call that touched the key', async () => {
  const w = await world();
  try {
    seed(w.fake.state);
    const r = await w.call('redis_key_history', { key: 'session:abc', project: 'odeysys' });
    assert.equal(r.json.total, 2);
    assert.equal(r.json.history[1].sameValueAsPrevious, true);
  } finally { await w.close(); }
});

test('investigate_call carries the call\'s Redis at a glance', async () => {
  const w = await world();
  try {
    seed(w.fake.state);
    const r = await w.call('investigate_call', { callId: IN1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.redis.failed, 1);
    assert.match(r.json.redis.next, /redis_overview/);
  } finally { await w.close(); }
});
