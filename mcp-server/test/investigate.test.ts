import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { session } from '../src/session.ts';
import { world } from './harness.ts';
import { CYCLE, IN1, IN2 } from './fixtures.ts';
import { seedTrouble } from './log-fixtures.ts';

test('problem_calls lists every call with an error or a warning - DB or logs - with counts first, and filters combine', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    const all = await w.call('problem_calls', {});
    assert.equal(all.isError, false, all.text);
    assert.equal(all.json.counts.LOG_ERROR, 1);
    assert.equal(all.json.counts.DB_WARNING, 1);
    assert.equal(all.json.counts.LOG_WARNING, 1);
    assert.equal(all.json.counts.HTTP_ERROR >= 1, true);
    const ids = all.json.calls.map((c: { callId: string }) => c.callId);
    assert.ok(ids.includes(IN1) && ids.includes(IN2) && ids.includes('in-nplus1'));
    const in1 = all.json.calls.find((c: { callId: string }) => c.callId === IN1);
    assert.deepEqual(in1.signals, ['DB_FAILED', 'LOG_ERROR', 'LOG_EXCEPTION', 'LOG_WARNING']);
    assert.match(in1.evidence, /▤ 1 error line · 1 warning line · 1 exception \(caught at WARN\)/);

    const loggedButOk = await w.call('problem_calls', { all: ['LOG_ERROR'], none: ['HTTP_ERROR'] });
    assert.deepEqual(loggedButOk.json.calls.map((c: { callId: string }) => c.callId), [IN1]);
    const dbWarnings = await w.call('problem_calls', { all: ['DB_WARNING'], none: ['LOG_ERROR', 'HTTP_ERROR', 'DB_FAILED'] });
    assert.deepEqual(dbWarnings.json.calls.map((c: { callId: string }) => c.callId), ['in-nplus1']);
    assert.equal(dbWarnings.json.calls[0].severity, 'warning');

    // the same call live and in the cycle counts once, and says where it is held
    const everything = await w.call('problem_calls', { scope: { all: true }, all: ['LOG_ERROR'] });
    assert.equal(everything.json.calls.length, 1);
    assert.equal(everything.json.calls[0].heldIn, 'live + cycle «booking fails at payment»');
    const body = w.fake.requests('POST', '/triage/problem-calls').at(-1)!.body;
    assert.deepEqual(body.scope, { kind: 'all' });

    const cycle = await w.call('problem_calls', { scope: { cycle: 'payment' } });
    assert.deepEqual(w.fake.requests('POST', '/triage/problem-calls').at(-1)!.body.scope, { kind: 'cycles', cycleIds: [CYCLE], includeLive: false });
    assert.equal(cycle.json.scope.calls, 2);
  } finally { await w.close(); }
});

test('a project whose lines are not caught is said, never shown as clean', async () => {
  const w = await world();
  try {
    w.fake.state.captureProjects[0].logsOn = false;
    const r = await w.call('problem_calls', {});
    assert.equal(r.json.unavailable[0].why, 'LOGS_OFF');
    assert.match(r.json.unavailable[0].meaning, /▤ switch is off/);
  } finally { await w.close(); }
});

test('investigate_call gives signals, the first error with what came before, the exception\'s source line and a similar success', async () => {
  const w = await world();
  const root = await mkdtemp(join(tmpdir(), 'alfred-src-'));
  try {
    await mkdir(join(root, 'src/main/java/com/tt/nc/booking'), { recursive: true });
    await writeFile(join(root, 'src/main/java/com/tt/nc/booking/FareService.java'), 'class FareService {}\n');
    await w.call('session_settings', { sourceRoot: root });
    seedTrouble(w.fake);

    const r = await w.call('investigate_call', { callId: IN1 });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.signals.map((s: { signal: string }) => s.signal), ['DB_FAILED', 'LOG_ERROR', 'LOG_EXCEPTION', 'LOG_WARNING']);
    assert.equal(r.json.firstError.window.at(-1).error, true);
    assert.ok(r.json.firstError.window.length > 1, 'the items before the first error come with it');
    assert.equal(r.json.exception.type, 'java.lang.IllegalArgumentException');
    assert.equal(r.json.exception.thrownAt.source, 'src/main/java/com/tt/nc/booking/FareService.java:88');

    // two tool calls from triage to the line of code (SC-004, SC-009)
    const triage = await w.call('triage', { cycle: 'payment' });
    assert.match(triage.text, /▤ ERROR MainLogger: No enum constant com\.tt\.Status\.PENDNG \[java\.lang\.IllegalArgumentException\]/);
  } finally {
    session.sourceRoot = process.cwd();
    await w.close();
  }
});

test('endpoint_health, problem_timeline and compare_cycles answer over a scope', async () => {
  const w = await world();
  try {
    seedTrouble(w.fake);
    const health = await w.call('endpoint_health', {});
    assert.equal(health.isError, false, health.text);
    assert.ok(health.json.endpoints.length >= 2);
    const timeline = await w.call('problem_timeline', { scope: { all: true } });
    assert.equal(timeline.json.bucketMinutes, 1);

    w.fake.addCycle({ id: 'cy-after', name: 'after the fix' }, [{ source: 'internal', record: w.fake.state.calls.find((c) => c.record.id === IN2)!.record }]);
    const compared = await w.call('compare_cycles', { before: 'payment', after: 'after the fix' });
    assert.equal(compared.isError, false, compared.text);
    assert.equal(compared.json.goneProblems.length, 1, 'the enum error of IN1 is gone after the fix');
    assert.equal(compared.json.newProblems.length, 0);
    assert.equal(compared.json.signals.LOG_ERROR.before, 1);
    assert.equal(compared.json.signals.LOG_ERROR.after, 0);
  } finally { await w.close(); }
});
