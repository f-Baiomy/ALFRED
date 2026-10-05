import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';
import { BIN, IN2, OUT1, T0 } from './fixtures.ts';

const ids = (r: { json: { calls: { id: string }[] } }) => r.json.calls.map((c) => c.id);

test('failed odeysys calls in a time window, newest first', async () => {
  const w = await world();
  try {
    const r = await w.call('search_calls', { project: 'odeysys', failed: true, from: new Date(T0 - 60_000).toISOString() });
    assert.deepEqual(ids(r), [IN2]);
    assert.ok(!w.fake.log.some((q) => q.path === '/calls'), 'a project search does not scan outbound');
  } finally { await w.close(); }
});

test('status class, exact status, slow, supplier, text', async () => {
  const w = await world();
  try {
    assert.deepEqual(ids(await w.call('search_calls', { status: '5xx' })), [IN2]);
    assert.ok(ids(await w.call('search_calls', { status: 404, limit: 50 })).every((id) => id.startsWith('in-old-')));
    const slow = await w.call('search_calls', { slowMs: 6000, limit: 50 });
    assert.ok(ids(slow).includes(IN2) && !ids(slow).includes(BIN));
    const supplier = await w.call('search_calls', { direction: 'outbound', supplier: 'ndc.example.test' });
    assert.ok(ids(supplier).includes(OUT1));
    assert.deepEqual(ids(await w.call('search_calls', { text: 'payment failed' })), [IN2]);
  } finally { await w.close(); }
});

test('both directions merge by time; pages never repeat', async () => {
  const w = await world();
  try {
    const seen: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await w.call('search_calls', { offset, limit: 7 });
      assert.equal(page.isError, false, page.text);
      seen.push(...ids(page));
      offset = page.json.nextOffset;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.length, w.fake.state.calls.length);
    const times = seen.map((id) => Date.parse(w.fake.state.calls.find((c) => c.record.id === id)!.record.timestamp));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  } finally { await w.close(); }
});

test('the scan cap is reported', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 2100; i++) {
      w.fake.addCall('internal', { ...w.fake.state.calls[0].record, id: `bulk-${i}`, timestamp: new Date(T0 - 10_000_000 - i).toISOString(), response: { status: 200 } });
    }
    const r = await w.call('search_calls', { direction: 'inbound', status: 418 });
    assert.equal(r.json.scanCapHit, true);
    assert.equal(r.json.scanned, 2000);
  } finally { await w.close(); }
});

test('method+url for 100 calls is at least 10x smaller than full rows of the same calls (SC-010)', async () => {
  const w = await world();
  try {
    // Still far below the ~28-38 KB a real recorded call averages (constitution II).
    const body = JSON.stringify({ offers: Array.from({ length: 60 }, (_, i) => ({ id: i, fare: 100 + i, airline: 'EK' })) });
    for (let i = 0; i < 100; i++) {
      const base = w.fake.state.calls[0].record;
      w.fake.addCall('internal', { ...base, id: `many-${i}`, timestamp: new Date(T0 + 1_000_000 + i).toISOString(), response: { status: 200, headers: {}, body } });
    }
    const small = await w.call('search_calls', { direction: 'inbound', limit: 100, fields: ['method', 'url'] });
    const full = await w.call('get_call', { id: 'many-0' });
    assert.equal(small.json.calls.length, 100);
    // A full read is the whole call (headers and bodies); 100 of them against one reply of 100 short selections.
    assert.ok(full.text.length * 100 >= small.text.length * 10, `${small.text.length} vs ${full.text.length * 100}`);
  } finally { await w.close(); }
});
