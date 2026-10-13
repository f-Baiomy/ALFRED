import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { AlfredClient } from '../src/alfred-client.ts';
import type { CallRecord } from '../src/frontend.ts';
import { serveHttp } from '../src/http.ts';
import { createServer } from '../src/server.ts';
import { session } from '../src/session.ts';
import { FakeAlfred } from './fake-alfred.ts';
import { seed } from './fixtures.ts';

/**
 * The /alfred-listen runner (skills/alfred-listen/alfred-listen.mjs): one MCP connection that waits and runs check_calls
 * with no model; a clean batch ends there, a flagged one (or the user's comment) gets one fresh run with the batch and the
 * last run's STATE; stop sweeps in the same connection and runs review's finish once.
 */

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../skills/alfred-listen/alfred-listen.mjs', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url));
// A plain .mjs with no types: imported by a computed path so the type check leaves it alone.
const listen: any = await import(pathToFileURL(SCRIPT).href);

const T = Date.parse('2026-10-13T09:00:00Z');
const CY = 'cy-listen';

function call(id: string, s: number, path: string, status = 200, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    id, method: 'GET', timestamp: new Date(T + s * 1000).toISOString(), duration_ms: 200, state: 'COMPLETED', source: 'internal', service_name: 'odeysys',
    original_url: `http://localhost:8080${path}`, url: `http://host.docker.internal:9001${path}`,
    request: { headers: {}, body: '' }, response: { status, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }, ...extra,
  };
}

function addToCycle(fake: FakeAlfred, record: CallRecord): void {
  fake.addCall('internal', record);
  fake.state.cycleEntries.get(CY)!.push({ source: 'internal', record, capturedId: `cap-${record.id}`, capturedAt: record.timestamp } as never);
}

async function listenWorld() {
  const fake = await new FakeAlfred().start();
  seed(fake);
  session.maskSecrets = false;
  const first = [call('in-ok-1', 0, '/api/search'), call('in-err-1', 5, '/api/confirm', 500, { error: 'boom' })];
  for (const r of first) fake.addCall('internal', r);
  fake.addCycle({ id: CY, name: 'Listen check', status: 'RECORDING' }, first.map((record) => ({ source: 'internal', record })));
  fake.board.changes = { entries: [], cycles: [], cursor: '1.1', more: false };
  const http = await serveHttp(0, () => createServer(new AlfredClient(fake.url)));
  const entry = { type: 'http', url: `http://127.0.0.1:${http.port}/mcp` };
  const dir = mkdtempSync(join(tmpdir(), 'listen-runner-'));
  const promptFile = join(dir, 'prompt.json');
  process.env['FAKE_CLAUDE_MODE'] = 'listen';
  process.env['FAKE_CLAUDE_PROMPT'] = promptFile;
  const lines: string[] = [];
  const chat: string[] = [];
  const mcp = new listen.McpClient(entry, { cwd: dir });
  const runner = new listen.ListenRunner({
    alfred: new (await import(pathToFileURL(fileURLToPath(new URL('../../skills/alfred-live/alfred-live.mjs', import.meta.url))).href)).Alfred(fake.url),
    mcp, server: 'alfred-t', mcpEntry: entry, cycleId: CY, project: 'odeysys', cwd: dir, claude: process.execPath, claudeArgs: [FAKE],
    log: (l: string) => lines.push(l), chat: (l: string) => chat.push(l), mcpConfigFile: join(dir, 'mcp.json'), stateFile: join(dir, 'state.json'), waitSec: 1, settleSec: 0, host: 'fathy-laptop',
  });
  const close = async () => { mcp.close(); await http.close(); await fake.stop(); };
  const prompt = () => JSON.parse(readFileSync(promptFile, 'utf8')) as { prompt: string; args: string[] };
  return { fake, runner, mcp, lines, chat, dir, prompt, close, entry };
}

test('a batch needs the model only when a group is flagged, the user changed something, or the brief changed', () => {
  assert.equal(listen.needsRun({ totalGroups: 0, board: { changes: [], cycleChanges: [] } }), false);
  assert.equal(listen.needsRun({ totalGroups: 2 }), true);
  assert.equal(listen.needsRun({ totalGroups: 0, board: { changes: ['#3 You: why?'] } }), true);
  assert.equal(listen.needsRun({ totalGroups: 0, board: { changes: ['#3 You: why?'], live: '/alfred-live is answering' } }), false);
  assert.equal(listen.needsRun({ totalGroups: 0, board: { changes: [], cycleChanges: ['brief edited'] } }), true);
  assert.deepEqual(listen.batchOf('head\n\n{"checked":3,"next":null}'), { checked: 3, next: null });
  assert.throws(() => listen.batchOf('no json here'), /without its summary line/);
  assert.equal(listen.cleanLine('x\nClean (3): #1-3\ny'), 'Clean (3): #1-3');
  assert.equal(listen.stateOf('→ done\n<<<STATE\nflows: a\nSTATE>>>'), 'flows: a');
  assert.equal(listen.stateOf('no state'), null);
  assert.deepEqual(listen.findingsOf('→ x\n• #1 BUG a\nnot this\n<<<STATE\n• inside state\nSTATE>>>\n• #2 TASK b'), ['• #1 BUG a', '• #2 TASK b']);
  assert.equal(listen.cardsAddedBy('mcp__alfred__board_add_many', { cards: [{}, {}, {}] }), 3);
  assert.equal(listen.cardsAddedBy('mcp__alfred__board_add', {}), 1);
  assert.equal(listen.cardsAddedBy('mcp__alfred__board_link', {}), 0);
});

test('the MCP client speaks to the server over stdio and over HTTP, and reads a tool error as an error', async () => {
  const w = await listenWorld();
  const stdio = new listen.McpClient({ command: process.execPath, args: [TSX, INDEX], env: { ALFRED_URL: w.fake.url } }, { cwd: w.dir });
  try {
    for (const c of [w.mcp, stdio]) {
      const text = await c.call('check_calls', { cycle: CY });
      const json = listen.batchOf(text);
      assert.equal(json.checked, 2, text);
      assert.equal(json.totalGroups, 1, text);
      await assert.rejects(c.call('check_calls', { cycle: CY, waitSec: 5 }), /waitSec waits for the calls after sinceCallId/);
    }
  } finally { stdio.close(); await w.close(); }
});

test('the first batch is judged by one run; a clean batch after it costs no run; the STATE carries to the next run', async () => {
  const w = await listenWorld();
  try {
    await w.runner.once();
    const first = w.prompt();
    assert.match(first.prompt, /# Alfred listen - one batch/);
    assert.match(first.prompt, /THE BATCH \(check_calls output, every page\)/);
    assert.match(first.prompt, /\/api\/confirm/);
    assert.match(first.prompt, /none yet - the first batch/);
    assert.ok(first.args.includes('--strict-mcp-config') && first.args.includes('mcp__alfred-t'));
    assert.ok(w.lines.some((l) => /^batch 1 · 2 calls · 1 flagged in 1 group$/.test(l)), w.lines.join('\n'));
    assert.ok(w.lines.includes('    · → adding cards'));
    assert.ok(w.lines.some((l) => /→ ✦ Claude \(\d+ s\): batch: 2 cards · 1 fine/.test(l)), w.lines.join('\n'));
    assert.equal(w.runner.s.cards, 2);
    assert.match(w.runner.s.state, /flow search→book/);
    const statuses = w.fake.requests('PUT', '/board/agent-status').map((r) => r.body);
    assert.ok(statuses.some((b: any) => /judging batch 1 · → adding cards/.test(b.step)), JSON.stringify(statuses));
    assert.ok(statuses.some((b: any) => b.callsChecked === 2 && b.cardsAdded === 2 && b.cycleId === CY));

    // a clean call: checked in the same connection, no run
    writeFileSync(join(w.dir, 'prompt.json'), '{}');
    addToCycle(w.fake, call('in-ok-2', 30, '/api/view'));
    await w.runner.once();
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'prompt.json'), 'utf8')), {}, 'no run for a clean batch');
    assert.ok(w.lines.some((l) => /^batch 2 · 1 calls · all clean +\(no run\)$/.test(l)), w.lines.join('\n'));
    assert.equal(w.runner.s.cleanSince.length, 1);
    // the session's chat log: the start and what the judged batch found, with its evidence - no steps, no clean batch
    assert.deepEqual(w.chat, ['batch 1 · 2 calls → batch: 2 cards · 1 fine',
      '  • #14 BUG GET /api/confirm 500 - boom (call #2)', '  • #15 TASK no log line for the 500 (call #2)']);

    // the user's comment: a run, given the last STATE and the clean batch to mark
    w.fake.board.changes = { entries: [{ id: 9, actor: 'USER', kind: 'COMMENT', text: 'is #2 right?', oldValue: null, newValue: null, at: '2026-10-13T09:01:00Z',
      project: 'odeysys', number: 4, title: 'Confirm fails', status: 'INBOX', cycleId: CY, cardId: 'card-1', replyTo: null }], cycles: [], cursor: '9.1', more: false } as never;
    addToCycle(w.fake, call('in-ok-3', 40, '/api/view'));
    await w.runner.once();
    const third = w.prompt();
    assert.match(third.prompt, /STATE \(from the last run\):\nflow search→book/);
    assert.match(third.prompt, /CLEAN BATCHES SINCE THE LAST RUN/);
    assert.equal(w.runner.s.cleanSince.length, 0);
    assert.equal(w.runner.s.boardCursor, '9.1');
  } finally { await w.close(); }
});

test('with /alfred-live answering, the user\'s changes alone start no run', async () => {
  const w = await listenWorld();
  try {
    await w.runner.once();
    writeFileSync(join(w.dir, 'prompt.json'), '{}');
    w.fake.board.runner = { project: 'odeysys', host: 'fathy-laptop', model: null };
    w.fake.board.changes = { entries: [{ id: 9, actor: 'USER', kind: 'COMMENT', text: 'hi', oldValue: null, newValue: null, at: '2026-10-13T09:01:00Z',
      project: 'odeysys', number: 4, title: 'Confirm fails', status: 'INBOX', cycleId: CY, cardId: 'card-1', replyTo: null }], cycles: [], cursor: '9.1', more: false } as never;
    addToCycle(w.fake, call('in-ok-2', 30, '/api/view'));
    await w.runner.once();
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'prompt.json'), 'utf8')), {});
    assert.ok(w.lines.some((l) => /1 change of yours \(left to \/alfred-live\) +\(no run\)/.test(l)), w.lines.join('\n'));
  } finally { await w.close(); }
});

test('paused on the board: a flagged batch waits and is judged with the next run', async () => {
  const w = await listenWorld();
  try {
    w.fake.board.agentState = 'PAUSED';
    writeFileSync(join(w.dir, 'prompt.json'), '{}');
    await w.runner.once();
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'prompt.json'), 'utf8')), {});
    assert.equal(w.runner.s.held.length, 1);
    w.fake.board.agentState = 'WATCHING';
    addToCycle(w.fake, call('in-err-2', 30, '/api/pay', 502));
    await w.runner.once();
    const p = w.prompt().prompt;
    assert.match(p, /\/api\/confirm/, 'the held batch');
    assert.match(p, /\/api\/pay/, 'and the new one');
  } finally { await w.close(); }
});

test('stop: the sweep runs in the same connection, then review\'s finish once', async () => {
  const w = await listenWorld();
  try {
    await w.runner.once();
    w.runner.stop();
    await w.runner.run();
    const p = w.prompt().prompt;
    assert.match(p, /# Alfred listen - stop/);
    assert.match(p, /THE SWEEP \(check_calls sweep: true, every page\)/);
    assert.match(p, /STATE \(from the last run\):\nflow search→book/);
    assert.ok(w.lines.some((l) => /sweep · 0 calls never checked or changed since/.test(l)), w.lines.join('\n'));
    assert.ok(w.lines.some((l) => /● Listen stopped · 2 calls/.test(l)), w.lines.join('\n'));
    // the session's chat log at stop: start, the finish's findings, stopped - not the sweep's bookkeeping
    assert.match(w.chat[0], /^batch 1 · 2 calls → /);
    assert.ok(w.chat.some((l) => /^● Listening to cycle cy-listen/.test(l)), w.chat.join('\n'));
    assert.ok(w.chat.includes('finish → finish: 2 cards · 1 fine'), w.chat.join('\n'));
    assert.match(w.chat.at(-1)!, /^● Listen stopped · /);
    assert.ok(!w.chat.some((l) => /sweep ·|    · /.test(l)), w.chat.join('\n'));
    const last = w.fake.requests('PUT', '/board/agent-status').at(-1)!.body as any;
    assert.equal(last.state, 'STOPPED');
  } finally { await w.close(); }
});

test('start runs the runner on this machine with its own stdio MCP server; stop finishes and ends it', async () => {
  const fake = await new FakeAlfred().start();
  seed(fake);
  const first = [call('in-ok-1', 0, '/api/search'), call('in-err-1', 5, '/api/confirm', 500, { error: 'boom' })];
  for (const r of first) fake.addCall('internal', r);
  fake.addCycle({ id: CY, name: 'Listen check', status: 'RECORDING' }, first.map((record) => ({ source: 'internal', record })));
  fake.board.changes = { entries: [], cycles: [], cursor: '1.1', more: false };
  try {
    const dir = mkdtempSync(join(tmpdir(), 'listen-start-'));
    const config = join(dir, '.claude.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { 'alfred-t': { command: process.execPath, args: [TSX, INDEX], env: { ALFRED_URL: fake.url } } } }));
    process.env['FAKE_CLAUDE_MODE'] = 'listen';
    process.env['FAKE_CLAUDE_PROMPT'] = join(dir, 'prompt.json');
    const cli = async (...a: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [SCRIPT, ...a, '--server', 'alfred-t', '--cycle', CY, '--config', config, '--cwd', dir])).stdout);
    const started = await cli('start', '--project', 'odeysys', '--claude', FAKE, '--wait', '1', '--settle', '0');
    assert.equal(started.started, true);
    assert.equal(started.alfred, fake.url);
    assert.equal((await cli('start', '--project', 'odeysys')).alreadyRunning, true);
    const until = async (re: RegExp) => {
      for (let i = 0; i < 160; i++) {
        const s = await cli('status', '--lines', '60');
        if (s.last.some((l: string) => re.test(l))) return s;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.fail(`never logged ${re}: ${JSON.stringify((await cli('status', '--lines', '60')).last)}`);
    };
    const s = await until(/→ ✦ Claude \(\d+ s\): batch: 2 cards/);
    assert.equal(s.running, true);
    assert.equal((await cli('stop')).stopping, true);
    await until(/● Listen stopped/);
    for (let i = 0; i < 40 && (await cli('status')).running; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal((await cli('status')).running, false);
    assert.match(JSON.parse(readFileSync(join(dir, 'prompt.json'), 'utf8')).prompt, /# Alfred listen - stop/);
  } finally { await fake.stop(); }
});
