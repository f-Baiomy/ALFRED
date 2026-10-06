import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Redaction } from '../src/frontend.ts';
import { world } from './harness.ts';
import { IN1, IN2 } from './fixtures.ts';

const line = (i: number, level: string, message: string) => ({
  sourceId: 's1', sourceName: 'wildfly', lineId: `in:${i}`, at: `2026-10-06T10:00:0${i}Z`, offsetMs: i * 100, level, thread: 'default task-4',
  logger: 'a.B', message, matchedBy: 'EXACT', kept: false, raw: JSON.stringify({ message, password: 'hunter2', mdc: { 'alfred.call': IN1 } }),
});

test('call_logs lists a call\'s lines, paged across the backend\'s pages, filtered by level and text', async () => {
  const w = await world();
  try {
    w.fake.state.callLogs[IN1] = {
      setup: 'OK', matchedBy: 'EXACT', thread: null,
      lines: Array.from({ length: 700 }, (_, i) => line(i % 9, i === 650 ? 'ERROR' : i % 5 === 0 ? 'WARN' : 'INFO', i === 650 ? 'search failed' : `step ${i}`)),
    };
    const all = await w.call('call_logs', { callId: IN1, limit: 10 });
    assert.equal(all.isError, false, all.text);
    assert.equal(all.json.total, 700);
    assert.equal(all.json.lines.length, 10);
    assert.equal(all.json.nextOffset, 10);
    assert.equal(all.json.lines[0].matchedBy, 'EXACT');
    assert.equal(all.json.lines[0].raw, undefined);

    const errors = await w.call('call_logs', { callId: IN1, level: 'ERROR' });
    assert.equal(errors.json.total, 1);
    assert.equal(errors.json.lines[0].message, 'search failed');
    assert.equal(errors.json.allLines, 700);

    const text = await w.call('call_logs', { callId: IN1, text: 'STEP 1', limit: 200 });
    assert.ok(text.json.lines.every((l: { message: string }) => l.message.toLowerCase().includes('step 1')));
  } finally { await w.close(); }
});

test('call_logs shows a caught line\'s logger and exception', async () => {
  const w = await world();
  try {
    w.fake.state.callLogs[IN1] = { setup: 'OK', matchedBy: 'CAUGHT', thread: null, lines: [{ ...line(1, 'ERROR', 'boom'), matchedBy: 'CAUGHT',
      logger: 'com.app.Search', exception: { type: 'java.lang.IllegalStateException', message: 'bad', stack: 'java.lang.IllegalStateException: bad' } }] };
    const r = await w.call('call_logs', { callId: IN1 });
    assert.equal(r.json.matchedBy, 'CAUGHT');
    assert.equal(r.json.lines[0].logger, 'com.app.Search');
    assert.equal(r.json.lines[0].exception.type, 'java.lang.IllegalStateException');
  } finally { await w.close(); }
});

test('call_logs masks each line like a body (a rule hides a field inside the line)', async () => {
  const w = await world();
  try {
    w.fake.state.callLogs[IN1] = { setup: 'OK', matchedBy: 'EXACT', thread: null, lines: [line(1, 'INFO', 'login')] };
    const rule: Redaction = { id: 'r1', scope: 'all', callId: null, kind: 'request-body-key', name: 'password', createdAt: '' };
    w.fake.state.redactions.push(rule);
    const r = await w.call('call_logs', { callId: IN1, raw: true, mask: true });
    assert.equal(r.isError, false, r.text);
    assert.ok(!r.json.lines[0].raw.includes('hunter2'), r.json.lines[0].raw);
    assert.equal(r.json.masked, true);
    assert.equal(r.json.maskedValues, 1);
  } finally { await w.close(); }
});

test('call_logs says why a call has no lines, and an unknown call is not found', async () => {
  const w = await world();
  try {
    w.fake.state.callLogs[IN2] = { setup: 'LINKING_OFF', matchedBy: null, thread: null, lines: [] };
    const off = await w.call('call_logs', { callId: IN2 });
    assert.equal(off.json.setup, 'LINKING_OFF');
    assert.match(off.json.why, /not reading this project's logs/);

    const missing = await w.call('call_logs', { callId: 'nope' });
    assert.equal(missing.json.error, 'not_found');
  } finally { await w.close(); }
});
