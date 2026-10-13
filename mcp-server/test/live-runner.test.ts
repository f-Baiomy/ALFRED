import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { ChangeRow } from '../src/tools/board.ts';
import { world } from './harness.ts';

/**
 * The /alfred-live runner (skills/alfred-live/alfred-live.mjs): runs on the user's machine whatever machine Alfred is on,
 * keeps a warm claude process so an answer starts the moment a change arrives, answers each card with one fresh run,
 * cards in parallel, and shows every step as it happens.
 */

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../skills/alfred-live/alfred-live.mjs', import.meta.url));
// A plain .mjs with no types: imported by a computed path so the type check leaves it alone.
const live: any = await import(pathToFileURL(SCRIPT).href);

const change = (over: Partial<ChangeRow>): ChangeRow => ({
  id: 2, actor: 'USER', kind: 'COMMENT', text: 'is the fare right after confirm?', oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z',
  project: 'p', number: 1, title: 'Fare changes at confirm', status: 'INBOX', cycleId: null, cardId: 'card-1', replyTo: null, ...over,
} as ChangeRow);

test('each tool call reads as a step; the reply is read from its partial JSON as it is written', () => {
  assert.equal(live.stepLabel('mcp__alfred__investigate_call', { callId: 'in-confirm-123456789' }), 'checking call in-confi…');
  assert.equal(live.stepLabel('mcp__alfred-lan-83__board_edit', { number: 12, kind: 'BUG' }), '→ editing #12 (kind → BUG)');
  assert.equal(live.stepLabel('Read', { file_path: 'C:/repo/src/OrderMapper.java', offset: 58 }), 'reading OrderMapper.java:58');
  assert.equal(live.stepLabel('mcp__alfred__board_reply', {}), 'writing the reply');
  assert.equal(live.stepLabel('Bash', { command: 'codegraph explore "x"' }), 'exploring the code graph');
  assert.equal(live.draftOf('{"project":"p","text":"Not right. Confirm ret'), 'Not right. Confirm ret');
  assert.equal(live.draftOf('{"text":"line one\\nline \\"two\\""}'), 'line one\nline "two"');
  assert.equal(live.draftOf('{"project":"p"'), null);
  assert.equal(live.failureKind('API Error: 429 rate limit'), 'limit');
  assert.equal(live.failureKind('Prompt is too long'), 'too-long');
  assert.equal(live.failureKind('API Error: overloaded'), 'transient');
  assert.ok(live.WRITE_TOOLS.test('mcp__alfred__board_reply') && live.WRITE_TOOLS.test('mcp__x__add_comments') && !live.WRITE_TOOLS.test('mcp__x__board_get'));
});

test('what the user did picks the head; moves and closes are only noted, no run', () => {
  const never = () => false;
  assert.deepEqual(live.headOf([change({})], never), { head: 'working on your question', quiet: false });
  assert.deepEqual(live.headOf([change({ replyTo: 1 })], () => true), { head: 'acting on your answer', quiet: false });
  assert.deepEqual(live.headOf([change({ kind: 'STATUS', oldValue: 'IN_PROGRESS', newValue: 'FIXED' })], never), { head: 'preparing the re-test', quiet: false });
  assert.equal(live.headOf([change({ kind: 'STATUS', newValue: 'TO_DO' })], never).quiet, true);
  assert.equal(live.headOf([change({ kind: 'RESOLUTION', newValue: 'FINE' })], never).quiet, true);
  assert.equal(live.youDid(change({ kind: 'STATUS', oldValue: 'IN_PROGRESS', newValue: 'FIXED' })), 'You moved it In progress → Fixed');
});

test('Alfred\'s address comes from the MCP server as Claude Code has it registered - a LAN Alfred or a local one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-config-'));
  const config = join(dir, '.claude.json');
  writeFileSync(config, JSON.stringify({
    mcpServers: { 'alfred-lan-83': { type: 'http', url: 'http://192.168.1.83:3000/mcp' }, alfred: { command: 'node', env: { ALFRED_URL: 'http://localhost:3001' } } },
    projects: { [dir]: { mcpServers: { here: { command: 'node', env: {} } } } },
  }));
  assert.equal(live.alfredUrlOf(live.serverEntry('alfred-lan-83', dir, config)), 'http://192.168.1.83:3000');
  assert.equal(live.alfredUrlOf(live.serverEntry('alfred', dir, config)), 'http://localhost:3001');
  assert.equal(live.alfredUrlOf(live.serverEntry('here', dir, config)), 'http://localhost:3000');
  assert.throws(() => live.serverEntry('nope', dir, config), /no MCP server "nope"/);
});

test('the reporter sends the latest state only, clamps it, and hands back the user\'s Stop', async () => {
  const w = await world();
  try {
    let stopped = 0;
    const r = new live.Reporter(new live.Alfred(w.fake.url), { id: 'r1', project: 'p', cardNumber: 1, head: 'h' }, { every: 10, tick: 50, onStop: () => stopped++ });
    r.report({ steps: ['a'], state: 'WORKING' });
    r.report({ steps: Array.from({ length: 60 }, (_, i) => `s${i}`), draft: 'd', state: 'WORKING' });
    await new Promise((x) => setTimeout(x, 150));
    assert.ok(w.fake.board.liveWork.length >= 1 && w.fake.board.liveWork.length <= 5, 'the first at once, the rest coalesced and ticked');
    assert.equal(w.fake.board.liveWork.at(-1).steps.length, 40, 'clamped to what the service keeps');
    assert.equal(w.fake.board.liveWork.at(-1).draft, 'd', 'the latest state, with the draft');
    w.fake.board.liveStop.add('r1');
    await new Promise((x) => setTimeout(x, 400));
    assert.equal(r.stop, true);
    assert.equal(stopped, 1);
    await r.end({ steps: [], state: 'DONE', outcome: 'x'.repeat(600) });
    assert.equal(w.fake.board.liveWork.at(-1).outcome.length, 480);
  } finally { await w.close(); }
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
  const chat: string[] = [];
  const runner = new live.Runner({
    alfred: new live.Alfred(w.fake.url), server: 'alfred-lan-83', mcpEntry: { type: 'http', url: `${w.fake.url}/mcp` }, project: 'p', cwd: dir,
    claude: process.execPath, claudeArgs: [FAKE], mcpConfigFile: join(dir, 'mcp.json'), host: 'fathy-laptop', parallel: 2, warm: false,
    log: (l: string) => { lines.push(l); if (process.env['LIVE_DEBUG']) console.error(Date.now() % 100000, l); }, chat: (l: string) => chat.push(l), settleMs: 0, waitSeconds: 1, draftEveryMs: 0, model: 'sonnet', reportEveryMs: 5,
  });
  const close = async () => { runner.pool.close(); await w.close(); };
  return { w, runner, lines, chat, promptFile, dir, close };
}

test('a comment: one fresh run on a warm process, each step and the reply reported to the card as they happen, one line each in the log', async () => {
  const { w, runner, lines, chat, promptFile, dir, close } = await runnerWorld();
  try {
    assert.equal(await runner.once('now'), '2.1');
    await runner.idle();
    const reports = w.fake.board.liveWork;
    assert.equal(reports[0].state, 'WORKING');
    assert.equal(reports[0].cardNumber, 1);
    assert.ok(reports.some((r) => r.state === 'WORKING' && r.head === 'working on your question'), JSON.stringify(reports));
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
    // the session's chat log: one line - what the user did and the answer - no steps, no "working on"
    assert.deepEqual(chat, ['#1 "Fare changes at confirm" · You: is the fare right after confirm? → Claude: Not right. Confirm returned 437.50 '
      + 'but the booking saved 412.00. → replied; the saved fare is the search fare']);

    const sent = JSON.parse(readFileSync(promptFile, 'utf8')) as { prompt: string; args: string[] };
    assert.match(sent.prompt, /You are Alfred live/);
    assert.match(sent.prompt, /mcp__alfred-lan-83__board_reply/);
    assert.match(sent.prompt, /- You: is the fare right after confirm\?/);
    assert.ok(sent.args.includes('--strict-mcp-config') && sent.args.includes('stream-json') && sent.args.includes('--input-format'));
    assert.deepEqual(sent.args.slice(sent.args.indexOf('--allowedTools'), sent.args.indexOf('--allowedTools') + 2), ['--allowedTools', 'mcp__alfred-lan-83']);
    assert.ok(sent.args.includes('Bash(git diff:*)') && sent.args.includes('--tools'), 'read-only code tools, git diff and codegraph allowed');
    assert.deepEqual(sent.args.slice(sent.args.indexOf('--model'), sent.args.indexOf('--model') + 2), ['--model', 'sonnet']);
    // The run gets the user's own registration of that server - the same tools, from this machine.
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')), { mcpServers: { 'alfred-lan-83': { type: 'http', url: `${w.fake.url}/mcp` } } });
  } finally { await close(); }
});

test('an answer to Claude\'s question is acted on', async () => {
  const { w, runner, close } = await runnerWorld();
  try {
    w.fake.board.changes = { entries: [change({ id: 3, text: 'yes, it may', replyTo: 1 })], cycles: [], cursor: '3.1', more: false };
    await runner.once('2.1');
    await runner.idle();
    assert.ok(w.fake.board.liveWork.some((r) => r.head === 'acting on your answer'));
  } finally { await close(); }
});

test('a move to To do is noted without a run; a paused board keeps the cursor so the changes are answered on resume', async () => {
  const { w, runner, lines, close } = await runnerWorld();
  try {
    w.fake.board.changes = { entries: [change({ id: 3, kind: 'STATUS', oldValue: 'INBOX', newValue: 'TO_DO', text: null })], cycles: [], cursor: '3.1', more: false };
    await runner.once('2.1');
    await runner.idle();
    assert.equal(w.fake.board.liveWork.at(-1).state, 'DONE');
    assert.match(w.fake.board.liveWork.at(-1).outcome, /^Noted - you moved it Inbox → To do\.$/);
    assert.ok(lines.includes('  → ✦ Noted - you moved it Inbox → To do.'));

    w.fake.board.agentState = 'PAUSED';
    w.fake.board.liveWork.length = 0;
    assert.equal(await runner.once('3.1'), '3.1', 'the cursor stays before the unanswered changes');
    assert.equal(w.fake.board.liveWork.length, 0);
    assert.ok(lines.some((l) => /paused on the board - 1 change\(s\) wait for the resume/.test(l)), lines.join('\n'));
  } finally { await close(); }
});

test('a failed run is tried again; a run that answers in text only is told to post it', async () => {
  const { w, runner, lines, close } = await runnerWorld('fail-once');
  try {
    await runner.once('now');
    await runner.idle();
    const last = w.fake.board.liveWork.at(-1);
    assert.equal(last.state, 'DONE', JSON.stringify(w.fake.board.liveWork.map((r) => [r.state, r.outcome])));
    assert.ok(lines.some((l) => /failed: API Error: overloaded - trying again in 5 s/.test(l)), lines.join('\n'));
  } finally { await close(); }
});

test('a run that posts nothing on the board gets one more try, then is reported', async () => {
  const { w, runner, lines, close } = await runnerWorld('text-only');
  try {
    await runner.once('now');
    await runner.idle();
    assert.ok(lines.some((l) => /no reply posted - once more/.test(l)), lines.join('\n'));
    assert.equal(w.fake.board.liveWork.at(-1).state, 'DONE'); // the second try also answers in text; nothing refused -> done with its summary
  } finally { await close(); }
});

test('Stop on the card ends the run within a second', async () => {
  const { w, runner, lines, close } = await runnerWorld('slow');
  try {
    const started = Date.now();
    await runner.once('now');
    for (let i = 0; i < 100 && !w.fake.board.liveWork.length; i++) await new Promise((r) => setTimeout(r, 50));
    w.fake.board.liveStop.add(w.fake.board.liveWork[0].id);
    await runner.idle();
    assert.ok(Date.now() - started < 8_000, 'stopped, not waited out');
    assert.equal(w.fake.board.liveWork.at(-1).state, 'STOPPED');
    assert.ok(lines.some((l) => /■ #1 stopped after/.test(l)));
  } finally { await close(); }
});

test('two cards are answered at the same time; a third waits visibly for a slot', async () => {
  const { w, runner, close } = await runnerWorld('slow');
  try {
    w.fake.board.changes = { entries: [change({ id: 5, number: 1 }), change({ id: 6, number: 2, title: 'Second', cardId: 'card-2' }), change({ id: 7, number: 3, title: 'Third', cardId: 'card-3' })],
      cycles: [], cursor: '7.1', more: false };
    await runner.once('now');
    for (let i = 0; i < 100 && w.fake.board.liveWork.filter((r) => r.state === 'WORKING').length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    const working = w.fake.board.liveWork.filter((r) => r.state === 'WORKING');
    assert.deepEqual([...new Set(working.map((r) => r.cardNumber))].sort(), [1, 2, 3]);
    assert.ok(working.some((r) => r.head === 'waiting its turn'), 'the third card is visible while it waits');
    runner.stop();
    await runner.idle();
  } finally { await close(); }
});

test('the heartbeat is in Alfred and beats while runs are long: board_wait in any session sees the runner', async () => {
  const { w, runner, close } = await runnerWorld();
  try {
    await runner.beat();
    assert.deepEqual(w.fake.board.runner, { project: 'p', host: 'fathy-laptop', model: 'sonnet', kind: 'live' });
    w.fake.board.changes = { entries: [], cycles: [], cursor: '9.1', more: false };
    const waited = await w.call('board_wait', { project: 'p', timeoutSeconds: 1 });
    assert.match(waited.json.live, /answering the user on this board \(from fathy-laptop\)/);
    await runner.beat(true);
    assert.equal((await w.call('board_wait', { project: 'p', timeoutSeconds: 1 })).json.live, undefined);
  } finally { await close(); }
});

test('start runs the runner in the background on this machine; status sees it; stop ends it', async () => {
  const w = await world();
  try {
    w.fake.board.changes = { entries: [], cycles: [], cursor: '1.1', more: false };
    const dir = mkdtempSync(join(tmpdir(), 'live-start-'));
    const config = join(dir, '.claude.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { 'alfred-lan': { type: 'http', url: `${w.fake.url}/mcp` } } }));
    const cli = async (...a: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [SCRIPT, ...a, '--server', 'alfred-lan', '--project', 'p-start-test', '--config', config, '--cwd', dir, '--claude', FAKE])).stdout);
    const started = await cli('start');
    assert.equal(started.started, true);
    assert.equal(started.alfred, w.fake.url);
    assert.match(started.watch, /^tail -n 0 -F ".+\.chat\.log"$/);
    assert.equal((await cli('start')).alreadyRunning, true);
    let status: any;
    for (let i = 0; i < 60; i++) {
      status = await cli('status');
      if (status.last.some((l: string) => l.includes('Live on for p-start-test'))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(status.running, true);
    assert.ok(status.last.some((l: string) => l.includes('Live on for p-start-test')), JSON.stringify(status));
    assert.equal(w.fake.board.runner?.project, 'p-start-test');
    assert.equal((await cli('stop')).stopped, true);
    assert.equal((await cli('status')).running, false);
    assert.equal(w.fake.board.runner, null);
    // another machine already answers this board: refused
    w.fake.board.runner = { project: 'p-start-test', host: 'other-pc', model: null, kind: 'live' };
    await assert.rejects(cli('start'), /already answers this board from other-pc/);
  } finally { await w.close(); }
});
