import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normaliseMessage } from '../src/signals.ts';
import { framesOfStack } from '../src/source.ts';
import { world } from './harness.ts';
import { caught, seedTrouble } from './log-fixtures.ts';
import { CYCLE, IN1, IN2, T0 } from './fixtures.ts';

test('the fingerprint rules match the backend\'s on the shared vectors', () => {
  const file = JSON.parse(readFileSync(new URL('../../specs/010-mcp-log-investigation/fixtures/fingerprint-vectors.json', import.meta.url), 'utf8'));
  for (const v of file.cases) assert.equal(normaliseMessage(v.message), v.normalised, v.group);
});

test('search_logs finds every call that logged a symptom, names the call and its place, and refuses an empty search', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    w.fake.state.callLogs[IN2] = { setup: 'OK', matchedBy: 'CAUGHT', thread: null, lines: [caught(9, 4, 'ERROR', 'No enum constant com.tt.Status.CANCELD')] };
    const r = await w.call('search_logs', { text: 'no enum constant' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.total, 2);
    assert.match(r.json.hits[0].call, /^POST \/odeysysadmin\/.+ → \d+$/);
    assert.equal(typeof r.json.hits[0].offsetMs, 'number');
    assert.ok(r.json.hits.every((h: { lineId: string }) => h.lineId.startsWith('c:')));

    const cycle = await w.call('search_logs', { text: 'no enum', scope: { cycle: CYCLE } });
    assert.equal(cycle.json.scope.kind, 'cycles');
    assert.equal((await w.call('search_logs', {})).json.error, 'invalid');
  } finally { await w.close(); }
});

test('log_problems groups repeated errors and lists the calls of one', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    w.fake.state.callLogs[IN2] = { setup: 'OK', matchedBy: 'CAUGHT', thread: null, lines: [
      caught(10, 4, 'ERROR', 'Booking 12345 not found'), caught(11, 5, 'ERROR', 'Booking 777 not found'),
    ] };
    const r = await w.call('log_problems', {});
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.groups, 2);
    assert.equal(r.json.problems[0].lines, 2);
    const calls = await w.call('log_problems', { fingerprint: r.json.problems[0].fingerprint });
    assert.deepEqual(calls.json.calls.map((c: { callId: string }) => c.callId), [IN2]);
  } finally { await w.close(); }
});

test('call_story tells a call in its own order, can start at the first error, and log_context shows what came before a line', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    const story = await w.call('call_story', { callId: IN1, limit: 300 });
    assert.equal(story.isError, false, story.text);
    const seqs = story.json.items.map((i: { seq: number }) => i.seq);
    assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b), 'in the call\'s own order');
    const warn = story.json.items.findIndex((i: { kind: string; text: string }) => i.kind === 'log' && i.text.startsWith('WARN'));
    assert.ok(story.json.items[warn - 1].seq <= 3 && story.json.items[warn + 1].seq >= 3, 'the line sits between the statements around seq 3');
    assert.equal(story.json.counts.logLines, 2);

    const fromError = await w.call('call_story', { callId: IN1, startAt: 'firstError', limit: 5 });
    assert.ok(fromError.json.items.some((i: { error?: boolean }) => i.error));

    const ctx = await w.call('log_context', { callId: IN1, lineId: 'c:2', before: 2, after: 1 });
    assert.equal(ctx.json.line.ref, 'c:2');
    assert.equal(ctx.json.before.length, 2);
    assert.equal((await w.call('log_context', { callId: IN1, lineId: 'c:999' })).json.error, 'not_found');
  } finally { await w.close(); }
});

test('a call with no lines says why, naming the level that applied (or that it is assumed)', async () => {
  const w = await world();
  try {
    w.fake.state.callLogs[IN2] = { setup: 'OK', matchedBy: 'CAUGHT', thread: null, logLevel: 'ERROR', levelAssumed: true, lines: [] };
    const story = await w.call('call_story', { callId: IN2 });
    assert.match(story.json.noLogLines, /ERROR \(assumed - the project's current setting\) or above/);
    const logs = await w.call('call_logs', { callId: IN2 });
    assert.equal(logs.json.levelAssumed, true);
  } finally { await w.close(); }
});

test('exception_source parses a stack: application frames apart from the libraries', () => {
  const frames = framesOfStack('x: y\n\tat java.base/java.lang.Enum.valueOf(Enum.java:273)\n\tat com.tt.A.b(A.java:9)\n\tat org.jboss.X.y(X.java:1)\nCaused by: z\n\tat com.tt.C.d(C.java:3)');
  assert.deepEqual(frames.app, ['com.tt.A.b(A.java:9)', 'com.tt.C.d(C.java:3)']);
  assert.equal(frames.skipped, 2);
});

test('outside_logs reads the lines no call wrote around a call, by thread', async () => {
  const w = await world();
  try {
    w.fake.state.outsideLogs.push(
      { project: 'odeysys', at: new Date(T0 - 60_000).toISOString(), level: 'ERROR', logger: 'job.Sync', thread: 'scheduler-1', message: 'sync failed' },
      { project: 'odeysys', at: new Date(T0 - 3_600_000).toISOString(), level: 'ERROR', logger: 'job.Sync', thread: 'scheduler-1', message: 'long ago' });
    const r = await w.call('outside_logs', { project: 'odeysys', around: IN1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.lines, 1);
    assert.equal(r.json.threads[0].thread, 'scheduler-1');
  } finally { await w.close(); }
});

test('set_log_capture turns ▤ on and sets the Log level at once, saying what changed', async () => {
  const w = await world();
  try {
    const r = await w.call('set_log_capture', { project: 'odeysys', level: 'DEBUG' });
    assert.deepEqual(r.json.changed, [{ setting: 'logLevel', from: 'ERROR', to: 'DEBUG' }]);
    assert.equal(r.json.tellTheUser, true);
    assert.equal(w.fake.state.captureSettings['odeysys'].logLevel, 'DEBUG');
    assert.deepEqual((await w.call('set_log_capture', { project: 'odeysys', level: 'DEBUG' })).json.changed, []);
    const off = await w.call('set_log_capture', { project: 'odeysys', on: false });
    assert.deepEqual(off.json.changed, [{ setting: 'logCatching', from: true, to: false }]);
    assert.match((await w.call('set_log_capture', { project: 'core-service', on: true })).json.message, /Inbound logging is off/);
    const list = await w.call('list_projects');
    assert.deepEqual(list.json.projects[0].logCatching, { on: false, logLevel: 'DEBUG' });
  } finally { await w.close(); }
});

test('diff_calls compares two calls\' log lines by meaning and trace_value finds a value in log lines', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    w.fake.state.callLogs[IN2] = { setup: 'OK', matchedBy: 'CAUGHT', thread: null, lines: [caught(20, 3, 'WARN', 'supplier slow: 999 ms')] };
    const d = await w.call('diff_calls', { a: IN1, b: IN2, part: 'response' });
    assert.equal(d.isError, false, d.text);
    assert.equal(d.json.logs.lines.inBoth, 1, 'the slow-supplier warning differs only by its number');
    assert.equal(d.json.logs.onlyInA[0].level, 'ERROR');
    assert.equal(d.json.logs.firstDivergence.afterSameLines, 1);

    const t = await w.call('trace_value', { callId: IN1, value: 'PENDNG' });
    assert.equal(t.json.logTotal, 1);
    assert.equal(t.json.logHits[0].lineId, 'c:2');
  } finally { await w.close(); }
});

test('every tool that returns log text masks it like bodies', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    const secret = 'hunter2-secret';
    w.fake.state.callLogs[IN1].lines.push(caught(3, 60, 'ERROR', `login failed for password=${secret}`));
    // a secret variable's value is masked wherever it appears - the vectors bodies are tested with
    w.fake.state.variables = { variables: { pw: secret }, fallbacks: {}, secrets: ['pw'] };
    const leaks: string[] = [];
    for (const [tool, args] of [
      ['call_logs', { callId: IN1 }], ['search_logs', { text: 'login failed' }], ['log_problems', {}], ['call_story', { callId: IN1 }],
      ['log_context', { callId: IN1, lineId: 'c:3' }], ['investigate_call', { callId: IN1 }], ['triage', { cycle: CYCLE }],
    ] as const) {
      const r = await w.call(tool, { ...args, mask: true });
      if (r.text.includes(secret)) leaks.push(`${tool}: ${r.text.slice(Math.max(0, r.text.indexOf(secret) - 80), r.text.indexOf(secret) + 20)}`);
    }
    assert.deepEqual(leaks, []);
  } finally { await w.close(); }
});

test('wait_for_calls until logError waits past calls without errors and returns the one that logged one', async () => {
  const w = await world();
  try {
    const waiting = w.call('wait_for_calls', { cycleId: CYCLE, timeoutSec: 20, until: 'logError' });
    for (let i = 0; i < 50 && w.fake.openSockets().length < 5; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(w.fake.openSockets().includes('/ws/db-capture'), 'listens for caught lines too');
    const base = w.fake.state.calls.find((c) => c.record.id === IN1)!.record;
    const clean = { ...base, id: 'new-clean', timestamp: new Date(T0 + 600_000).toISOString() };
    w.fake.addCall('internal', clean);
    w.fake.state.cycleEntries.get(CYCLE)!.push({ capturedId: 'cap-clean', capturedAt: clean.timestamp, source: 'internal', record: clean });
    w.fake.broadcast('/ws/internal-calls', '{"type":"new-call"}');
    await new Promise((r) => setTimeout(r, 800));

    w.fake.state.signals['new-clean'] = { logErrors: 2, logWarnings: 0, logExceptions: 0, logStatus: 'CAUGHT', dbFlags: [] };
    w.fake.broadcast('/ws/db-capture', '{"type":"logs-appended","callId":"new-clean"}');
    const r = await waiting;
    assert.equal(r.json.timedOut, false);
    assert.deepEqual(r.json.matched.map((c: { id: string }) => c.id), ['new-clean']);
  } finally { await w.close(); }
});

test('triage over everything lists each call once and says which projects lines are not caught for', async () => {
  const w = await world();
  try {
    w.fake.state.captureProjects[0].logsOn = false;
    const r = await w.call('triage', { scope: { all: true } });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /^triage everything - \d+ calls \(each once\)/);
    assert.match(r.text, /Not all evidence is available - odeysys: log lines are not caught/);
  } finally { await w.close(); }
});
