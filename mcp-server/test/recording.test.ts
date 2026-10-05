import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';
import { CYCLE } from './fixtures.ts';

test('start and stop are idempotent: a repeat reports changed:false and sends one state change each', async () => {
  const w = await world();
  try {
    const first = await w.call('start_recording', { cycleId: CYCLE });
    assert.equal(first.json.cycle.status, 'RECORDING');
    assert.equal(first.json.changed, true);
    const again = await w.call('start_recording', { cycleId: CYCLE });
    assert.equal(again.json.changed, false);
    const stop = await w.call('stop_recording', { cycleId: CYCLE });
    assert.equal(stop.json.cycle.status, 'PAUSED');
    assert.equal(stop.json.changed, true);
    assert.equal((await w.call('stop_recording', { cycleId: CYCLE })).json.changed, false);
  } finally { await w.close(); }
});

test('start_recording names the other cycles already recording', async () => {
  const w = await world();
  try {
    await w.call('start_recording', { cycleId: 'cy-other' });
    const r = await w.call('start_recording', { cycleId: CYCLE });
    assert.deepEqual(r.json.otherRecording, [{ id: 'cy-other', name: 'booking fails at login' }]);
    const listed = await w.call('list_cycles', { status: 'recording' });
    assert.equal(listed.json.cycles.length, 2);
    assert.match((await w.call('get_cycle', { cycle: CYCLE, includeDb: false })).text, /- RECORDING,/);
  } finally { await w.close(); }
});

test('a Relive run\'s cycle is refused', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: 'cy-run', name: 'relive run 1', reliveRunId: 'run-1' });
    const r = await w.call('start_recording', { cycleId: 'cy-run' });
    assert.equal(r.json.error, 'invalid');
    assert.match(r.json.message, /Relive run/);
  } finally { await w.close(); }
});
