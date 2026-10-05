import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';
import { CYCLE, IN1, IN2, OUT1, OUT2 } from './fixtures.ts';

test('create_cycle from live calls: one cycle, paused, full records copied to the right endpoint per direction', async () => {
  const w = await world();
  try {
    const r = await w.call('create_cycle', { name: 'fan-out repro', calls: [{ id: IN1 }, { id: OUT2, direction: 'outbound' }] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.cycle.status, 'PAUSED', 'Alfred creates cycles recording; a cycle built from chosen calls is paused');
    assert.deepEqual(r.json.copy, { added: 2, skipped: 0, notFound: [] });
    const inbound = w.fake.requests('POST', '/internal-calls/copy');
    const outbound = w.fake.requests('POST', `/session-cycles/${r.json.cycle.id}/calls/copy`);
    assert.equal(inbound.length, 1);
    assert.equal(outbound.length, 1);
    const copied = inbound[0].body.calls[0];
    assert.equal(copied.id, IN1);
    assert.ok(copied.request?.body && copied.response?.body, 'hydrated with request and response');
    assert.equal(w.fake.requests('POST', '/session-cycles').filter((q) => q.path === '/session-cycles').length, 1);
  } finally { await w.close(); }
});

test('create_cycle record:true leaves it recording', async () => {
  const w = await world();
  try {
    const r = await w.call('create_cycle', { name: 'live', record: true });
    assert.equal(r.json.cycle.status, 'RECORDING');
  } finally { await w.close(); }
});

test('a batch with an unknown id reports it and copies the rest; a call already in the cycle is skipped', async () => {
  const w = await world();
  try {
    const r = await w.call('add_calls_to_cycle', { cycleId: CYCLE, calls: [{ id: OUT2 }, { id: 'no-such-call' }, { id: OUT1 }] });
    assert.deepEqual(r.json, { added: 1, skipped: 1, notFound: ['no-such-call'] });
  } finally { await w.close(); }
});

test('remove maps call ids to the cycle\'s own entry ids, grouped by direction', async () => {
  const w = await world();
  try {
    const r = await w.call('remove_calls_from_cycle', { cycleId: CYCLE, calls: [{ id: IN2 }, { id: OUT1 }, { id: 'not-there' }] });
    assert.deepEqual(r.json, { removed: 2, notFound: ['not-there'] });
    assert.deepEqual(w.fake.requests('POST', '/internal-calls/remove')[0].body, { callIds: [`cap-${IN2}`] });
    assert.deepEqual(w.fake.requests('POST', `/session-cycles/${CYCLE}/calls/remove`)[0].body, { callIds: [`cap-${OUT1}`] });
    assert.equal(w.fake.state.cycleEntries.get(CYCLE)!.length, 1);
  } finally { await w.close(); }
});

test('rename_cycle', async () => {
  const w = await world();
  try {
    const r = await w.call('rename_cycle', { cycleId: CYCLE, name: 'payment 500 root cause' });
    assert.equal(r.json.name, 'payment 500 root cause');
  } finally { await w.close(); }
});

test('spacers: anchor is the call above plus its own timestamp; top is null/null; move, rename, delete', async () => {
  const w = await world();
  try {
    const out1 = w.fake.state.cycleEntries.get(CYCLE)!.find((e) => e.record.id === OUT1)!.record;
    const added = await w.call('add_spacer', { cycleId: CYCLE, label: 'search', afterCallId: OUT1 });
    assert.equal(added.json.afterCallId, OUT1);
    assert.equal(added.json.anchorTimestamp, out1.timestamp);
    const top = await w.call('add_spacer', { cycleId: CYCLE, label: 'start', afterCallId: 'top' });
    assert.equal(top.json.afterCallId, null);
    assert.equal(top.json.anchorTimestamp, null);
    const moved = await w.call('move_spacer', { cycleId: CYCLE, spacerId: added.json.id, afterCallId: IN2 });
    assert.equal(moved.json.afterCallId, IN2);
    const outside = await w.call('move_spacer', { cycleId: CYCLE, spacerId: added.json.id, afterCallId: OUT2 });
    assert.equal(outside.json.error, 'invalid');
    const renamed = await w.call('rename_spacer', { cycleId: CYCLE, spacerId: added.json.id, label: 'pay' });
    assert.equal(renamed.json.label, 'pay');
    assert.equal((await w.call('delete_spacer', { cycleId: CYCLE, spacerId: top.json.id })).json.deleted, true);
    assert.equal(w.fake.state.spacers.get(CYCLE)!.length, 1);
  } finally { await w.close(); }
});

test('no tool ever deletes or clears a cycle (FR-019)', async () => {
  const w = await world();
  try {
    await w.call('remove_calls_from_cycle', { cycleId: CYCLE, calls: [{ id: IN1 }, { id: IN2 }, { id: OUT1 }] });
    await w.call('rename_cycle', { cycleId: CYCLE, name: 'x' });
    assert.equal(w.fake.log.filter((r) => r.method === 'DELETE' && /^\/session-cycles\/[^/]+$/.test(r.path)).length, 0);
    assert.equal(w.fake.requests('POST', '/calls/clear').length, 0);
    assert.ok(w.fake.state.cycles.some((c) => c.id === CYCLE));
  } finally { await w.close(); }
});
