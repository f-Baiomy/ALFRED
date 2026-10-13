import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AlfredClient } from '../src/alfred-client.ts';
import { draftOf, headOf, LiveRunner, stepLabel, youDid } from '../src/live-runner.ts';
import type { ChangeRow } from '../src/tools/board.ts';
import { world } from './harness.ts';

/** The /alfred-live runner: waits with no model, answers each card with one fresh run, and shows every step as it happens. */

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

const change = (over: Partial<ChangeRow>): ChangeRow => ({
  id: 2, actor: 'USER', kind: 'COMMENT', text: 'is the fare right after confirm?', oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z',
  project: 'p', number: 1, title: 'Fare changes at confirm', status: 'INBOX', cycleId: null, cardId: 'card-1', replyTo: null, ...over,
} as ChangeRow);

test('each tool call reads as a step; the reply is read from its partial JSON as it is written', () => {
  assert.equal(stepLabel('mcp__alfred__investigate_call', { callId: 'in-confirm-123456789' }), 'checking call in-confi…');
  assert.equal(stepLabel('mcp__alfred-docker__board_edit', { number: 12, kind: 'BUG' }), '→ editing #12 (kind → BUG)');
  assert.equal(stepLabel('Read', { file_path: 'C:/repo/src/OrderMapper.java', offset: 58 }), 'reading OrderMapper.java:58');
  assert.equal(stepLabel('mcp__alfred__board_reply', {}), 'writing the reply');
  assert.equal(draftOf('{"project":"p","text":"Not right. Confirm ret'), 'Not right. Confirm ret');
  assert.equal(draftOf('{"text":"line one\\nline \\"two\\""}'), 'line one\nline "two"');
  assert.equal(draftOf('{"project":"p"'), null);
});

test('what the user did picks the head; moves and closes are only noted, no run', () => {
  const never = () => false;
  assert.deepEqual(headOf([change({})], never), { head: 'working on your question', quiet: false });
  assert.deepEqual(headOf([change({ replyTo: 1 })], () => true), { head: 'acting on your answer', quiet: false });
  assert.deepEqual(headOf([change({ kind: 'STATUS', oldValue: 'IN_PROGRESS', newValue: 'FIXED' })], never), { head: 'preparing the re-test', quiet: false });
  assert.deepEqual(headOf([change({ kind: 'STATUS', newValue: 'TO_DO' })], never).quiet, true);
  assert.deepEqual(headOf([change({ kind: 'RESOLUTION', newValue: 'FINE' })], never).quiet, true);
  assert.equal(youDid(change({ kind: 'STATUS', oldValue: 'IN_PROGRESS', newValue: 'FIXED' })), 'You moved it In progress → Fixed');
});

async function runnerWorld(mode = 'ok') {
  const w = await world();
  await w.call('board_add', { project: 'p', kind: 'QUESTION', title: 'Fare changes at confirm' });
  w.fake.board.activity['card-1'] = [
    { id: 1, actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** May fare.total change at confirm?', oldValue: null, newValue: null, at: '2026-10-13T08:59:00Z', replyTo: null },
    { id: 2, actor: 'USER', kind: 'COMMENT', text: 'is the fare right after confirm?', oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z', replyTo: null },
  ];
  w.fake.board.changes = { entries: [change({})], cycles: [], cursor: '2.1', more: false };
  const dir = mkdtempSync(join(tmpdir(), 'live-runner-'));
  const promptFile = join(dir, 'prompt.json');
  process.env['FAKE_CLAUDE_MODE'] = mode;
  process.env['FAKE_CLAUDE_PROMPT'] = promptFile;
  const lines: string[] = [];
  const runner = new LiveRunner({
    client: new AlfredClient(w.fake.url), project: 'p', cwd: dir, claude: process.execPath, claudeArgs: [FAKE], mcpConfig: join(dir, 'mcp.json'),
    log: (l) => lines.push(l), settleMs: 0, waitSeconds: 1, draftEveryMs: 0, model: 'sonnet',
  });
  return { w, runner, lines, promptFile };
}

test('a comment: one fresh run, each step and the reply reported to the card as they happen, one line each in the log', async () => {
  const { w, runner, lines, promptFile } = await runnerWorld();
  try {
    assert.equal(await runner.once('now'), '2.1');
    const reports = w.fake.board.liveWork;
    assert.equal(reports[0].state, 'WORKING');
    assert.equal(reports[0].head, 'working on your question');
    assert.equal(reports[0].cardNumber, 1);
    assert.ok(reports.some((r) => r.state === 'WORKING' && r.steps.includes('checking call in-confi…')), JSON.stringify(reports));
    assert.ok(reports.some((r) => r.state === 'WORKING' && r.draft === 'Not right. Confirm'), 'the reply shows while it is written');
    const last = reports.at(-1);
    assert.equal(last.state, 'DONE');
    assert.deepEqual(last.steps, ['checking call in-confi…', 'reading OrderMapper.java:58', 'writing the reply']);
    assert.equal(last.draft, 'Not right. Confirm returned 437.50 but the booking saved 412.00.');
    assert.equal(last.outcome, '→ replied; the saved fare is the search fare');
    assert.equal(new Set(reports.map((r) => r.id)).size, 1);

    assert.match(lines[0], /^#1 "Fare changes at confirm"  You: is the fare right after confirm\?$/);
    assert.ok(lines.includes('  ✦ working on your question on #1…'));
    assert.ok(lines.includes('    · reading OrderMapper.java:58'));
    assert.ok(lines.some((l) => /^  → ✦ Claude \(\d+ s\): Not right\. Confirm returned 437\.50/.test(l)), lines.join('\n'));

    const sent = JSON.parse(readFileSync(promptFile, 'utf8')) as { prompt: string; args: string[] };
    assert.match(sent.prompt, /You are Alfred live/);
    assert.match(sent.prompt, /"userDid"/);
    assert.ok(sent.args.includes('--strict-mcp-config') && sent.args.includes('stream-json'));
    assert.deepEqual(sent.args.slice(sent.args.indexOf('--model'), sent.args.indexOf('--model') + 2), ['--model', 'sonnet']);
  } finally { await w.close(); }
});

test('a move to To do is noted without a run; a paused board answers nothing', async () => {
  const { w, runner, lines } = await runnerWorld();
  try {
    w.fake.board.changes = { entries: [change({ id: 3, kind: 'STATUS', oldValue: 'INBOX', newValue: 'TO_DO', text: null })], cycles: [], cursor: '3.1', more: false };
    await runner.once('2.1');
    assert.equal(w.fake.board.liveWork.length, 1);
    assert.equal(w.fake.board.liveWork[0].state, 'DONE');
    assert.match(w.fake.board.liveWork[0].outcome, /^Noted - you moved it Inbox → To do\.$/);
    assert.ok(lines.includes('  → ✦ Noted - you moved it Inbox → To do.'));

    w.fake.board.agentState = 'PAUSED';
    w.fake.board.liveWork.length = 0;
    await runner.once('3.1');
    assert.equal(w.fake.board.liveWork.length, 0);
    assert.match(lines.at(-1)!, /paused on the board - 1 change\(s\) not answered/);
  } finally { await w.close(); }
});

test('a failed run says so on the card and in the log', async () => {
  const { w, runner, lines } = await runnerWorld('fail');
  try {
    await runner.once('now');
    const last = w.fake.board.liveWork.at(-1);
    assert.equal(last.state, 'FAILED');
    assert.equal(last.outcome, 'API Error: overloaded');
    assert.ok(lines.includes('  ⚠ #1 failed: API Error: overloaded'));
  } finally { await w.close(); }
});

test('Stop on the card ends the run at its next report', async () => {
  const { w, runner, lines } = await runnerWorld('slow');
  try {
    const started = Date.now();
    const running = runner.once('now');
    for (let i = 0; i < 100 && !w.fake.board.liveWork.length; i++) await new Promise((r) => setTimeout(r, 50));
    w.fake.board.liveStop.add(w.fake.board.liveWork[0].id);
    await running;
    assert.ok(Date.now() - started < 15_000, 'stopped, not waited out');
    assert.equal(w.fake.board.liveWork.at(-1).state, 'STOPPED');
    assert.ok(lines.some((l) => /■ #1 stopped after/.test(l)));
  } finally { await w.close(); }
});

test('live_start runs the runner as its own process; live_status sees it; live_stop ends it', async () => {
  const w = await world();
  try {
    w.fake.board.changes = { entries: [], cycles: [], cursor: '1.1', more: false };
    const dir = mkdtempSync(join(tmpdir(), 'live-start-'));
    const started = await w.call('live_start', { project: 'p-start-test', cwd: dir });
    assert.equal(started.isError, false, started.text);
    assert.equal(started.json.started, true);
    assert.match(started.json.watch, /^tail -n 0 -F ".+alfred-live-.+\.log"$/);
    const again = await w.call('live_start', { project: 'p-start-test', cwd: dir });
    assert.equal(again.json.alreadyRunning, true);
    let status: any;
    for (let i = 0; i < 60; i++) {
      status = (await w.call('live_status', { project: 'p-start-test' })).json;
      if (status.last.some((l: string) => l.includes('Live on for p-start-test'))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(status.running, true);
    assert.ok(status.last.some((l: string) => l.includes('Live on for p-start-test')), JSON.stringify(status));
    const stopped = await w.call('live_stop', { project: 'p-start-test' });
    assert.equal(stopped.json.stopped, true);
    assert.equal((await w.call('live_status', { project: 'p-start-test' })).json.running, false);
    assert.match((await w.call('live_start', { project: 'x', cwd: join(dir, 'nope') })).text, /is not a folder/);
  } finally { await w.close(); }
});
