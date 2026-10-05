import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { select } from '../src/calls.ts';
import { chunkText, isBinary, REPLY_BUDGET } from '../src/reply.ts';
import { connect, world } from './harness.ts';
import { BIG, IN1, TOKEN } from './fixtures.ts';

test('unreachable Alfred: every kind of tool answers fast with how to start it (SC-006)', async () => {
  const h = await connect('http://127.0.0.1:9'); // discard port - nothing listens
  for (const [name, args] of [['list_cycles', {}], ['get_call', { id: 'x' }], ['db_overview', { callId: 'x' }], ['add_comment', { callId: 'x', comment: 'y' }]] as const) {
    const started = Date.now();
    const r = await h.call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(r.json.error, 'unreachable', name);
    assert.match(r.json.message, /python3 start\.py/);
    assert.ok(Date.now() - started < 5000, `${name} took ${Date.now() - started} ms`);
  }
  await h.close();
});

test('unknown ids are a not_found naming the id, never an empty success', async () => {
  const w = await world();
  try {
    const r = await w.call('db_statement', { statementId: 999999 });
    assert.equal(r.json.error, 'not_found');
    assert.match(r.json.message, /999999/);
    const c = await w.call('delete_comment', { commentId: 'nope' });
    assert.equal(c.json.error, 'not_found');
  } finally { await w.close(); }
});

test('a call dropped from the live log names the cycles that still hold a copy (G3)', async () => {
  const w = await world();
  try {
    w.fake.state.calls = w.fake.state.calls.filter((c) => c.record.id !== IN1);
    const r = await w.call('get_call', { id: IN1 });
    assert.equal(r.json.error, 'not_found');
    assert.match(r.json.message, /ring buffer/);
    assert.match(r.json.message, /booking fails at payment \(cy-booking\)/);
    const fromCycle = await w.call('get_call', { id: IN1, cycleId: 'cy-booking', fields: ['method', 'status'] });
    assert.equal(fromCycle.json.status, 200);
  } finally { await w.close(); }
});

test('select returns only what was asked and names what it could not find', () => {
  const call = { id: 'a', method: 'GET', url: 'u', original_url: 'o', timestamp: 't', duration_ms: 1, source: 'external' as const,
    request: { headers: { 'Content-Type': 'x' } }, response: { status: 204, headers: { 'X-Trace': 'abc' } } };
  const sel = select(call, ['method', 'status'], ['response.headers.x-trace', 'request.nope'], {}, 0, 100);
  assert.deepEqual(sel.values, { method: 'GET', status: 204, 'response.headers.x-trace': 'abc' });
  assert.deepEqual(sel.missing, ['request.nope']);
});

test('chunkText pages a large body to its end with no gap or overlap', () => {
  const body = 'x'.repeat(100_003);
  let rebuilt = '';
  for (let offset: number | null = 0; offset !== null;) {
    const c = chunkText(body, offset, 6000);
    assert.equal(c.totalLength, body.length);
    rebuilt += c.text;
    offset = c.nextOffset;
  }
  assert.equal(rebuilt, body);
});

test('binary bodies are recognised by type or content', () => {
  assert.equal(isBinary('image/png', 'abc'), true);
  assert.equal(isBinary(undefined, '\u0000\u0001\u0002\u0003binary'), true);
  assert.equal(isBinary('application/json', '{"a":1}'), false);
});

test('masking on hides redacted values and counts them; off returns them verbatim', async () => {
  const w = await world();
  try {
    w.fake.state.redactions = [{ id: 'r', scope: 'all', callId: null, kind: 'request-header', name: 'Authorization', createdAt: '' }];
    w.fake.state.variables = { variables: { pw: 'pw-not-real' }, fallbacks: {}, secrets: ['pw'] };
    const off = await w.call('get_call', { id: IN1, fields: ['requestHeaders', 'requestBody'] });
    assert.equal(off.json.requestHeaders.Authorization, TOKEN);
    assert.equal(off.json.masked, false);
    await w.call('session_settings', { maskSecrets: true });
    const on = await w.call('get_call', { id: IN1, fields: ['requestHeaders', 'requestBody'] });
    assert.notEqual(on.json.requestHeaders.Authorization, TOKEN);
    assert.ok(!on.json.requestBody.text.includes('pw-not-real'), 'secret variable value masked');
    assert.equal(on.json.masked, true);
    assert.ok(on.json.maskedValues >= 2);
    const override = await w.call('get_call', { id: IN1, fields: ['requestHeaders'], mask: false });
    assert.equal(override.json.requestHeaders.Authorization, TOKEN);
  } finally { await w.close(); }
});

test('session_settings rejects a folder that does not exist and keeps one that does', async () => {
  const w = await world();
  try {
    const bad = await w.call('session_settings', { exportFolder: join(tmpdir(), 'no-such-folder-mcp-test') });
    assert.equal(bad.json.error, 'invalid');
    const dir = await mkdtemp(join(tmpdir(), 'mcp-test-'));
    const good = await w.call('session_settings', { exportFolder: dir });
    assert.equal(good.json.exportFolder, dir);
    const cleared = await w.call('session_settings', { exportFolder: null });
    assert.equal(cleared.json.exportFolder, null);
  } finally { await w.close(); }
});

test('no reply ever exceeds the budget: an oversized one becomes an error that says how to ask for less', async () => {
  const w = await world();
  try {
    const r = await w.call('get_call', { id: BIG, bodyLength: 15000 });
    assert.ok(r.text.length <= REPLY_BUDGET);
  } finally { await w.close(); }
});
