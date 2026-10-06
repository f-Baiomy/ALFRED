import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AlfredClient } from '../src/alfred-client.ts';
import { createServer } from '../src/server.ts';
import { session } from '../src/session.ts';
import { hunksOf } from '../src/tools/diff.ts';
import { parseFrame } from '../src/source.ts';
import { world } from './harness.ts';
import { CYCLE, IN1, IN2, OUT1, T0 } from './fixtures.ts';

// Enhancements 2-7, 9, 10 (2026-10-05).

test('get_cycle reads comment counts once per page and text only for calls that have comments (3)', async () => {
  const w = await world();
  try {
    w.fake.state.comments.push({ id: 'c1', callId: IN2, block: 'call', lineIndex: 0, lineText: '', comment: 'payment provider down', createdAt: '' });
    const r = await w.call('get_cycle', { cycle: CYCLE, includeDb: false });
    assert.match(r.text, /💬 \[call\] payment provider down/);
    assert.equal(w.fake.requests('GET', '/comments/counts').length, 1);
    const textReads = w.fake.log.filter((q) => q.method === 'GET' && q.path === '/comments');
    assert.deepEqual(textReads.map((q) => q.query.get('callId')), [IN2]);
  } finally { await w.close(); }
});

test('search_cycle finds by text and failure inside the cycle, numbered as get_cycle numbers them (5)', async () => {
  const w = await world();
  try {
    w.fake.state.calls = []; // gone from the live log - the cycle still has them
    const byText = await w.call('search_cycle', { cycle: CYCLE, text: 'payment failed' });
    assert.equal(byText.isError, false, byText.text);
    assert.deepEqual(byText.json.calls.map((c: { n: number; id: string }) => [c.n, c.id]), [[3, IN2]]);
    const failed = await w.call('search_cycle', { cycle: CYCLE, failed: true });
    assert.deepEqual(failed.json.calls.map((c: { id: string }) => c.id), [IN2]);
    const outbound = await w.call('search_cycle', { cycle: CYCLE, direction: 'outbound', fields: ['method', 'url'] });
    assert.deepEqual(outbound.json.calls, [{ n: 2, id: OUT1, method: 'POST', url: 'https://ndc.example.test/api/FlightSearch/Search' }]);
    const none = await w.call('search_cycle', { cycle: CYCLE, text: 'no-such-text' });
    assert.equal(none.json.total, 0);
  } finally { await w.close(); }
});

test('diff_calls: status, url and a JSON body diff as hunks; identical headers are counted, not listed (2)', async () => {
  const w = await world();
  try {
    const r = await w.call('diff_calls', { a: IN1, b: IN2, part: 'response' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.changes.status, '200 → 500');
    assert.ok(r.json.changes.url);
    assert.equal(r.json.response.body.kind, 'json');
    assert.equal(r.json.response.body.identical, false);
    const lines = r.json.response.body.hunks.flatMap((h: { lines: string[] }) => h.lines);
    assert.ok(lines.some((l: string) => l.startsWith('+ ') && l.includes('payment failed')));
    assert.ok(lines.some((l: string) => l.startsWith('- ') && l.includes('fare')));
    assert.equal(r.json.response.headers.changed.length, 0);
    const same = await w.call('diff_calls', { a: IN1, b: IN1, part: 'both' });
    assert.equal(same.json.request.body.identical, true);
    assert.deepEqual(same.json.request.body.hunks, []);
  } finally { await w.close(); }
});

test('hunksOf keeps context around each change and numbers both sides', () => {
  const same = (text: string) => ({ kind: 'same' as const, text, tokens: null });
  const lines = [same('a'), same('b'), same('c'), { kind: 'removed' as const, text: 'x', tokens: null }, { kind: 'added' as const, text: 'y', tokens: null }, same('d'), same('e'), same('f'), same('g')];
  assert.deepEqual(hunksOf(lines, 1), [{ a: 3, b: 3, lines: ['  c', '- x', '+ y', '  d'] }]);
});

test('frames resolve to project files; a missing file is left unresolved (4)', async () => {
  const w = await world();
  const root = await mkdtemp(join(tmpdir(), 'mcp-src-'));
  try {
    await mkdir(join(root, 'src/main/java/com/tt/dao'), { recursive: true });
    await mkdir(join(root, 'src/main/java/com/tt/service'), { recursive: true });
    await mkdir(join(root, 'src/test/java/com/tt/service'), { recursive: true });
    await mkdir(join(root, 'node_modules/x'), { recursive: true });
    await writeFile(join(root, 'src/main/java/com/tt/dao/GenericDAOImpl.java'), 'class GenericDAOImpl {}');
    await writeFile(join(root, 'src/main/java/com/tt/service/SystemSettingService.java'), '');
    await writeFile(join(root, 'src/test/java/com/tt/service/SystemSettingService.java'), '');
    await writeFile(join(root, 'node_modules/x/GenericDAOImpl.java'), '');
    const set = await w.call('session_settings', { sourceRoot: root });
    assert.equal(set.json.sourceRoot, root);

    const st = await w.call('db_statement', { statementId: 5619, rowsLimit: 0 });
    assert.deepEqual(st.json.sources, [
      { frame: 'GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:468)', source: 'src/main/java/com/tt/dao/GenericDAOImpl.java:468' },
      { frame: 'SystemSettingService.getTags(SystemSettingService.java:75)', candidates: [
        'src/main/java/com/tt/service/SystemSettingService.java:75', 'src/test/java/com/tt/service/SystemSettingService.java:75'] },
    ]);
    const list = await w.call('db_statements', { callId: IN1, seqFrom: 19, seqTo: 19 });
    assert.equal(list.json.statements[0].source, 'src/main/java/com/tt/dao/GenericDAOImpl.java:468');
    const located = await w.call('locate_source', { frames: ['Nope.run(Nope.java:1)', 'com.tt.service.SystemSettingService.getTags(SystemSettingService.java:75)'] });
    assert.deepEqual(located.json.frames[0], { frame: 'Nope.run(Nope.java:1)' });
    assert.equal(located.json.frames[1].candidates[0], 'src/main/java/com/tt/service/SystemSettingService.java:75');
    assert.equal(located.json.files, 3, 'node_modules is not indexed');
  } finally {
    session.sourceRoot = process.cwd();
    await w.close();
  }
});

test('two classes of one name: told apart by the method at that line, then by the caller\'s import (4)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-src-'));
  const pad = (n: number) => Array.from({ length: n }, () => '').join('\n');
  try {
    await mkdir(join(root, 'core/src/main/java/com/tt/nc/core/dao'), { recursive: true });
    await mkdir(join(root, 'core/src/main/java/com/tt/portal/core/dao'), { recursive: true });
    await mkdir(join(root, 'core/src/main/java/com/tt/ts/org'), { recursive: true });
    // Both have fetchWithHQL enclosing line 12; only the portal copy has a saveAll enclosing line 22.
    await writeFile(join(root, 'core/src/main/java/com/tt/nc/core/dao/GenericDAOImpl.java'),
      `package com.tt.nc.core.dao;\n${pad(8)}\n    public <T> List<T> fetchWithHQL(String q, List p) throws HibernateException {\n${pad(4)}\n        return query.list();\n    }\n${pad(10)}\n    private void other() {\n${pad(10)}`);
    await writeFile(join(root, 'core/src/main/java/com/tt/portal/core/dao/GenericDAOImpl.java'),
      `package com.tt.portal.core.dao;\n${pad(8)}\n    public <T> List fetchWithHQL(String q, List p) throws Exception {\n${pad(4)}\n        return q;\n    }\n${pad(2)}\n    public void saveAll(List<Object> all) {\n${pad(4)}\n        all.forEach(this::save);\n    }\n${pad(5)}`);
    await writeFile(join(root, 'core/src/main/java/com/tt/ts/org/OrganizationDaoImpl.java'),
      `package com.tt.ts.org;\n\nimport com.tt.nc.core.dao.GenericDAOImpl;\n\npublic class OrganizationDaoImpl extends GenericDAOImpl {\n${pad(30)}`);
    session.sourceRoot = root;
    const { resolveFrames } = await import('../src/source.ts');
    const [byMethod] = await resolveFrames(['GenericDAOImpl.saveAll(GenericDAOImpl.java:22)']);
    assert.equal(byMethod.source, 'core/src/main/java/com/tt/portal/core/dao/GenericDAOImpl.java:22');
    const [alone] = await resolveFrames(['GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:12)']);
    assert.equal(alone.candidates?.length, 2, 'both fit on their own');
    const chain = await resolveFrames(['GenericDAOImpl.fetchWithHQL(GenericDAOImpl.java:12)', 'OrganizationDaoImpl.fetchBranch(OrganizationDaoImpl.java:20)']);
    assert.equal(chain[0].source, 'core/src/main/java/com/tt/nc/core/dao/GenericDAOImpl.java:12', 'the caller imports the nc one');
  } finally {
    session.sourceRoot = process.cwd();
  }
});

test('parseFrame reads packaged, inner and fileless frames', () => {
  assert.deepEqual(parseFrame('com.a.B$C.run(B.java:7)'), { className: 'com.a.B$C', method: 'run', file: 'B.java', line: 7 });
  assert.deepEqual(parseFrame('sun.reflect.X.invoke(Unknown Source)'), { className: 'sun.reflect.X', method: 'invoke', file: null, line: null });
  assert.equal(parseFrame('not a frame'), null);
});

test('rules and Relive runs are readable; a call changed by a rule says so (6)', async () => {
  const w = await world();
  try {
    w.fake.state.rules = [
      { id: 'r1', name: 'slow sabre', enabled: true, priority: 10, match: { source: 'outbound', methods: ['POST'], host: 'ndc.example.test' }, actions: [{ type: 'DELAY', enabled: true }] },
      { id: 'r2', name: 'off one', enabled: false, priority: 20, match: {}, actions: [] },
    ];
    const rules = await w.call('list_rules', { enabledOnly: true });
    assert.deepEqual(rules.json.rules, [{ id: 'r1', name: 'slow sabre', enabled: true, priority: 10, match: 'outbound POST ndc.example.test', actions: ['DELAY'] }]);
    assert.equal((await w.call('get_rule', { ruleId: 'r2' })).json.name, 'off one');
    assert.equal((await w.call('get_rule', { ruleId: 'nope' })).json.error, 'not_found');

    const out1 = w.fake.state.cycleEntries.get(CYCLE)!.find((e) => e.record.id === OUT1)!;
    Object.assign(out1.record, { interception: { applied: [{ ruleId: 'r1', ruleName: 'slow sabre', action: 'DELAY', detail: '2000 ms' }] } });
    const live = w.fake.state.calls.find((c) => c.record.id === OUT1)!;
    Object.assign(live.record, { interception: { applied: [{ ruleId: 'r1', ruleName: 'slow sabre', action: 'DELAY', detail: '2000 ms' }] } });
    const story = await w.call('get_cycle', { cycle: CYCLE, includeDb: false });
    assert.match(story.text, new RegExp(`id=${OUT1} ⚡ slow sabre`));
    const call = await w.call('get_call', { id: OUT1, direction: 'outbound' });
    assert.deepEqual(call.json.interception.applied, [{ rule: 'slow sabre', ruleId: 'r1', action: 'DELAY', detail: '2000 ms' }]);

    w.fake.state.reliveCycles = [{ id: 'rc1', name: 'cycle booking', stepCount: 2, lastRun: null, updatedAt: 't' }];
    w.fake.state.runs.set('rc1', [{
      id: 'run1', status: 'FAILED', driver: 'AUTOMATIC', startedAt: 's', finishedAt: 'f', summary: { total: 2, failed: 1 },
      definition: { steps: [{ key: 'k1', label: 'POST /login' }, { key: 'k2', label: 'GET /pax-details' }] },
      stepResults: [
        { stepKey: 'k2', attempt: 1, state: 'FAILED', mode: 'LIVE', durationMs: 65, error: null, actualResponse: { status: 400 },
          differences: [{ part: 'status', path: 'status', recorded: '500', actual: '400', kind: 'UNEXPECTED' }] },
        { stepKey: 'k1', attempt: 1, state: 'COMPLETED', mode: 'LIVE', durationMs: 12, error: null, actualResponse: { status: 200 } },
      ],
    }]);
    const runs = await w.call('list_relive_runs', { reliveCycle: 'booking' });
    assert.deepEqual(runs.json.runs.map((r: { id: string; status: string }) => [r.id, r.status]), [['run1', 'FAILED']]);
    const all = await w.call('get_relive_run', { reliveCycle: 'rc1', runId: 'run1' });
    assert.deepEqual(all.json.steps.map((s: { n: number; step: string }) => [s.n, s.step]), [[1, 'POST /login'], [2, 'GET /pax-details']]);
    const failed = await w.call('get_relive_run', { reliveCycle: 'rc1', runId: 'run1', state: 'failed' });
    assert.deepEqual(failed.json.steps[0].differences, [{ part: 'status', path: 'status', kind: 'UNEXPECTED', recorded: '500', actual: '400' }]);
    assert.equal(failed.json.total, 1);
  } finally { await w.close(); }
});

test('debug_cycle and debug_call prompts give the steps (7)', async () => {
  const server = createServer(new AlfredClient('http://127.0.0.1:9'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const listed = await client.listPrompts();
    assert.deepEqual(listed.prompts.map((p) => p.name).sort(), ['debug_call', 'debug_cycle']);
    const prompt = await client.getPrompt({ name: 'debug_cycle', arguments: { cycle: 'booking fails at payment', problem: 'no results' } });
    const text = (prompt.messages[0].content as { text: string }).text;
    assert.match(text, /Debug the Alfred session cycle "booking fails at payment" - the problem: no results/);
    assert.match(text, /get_cycle[\s\S]*db_statement[\s\S]*diff_calls[\s\S]*get_rule[\s\S]*add_comment/);
  } finally {
    await client.close();
    await server.close();
  }
});

test('project switches: listed with capture and log status; ◆ changes at once and says what changed; inbound logging needs confirm (9, specs/010)', async () => {
  const w = await world();
  try {
    const list = await w.call('list_projects');
    assert.deepEqual(list.json.projects.map((p: { name: string }) => p.name), ['odeysys', 'core-service'], 'the unknown bucket is not a project');
    assert.deepEqual(list.json.projects[0].dbCapture, { enabled: false, agentAttached: true });

    const done = await w.call('set_db_capture', { project: 'odeysys', enabled: true });
    assert.deepEqual(done.json.changed, [{ setting: 'dbCapture', from: false, to: true }]);
    assert.equal(done.json.dbCapture.enabled, true);
    assert.equal(done.json.tellTheUser, true);
    assert.deepEqual((await w.call('set_db_capture', { project: 'odeysys', enabled: true })).json.changed, []);

    const blocked = await w.call('set_db_capture', { project: 'core-service', enabled: true });
    assert.equal(blocked.json.error, 'invalid');
    assert.match(blocked.json.message, /Inbound logging is off/);

    assert.equal((await w.call('set_inbound_logging', { project: 'core-service', enabled: true })).json.needsConfirm, true);
    const on = await w.call('set_inbound_logging', { project: 'core-service', enabled: true, confirm: true });
    assert.deepEqual([on.json.changed, on.json.inboundLogging], [true, true]);
    assert.equal((await w.call('set_inbound_logging', { project: 'nope', enabled: true, confirm: true })).json.error, 'invalid');
  } finally { await w.close(); }
});

test('wait_for_calls wakes on a socket event when the cycle grows, not on one that changes nothing (10)', async () => {
  const w = await world();
  try {
    const started = Date.now();
    const waiting = w.call('wait_for_calls', { cycleId: CYCLE, timeoutSec: 20 });
    for (let i = 0; i < 50 && w.fake.openSockets().length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(w.fake.openSockets().sort(), ['/ws/calls', '/ws/internal-calls', '/ws/session-cycles']);

    // A signal that adds nothing must not end the wait.
    w.fake.broadcast('/ws/calls', '{"type":"call-updated"}');
    await new Promise((r) => setTimeout(r, 700));

    const record = { ...w.fake.state.calls[0].record, id: 'new-captured', timestamp: new Date(T0 + 500_000).toISOString() };
    w.fake.state.cycleEntries.get(CYCLE)!.push({ capturedId: 'cap-new', capturedAt: record.timestamp, source: 'internal', record });
    w.fake.broadcast('/ws/internal-calls', '{"type":"new-call"}');
    const r = await waiting;
    assert.equal(r.json.timedOut, false);
    assert.deepEqual(r.json.newCalls.map((c: { id: string }) => c.id), ['new-captured']);
    assert.equal(r.json.lastCallId, 'new-captured');
    assert.ok(Date.now() - started < 8000, 'woke on the event, long before the 20 s timeout');
    for (let i = 0; i < 50 && w.fake.openSockets().length > 0; i++) await new Promise((r2) => setTimeout(r2, 50));
    assert.deepEqual(w.fake.openSockets(), [], 'its sockets are closed afterwards');
  } finally { await w.close(); }
});
