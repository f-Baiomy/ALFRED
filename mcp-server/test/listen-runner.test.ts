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
 * with no model; a clean batch ends there, a known group is linked in code, a flagged one becomes a judge job run on a
 * warm process with the context pack; the run's LEDGER is checked against the groups and failures stay queued; stop
 * sweeps, finds what has no outcome, and runs the finish phases.
 */

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../skills/alfred-listen/alfred-listen.mjs', import.meta.url));
const LIVE = fileURLToPath(new URL('../../skills/alfred-live/alfred-live.mjs', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const INDEX = fileURLToPath(new URL('../src/index.ts', import.meta.url));
// Plain .mjs files with no types: imported by a computed path so the type check leaves them alone.
const listen: any = await import(pathToFileURL(SCRIPT).href);
const live: any = await import(pathToFileURL(LIVE).href);

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

/** The cards the fake claude's LEDGER names, so the coverage check finds them on the board. */
function seedCards(fake: FakeAlfred): void {
  for (const [number, title] of [[14, 'a'], [15, 'b'], [9, 'older']] as const) {
    fake.board.cards.push({ id: `card-${number}`, project: 'odeysys', number, kind: 'BUG', title, description: '', status: 'INBOX', resolution: null, reason: null,
      flags: [], scope: 'NOT_DECIDED', author: 'CLAUDE', cycleId: CY, cycleDeleted: false, updatedAt: '2026-10-10T09:00:00Z', commentCount: 0, similarClosed: null,
      links: [{ type: 'call', ref: `in:in-err-1@${CY}`, label: 'confirm' }], teams: [] } as never);
  }
}

async function listenWorld(mode = 'listen') {
  const fake = await new FakeAlfred().start();
  seed(fake);
  session.maskSecrets = false;
  const first = [call('in-ok-1', 0, '/api/search'), call('in-err-1', 5, '/api/confirm', 500, { error: 'boom' })];
  for (const r of first) fake.addCall('internal', r);
  fake.addCycle({ id: CY, name: 'Listen check', status: 'RECORDING' }, first.map((record) => ({ source: 'internal', record })));
  fake.board.changes = { entries: [], cycles: [], cursor: '1.1', more: false };
  seedCards(fake);
  const http = await serveHttp(0, () => createServer(new AlfredClient(fake.url)));
  const entry = { type: 'http', url: `http://127.0.0.1:${http.port}/mcp` };
  const dir = mkdtempSync(join(tmpdir(), 'listen-runner-'));
  const promptFile = join(dir, 'prompt.json');
  process.env['FAKE_CLAUDE_MODE'] = mode;
  process.env['FAKE_CLAUDE_PROMPT'] = promptFile;
  const lines: string[] = [];
  const chat: string[] = [];
  const mcp = new listen.McpClient(entry, { cwd: dir });
  const runner = new listen.ListenRunner({
    alfred: new live.Alfred(fake.url), mcp, server: 'alfred-t', mcpEntry: entry, cycleId: CY, project: 'odeysys', cwd: dir, claude: process.execPath, claudeArgs: [FAKE],
    log: (l: string) => { lines.push(l); if (process.env['LIVE_DEBUG']) console.error(l); }, chat: (l: string) => chat.push(l), mcpConfigFile: join(dir, 'mcp.json'), stateFile: join(dir, 'state.json'),
    waitSec: 1, settleSec: 0, host: 'fathy-laptop', parallel: 2, warm: false, liveLane: false,
  });
  const close = async () => { runner.pool.close(); mcp.close(); await http.close(); await fake.stop(); };
  const prompt = () => JSON.parse(readFileSync(promptFile, 'utf8')) as { prompt: string; args: string[] };
  return { fake, runner, mcp, lines, chat, dir, prompt, close, entry };
}

test('a run\'s blocks are read: the ledger per group, the findings, the state, unsure, code and check lines', () => {
  const text = 'Judged.\n→ batch: 2 cards\n• #14 BUG x\n• #15 TASK y\nLEDGER\nG1 = card #14\nG2 = link #9\nG3 = fine: a 404 on purpose | recurs\nG4 = asked #17\nG5 = fine\nUNSURE\nbooking | fare.total | 412→437 | a,b | ask\nCODE\nGET /x | src/X.java:1 | copied\nCHECK\n- booking: fare may change\nSTATE\nflow a\n';
  const ledger = listen.ledgerOf(text);
  assert.deepEqual(ledger.get('G1'), { kind: 'card', card: 14 });
  assert.deepEqual(ledger.get('G2'), { kind: 'link', card: 9 });
  assert.deepEqual(ledger.get('G3'), { kind: 'fine', reason: 'a 404 on purpose', recurs: true });
  assert.deepEqual(ledger.get('G4'), { kind: 'asked', card: 17 });
  assert.deepEqual(ledger.get('G5'), { kind: 'fine', reason: 'no reason given', recurs: false });
  assert.deepEqual(listen.findingsOf(text), ['• #14 BUG x', '• #15 TASK y']);
  assert.equal(listen.stateOf(text), 'flow a');
  assert.deepEqual(listen.blockOf(text, 'UNSURE'), ['booking | fare.total | 412→437 | a,b | ask']);
  assert.deepEqual(listen.blockOf(text, 'CODE'), ['GET /x | src/X.java:1 | copied']);
  assert.deepEqual(listen.blockOf(text, 'CHECK'), ['- booking: fare may change']);
  assert.equal(listen.stateOf('old\n<<<STATE\nx\nSTATE>>>'), 'x');
  assert.deepEqual(listen.batchOf('head\n\n{"checked":3,"next":null}'), { checked: 3, next: null });
  assert.throws(() => listen.batchOf('no json here'), /without its summary line/);
  assert.equal(listen.cleanLine('x\nClean (3): #1-3\ny'), 'Clean (3): #1-3');
  assert.equal(listen.cardsAddedBy('mcp__alfred__board_add_many', { cards: [{}, {}, {}] }), 3);
});

test('groups are read from a check_calls reply and a batch text is cut to the groups named', () => {
  const text = 'head\n\nFlagged (3 calls in 2 groups):\nG1 · 2 calls · GET /a · HTTP_ERROR\n  #1 GET /a 500 id=in-a1\n    evidence\n  all 2: #1, #3\nG2 · 1 call · GET /b · LOG_ERROR\n  #2 GET /b id=in-b1\n\nClean (1): #4\n\n{"groups":[{"group":"G1","key":"k1","callIds":["in-a1","in-a3"],"endpoint":"GET /a"},{"group":"G2","key":"k2","callIds":["in-b1"],"endpoint":"GET /b"}],"next":null}';
  const groups = listen.groupsOf(text, listen.batchOf(text));
  assert.deepEqual(groups.map((g: any) => [g.id, g.key, g.endpoint, g.exampleCallId, g.callIds]), [['G1', 'k1', 'GET /a', 'in-a1', ['in-a1', 'in-a3']], ['G2', 'k2', 'GET /b', 'in-b1', ['in-b1']]]);
  assert.match(groups[0].block, /evidence/);
  const cut = listen.cutGroups(text, ['G2']);
  assert.ok(!cut.includes('G1 ·') && cut.includes('G2 ·') && cut.includes('Clean (1): #4') && cut.includes('"groups"'), cut);
  // without keys in the JSON the identity is the endpoint and its signals
  const noKeys = text.replace(/"key":"k\d",/g, '').replace('"endpoint":"GET /a"', '"endpoint":"GET /a","signals":["HTTP_ERROR"]');
  const old = listen.groupsOf(noKeys, listen.batchOf(noKeys));
  assert.equal(listen.keyOf(old[0]), 'GET /a|HTTP_ERROR');
  assert.equal(listen.needsRun({ totalGroups: 0 }, []), false);
  assert.equal(listen.needsRun({ totalGroups: 1, groups: [] }, [{ id: 'G1' }]), true);
  assert.equal(listen.needsRun({ totalGroups: 0, stale: [{ callId: 'x' }] }, []), true);
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
    assert.ok((await stdio.listTools()).includes('check_calls'));
  } finally { stdio.close(); await w.close(); }
});

test('the first batch is queued and judged by one run with the context pack; a clean batch costs no run; the blocks carry over', async () => {
  const w = await listenWorld();
  try {
    await w.runner.loadPack();
    assert.ok(w.runner.pack.teams, 'teams prefetched');
    assert.ok(w.runner.pack.cards.length >= 3, 'the cards of the cycle prefetched');
    await w.runner.once();
    assert.equal(w.runner.s.queue.length, 1, 'the batch is a judge job');
    assert.ok(w.lines.some((l) => /^batch 1 · 2 calls · 1 flagged in 1 group$/.test(l)), w.lines.join('\n'));
    await w.runner.judgeQueued();
    const first = w.prompt();
    assert.match(first.prompt, /THE BATCH \(check_calls output, every page\)/);
    assert.match(first.prompt, /\/api\/confirm/);
    assert.match(first.prompt, /TEAMS:/);
    assert.match(first.prompt, /CARDS OF THIS CYCLE ON THE BOARD/);
    assert.match(first.prompt, /STATE: none yet/);
    assert.ok(first.args.includes('--append-system-prompt-file'), 'the rules and batch.md ride in the system prompt');
    const system = readFileSync(first.args[first.args.indexOf('--append-system-prompt-file') + 1], 'utf8');
    assert.match(system, /# Alfred listen - one batch/);
    assert.match(system, /What becomes a card/);
    assert.ok(first.args.includes('--strict-mcp-config') && first.args.includes('mcp__alfred-t'));
    assert.ok(w.lines.includes('    · → adding 2 cards'));
    assert.ok(w.lines.some((l) => /→ ✦ Claude \(\d+ s\): batch: 2 cards · 1 fine/.test(l)), w.lines.join('\n'));
    assert.equal(w.runner.s.queue.length, 0, 'judged: gone from the queue');
    assert.equal(w.runner.s.cards, 2);
    assert.match(w.runner.s.narrative, /flow search→book/);
    assert.deepEqual(Object.values(w.runner.s.ledger).map((l: any) => [l.kind, l.card]), [['card', 14]]);
    assert.equal(w.runner.s.unsure.length, 1);
    assert.equal(w.runner.s.code['GET /api/confirm'], 'src/Confirm.java:12 | re-fetches the fare');
    assert.deepEqual(w.runner.s.checks, ['- booking: fare.total may change at confirm']);
    const statuses = w.fake.requests('PUT', '/board/agent-status').map((r) => r.body);
    assert.ok(statuses.some((b: any) => /judging batch 1 · /.test(b.step)), JSON.stringify(statuses));
    assert.ok(statuses.some((b: any) => b.callsChecked === 2 && b.cardsAdded === 2 && b.cycleId === CY), JSON.stringify(statuses));
    // the session's chat log: what the judged batch found, with its evidence - no steps
    assert.deepEqual(w.chat.filter((l) => !/^\s*⚠ capture:/.test(l)), ['batch 1 · 2 calls · 1 flagged in 1 group → batch: 2 cards · 1 fine',
      '  • #14 BUG GET /api/confirm 500 - boom (call #2)', '  • #15 TASK no log line for the 500 (call #2)']);

    // a clean call: checked in the same connection, no run
    writeFileSync(join(w.dir, 'prompt.json'), '{}');
    addToCycle(w.fake, call('in-ok-2', 30, '/api/view'));
    await w.runner.once();
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'prompt.json'), 'utf8')), {}, 'no run for a clean batch');
    assert.equal(w.runner.s.queue.length, 0);
    assert.ok(w.lines.some((l) => /^batch 2 · 1 calls · all clean +\(no run\)$/.test(l)), w.lines.join('\n'));
    assert.equal(w.runner.s.cleanSince.length, 1);

    // the next flagged batch (a new problem on a known endpoint) gets the pack with what was learned, and the clean batches to mark
    addToCycle(w.fake, call('in-err-2', 40, '/api/confirm', 503, { error: 'down' }));
    await w.runner.once();
    await w.runner.judgeQueued();
    const third = w.prompt();
    assert.match(third.prompt, /STATE \(from the last run\):\nflow search→book/);
    assert.match(third.prompt, /CLEAN BATCHES SINCE THE LAST RUN/);
    assert.match(third.prompt, /CODE NOTES FROM EARLIER RUNS/);
    assert.match(third.prompt, /UNSURE EXPECTATIONS/);
    assert.equal(w.runner.s.cleanSince.length, 0);
  } finally { await w.close(); }
});

test('batches renumbered into one waiting run keep their group ids apart', () => {
  const into = { kind: 'batch', batch: 1, text: 'G1 · 1 call · GET /a\n  x\n{"j":1}', groups: [{ id: 'G1' }], what: 'batch 1' };
  listen.mergeJob(into, { batch: 2, text: 'G1 · 1 call · GET /b\n  y\nG2 · 1 call · GET /c\n  z', groups: [{ id: 'G1' }, { id: 'G2' }], what: 'batch 2' });
  assert.deepEqual(into.groups.map((g: any) => g.id), ['G1', 'G2', 'G3']);
  assert.deepEqual((into as any).batches, [1, 2]);
  assert.match(into.text, /=== batch 2 \(its groups numbered from G2\) ===\nG2 · 1 call · GET \/b\n  y\nG3 · 1 call · GET \/c/);
  assert.equal(into.what, 'batch 1 + batch 2');
});

test('a flagged batch arriving while another waits joins its run; the run starts with each group\'s investigation', async () => {
  const w = await listenWorld();
  try {
    await w.runner.loadPack();
    await w.runner.once();
    addToCycle(w.fake, call('in-err-2', 40, '/api/pay', 503, { error: 'down' }));
    await w.runner.once();
    assert.equal(w.runner.s.queue.length, 1, 'one run for both batches');
    assert.deepEqual(w.runner.s.queue[0].batches, [1, 2]);
    assert.ok(w.lines.some((l) => /\+ batch 2 joins the run of batch 1, 2 \(2 groups\)/.test(l)), w.lines.join('\n'));
    await w.runner.judgeQueued();
    const { prompt } = w.prompt();
    assert.match(prompt, /=== batch 2 \(its groups numbered from G2\) ===/);
    assert.match(prompt, /EVIDENCE - investigate_call already ran on each group's example call/);
    assert.match(prompt, /G1 evidence - .*call in-err-1:/);
    assert.match(prompt, /G2 evidence - .*call in-err-2:/);
    assert.ok(w.lines.some((l) => /✦ judging batches 1, 2…/.test(l)), w.lines.join('\n'));
    assert.deepEqual(Object.values(w.runner.s.ledger).map((l: any) => [l.kind, l.card]).sort(), [['card', 14], ['link', 9]]);
  } finally { await w.close(); }
});

test('a group the ledger knows with its card still open is linked in code - no run', async () => {
  const w = await listenWorld();
  try {
    await w.runner.loadPack();
    await w.runner.once();
    await w.runner.judgeQueued();
    const key = Object.keys(w.runner.s.ledger)[0];
    assert.ok(key, 'the group has a key');
    writeFileSync(join(w.dir, 'prompt.json'), '{}');
    // the same problem again on a new call: same endpoint, same status
    addToCycle(w.fake, call('in-err-3', 60, '/api/confirm', 500, { error: 'boom' }));
    await w.runner.once();
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'prompt.json'), 'utf8')), {}, 'no run for a known group');
    assert.equal(w.runner.s.queue.length, 0);
    assert.ok(w.lines.some((l) => /1 known \(G1→#14\)/.test(l)), w.lines.join('\n'));
    assert.ok(w.fake.requests('POST', '/board/cards/card-14/links').length >= 1, 'the new call linked to the card');
    assert.equal(w.runner.s.ledger[key].seen, 2);
  } finally { await w.close(); }
});

test('a failed run keeps its batch queued and it is judged on the next try', async () => {
  const w = await listenWorld('fail-once');
  try {
    await w.runner.loadPack();
    await w.runner.once();
    await w.runner.judgeQueued();
    assert.equal(w.runner.s.queue.length, 0, JSON.stringify(w.runner.s.queue));
    assert.ok(w.lines.some((l) => /judging batch 1 failed: API Error: overloaded - again in 20 s/.test(l)), w.lines.join('\n'));
    assert.ok(w.lines.some((l) => /→ ✦ Claude \(\d+ s\): batch: 2 cards/.test(l)), 'the second try judged it');
    assert.equal(w.runner.s.cards, 2);
  } finally { await w.close(); }
});

test('groups the run left without an outcome get a second look, then wait for the stop', async () => {
  const w = await listenWorld();
  try {
    await w.runner.loadPack();
    // two flagged groups: the fake's LEDGER names a card for the first and a link to #9 for the second - but #9 is gone
    addToCycle(w.fake, call('in-err-2', 40, '/api/pay', 502));
    w.fake.board.cards = w.fake.board.cards.filter((c: any) => c.number !== 9);
    await w.runner.once();
    await w.runner.judgeQueued();
    assert.ok(w.lines.some((l) => /G2 without an outcome - a second look/.test(l)), w.lines.join('\n'));
    assert.equal(w.lines.filter((l) => /second look at batch 1…/.test(l)).length, 1, 'one second look, never more');
    assert.equal(w.runner.s.failed.length, 0, 'the second look gave it an outcome');
    assert.equal(Object.keys(w.runner.s.ledger).length, 2, 'both groups in the ledger');
  } finally { await w.close(); }
});

test('paused on the board: flagged batches wait in the queue; the user\'s changes go to the pack, never a listen run', async () => {
  const w = await listenWorld();
  try {
    await w.runner.loadPack();
    w.fake.board.agentState = 'PAUSED';
    await w.runner.once();
    assert.equal(w.runner.s.queue.length, 1);
    assert.ok(w.chat.some((l) => /paused on the board - flagged batches are held/.test(l)));
    w.fake.board.changes = { entries: [{ id: 9, actor: 'USER', kind: 'COMMENT', text: 'fare may change, that is fine', oldValue: null, newValue: null, at: '2026-10-13T09:01:00Z',
      project: 'odeysys', number: 14, title: 'a', status: 'INBOX', cycleId: CY, cardId: 'card-14', replyTo: null }], cycles: [], cursor: '9.1', more: false } as never;
    w.fake.board.agentState = 'WATCHING';
    await w.runner.once();
    assert.ok(w.runner.s.userChanges.some((u: string) => /fare may change/.test(u)), JSON.stringify(w.runner.s.userChanges));
    assert.equal(w.runner.s.queue.length, 1, 'a comment alone starts no judge job');
    await w.runner.judgeQueued();
    assert.match(w.prompt().prompt, /THE USER'S ANSWERS AND NOTES[\s\S]*fare may change/);
  } finally { await w.close(); }
});

test('stop: the queue drains, the sweep and the whole-cycle pass find what has no outcome, the finish phases run and are recorded', async () => {
  const w = await listenWorld();
  try {
    await w.runner.loadPack();
    await w.runner.once();
    w.runner.drainer = w.runner.drainLoop();
    w.runner.stop();
    await w.runner.finish();
    assert.deepEqual([w.runner.s.finish.sweep, w.runner.s.finish.p1, w.runner.s.finish.p2, w.runner.s.finish.p3, w.runner.s.finish.p4], [true, true, true, true, true]);
    assert.equal(w.runner.finishedOk, true);
    assert.ok(w.lines.some((l) => /sweep · \d+ calls never checked/.test(l)), w.lines.join('\n'));
    assert.ok(w.lines.some((l) => /whole-cycle pass · \d+ group\(s\)/.test(l)), w.lines.join('\n'));
    const steps = w.fake.requests('PUT', '/board/agent-status').map((r: any) => r.body.step);
    assert.ok(steps.some((s: string) => /finishing · steps and requirements/.test(s)), JSON.stringify(steps));
    assert.ok(w.chat.some((l) => /^stop · regressions and shape → /.test(l)), w.chat.join('\n'));
    assert.match(w.chat.at(-1)!, /^● Listen stopped · /);
    const last = w.fake.requests('PUT', '/board/agent-status').at(-1)!.body as any;
    assert.equal(last.state, 'STOPPED');
    assert.ok(w.fake.requests('POST', '/board/cycles/cy-listen/log').length >= 1, 'the session log is written in code');
  } finally { await w.close(); }
});

test('start runs the runner on this machine with one shared MCP server; stop finishes and ends it', async () => {
  const fake = await new FakeAlfred().start();
  seed(fake);
  const first = [call('in-ok-1', 0, '/api/search'), call('in-err-1', 5, '/api/confirm', 500, { error: 'boom' })];
  for (const r of first) fake.addCall('internal', r);
  fake.addCycle({ id: CY, name: 'Listen check', status: 'RECORDING' }, first.map((record) => ({ source: 'internal', record })));
  fake.board.changes = { entries: [], cycles: [], cursor: '1.1', more: false };
  seedCards(fake);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'listen-start-'));
    const config = join(dir, '.claude.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { 'alfred-t': { command: process.execPath, args: [TSX, INDEX], env: { ALFRED_URL: fake.url } } } }));
    process.env['FAKE_CLAUDE_MODE'] = 'listen';
    process.env['FAKE_CLAUDE_PROMPT'] = join(dir, 'prompt.json');
    const cli = async (...a: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [SCRIPT, ...a, '--server', 'alfred-t', '--cycle', CY, '--config', config, '--cwd', dir])).stdout);
    const started = await cli('start', '--project', 'odeysys', '--claude', FAKE, '--wait', '1', '--settle', '0', '--no-live');
    assert.equal(started.started, true);
    assert.equal(started.alfred, fake.url);
    assert.equal((await cli('start', '--project', 'odeysys')).alreadyRunning, true);
    const until = async (re: RegExp) => {
      for (let i = 0; i < 240; i++) {
        const s = await cli('status', '--lines', '80');
        if (s.last.some((l: string) => re.test(l))) return s;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.fail(`never logged ${re}: ${JSON.stringify((await cli('status', '--lines', '80')).last)}`);
    };
    const s = await until(/→ ✦ Claude \(\d+ s\): batch: 2 cards/);
    assert.equal(s.running, true);
    const mcpConfig = JSON.parse(readFileSync(s.log.replace(/\.log$/, '.mcp.json'), 'utf8'));
    assert.match(mcpConfig.mcpServers['alfred-t'].url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'the runs connect to the shared HTTP server, not a server of their own');
    assert.equal((await cli('stop')).stopping, true);
    await until(/● Listen stopped/);
    for (let i = 0; i < 40 && (await cli('status')).running; i++) await new Promise((r) => setTimeout(r, 250));
    assert.equal((await cli('status')).running, false);
  } finally { await fake.stop(); }
});

// ---------------------------------------------------------------------------------------------- specs/018 in the runner

const VIEW = (verdicts: string[]) => ({
  cycleId: CY,
  items: verdicts.map((v, i) => ({ fileName: 'spec.md', itemKey: `k${i + 1}`, text: `Item ${i + 1}`, mark: null, evidence: null,
    cardNumber: v === 'MISSING' ? 41 : null, cardStatus: v === 'MISSING' ? 'INBOX' : null,
    verdict: { verdict: v, callId: v === 'MISSING' ? 'in-err-1' : null, reason: v === 'MISSING' ? 'request $.branch* is a list - sent branchId: 948' : null,
      cardId: null, judgedAt: null, counts: { contradicts: 0, wrong: 0, meets: 0, noData: 0, unknown: 0 } } })),
  counts: verdicts.reduce((c: Record<string, number>, v) => ({ ...c, [v]: (c[v] ?? 0) + 1 }), {}),
});

test('a fine verdict covers its group until the calls send a request shape it was never given on', () => {
  assert.equal(listen.fineCovers({ kind: 'fine', recurs: true }, { shapes: ['a'] }), true, 'a verdict from before shapes were kept covers any');
  assert.equal(listen.fineCovers({ kind: 'fine', recurs: true, shapes: ['a'] }, { shapes: ['a'] }), true);
  assert.equal(listen.fineCovers({ kind: 'fine', recurs: true, shapes: ['a'] }, { shapes: ['a', 'b'] }), false);
  assert.deepEqual(listen.shapesAfter(['a'], { shapes: ['b', 'a'] }), ['a', 'b']);
  assert.equal(listen.requirementCounts(VIEW(['MISSING', 'MET', 'NO_EVIDENCE', 'MISSING'])), '2 missing · 1 met · 1 no evidence');
  assert.equal(listen.briefBranch('## Task\n- User story: 61813\n- Branch (odeysys): 61813-Q4-INTE-feature\n- Base: 5e31161e93'), '61813-Q4-INTE-feature');
  assert.equal(listen.briefBranch('no branch here'), null);
});

test('a known fine group is judged again when its calls carry a new request shape', async () => {
  const w = await listenWorld();
  try {
    const g = { id: 'G1', key: 'k-fine', endpoint: 'POST /search', shapes: ['old'] };
    w.runner.s.ledger['k-fine'] = { kind: 'fine', reason: 'empty on purpose', recurs: true, shapes: ['old'] };
    assert.equal((await w.runner.splitKnown([g])).known.length, 1);
    assert.equal((await w.runner.splitKnown([{ ...g, shapes: ['new'] }])).unknown.length, 1);
    assert.ok(w.lines.some((l) => /fine before, but its calls send a new request shape - judged again/.test(l)), w.lines.join('\n'));
  } finally { await w.close(); }
});

test('the pack holds the requirements by the calls and no spacers; a verdict that changes is said once, the strip counts them', async () => {
  const w = await listenWorld();
  try {
    w.fake.board.requirements = { [CY]: VIEW(['NOT_EXERCISED', 'MET']) };
    await w.runner.loadPack();
    let text = w.runner.packText();
    assert.match(text, /REQUIREMENTS BY THE CALLS[\s\S]*AC1 NOT_EXERCISED \| spec\.md \| k1 \| Item 1/);
    assert.doesNotMatch(text, /SPACERS|THE USER'S SPACERS/);
    assert.match(text, /Spacers are not used/);
    w.fake.board.requirements = { [CY]: VIEW(['MISSING', 'MET']) };
    await w.runner.refreshRequirements();
    await w.runner.refreshRequirements();
    const said = w.chat.filter((l) => /◆ requirements:/.test(l));
    assert.deepEqual(said, ['  ◆ requirements: AC1 MISSING #41 - request $.branch* is a list - sent branchId: 948']);
    assert.match(w.runner.stepLine(), /requirements 1 missing · 1 met/);
    text = w.runner.packText();
    assert.match(text, /AC1 MISSING \(#41\) \| spec\.md \| k1 \| Item 1 \| request \$\.branch\* is a list - sent branchId: 948 \| call in-err-1/);
  } finally { await w.close(); }
});

test('items with no evidence get it drafted by one run before the first batch', async () => {
  const w = await listenWorld();
  try {
    w.fake.board.requirements = { [CY]: VIEW(['NO_EVIDENCE', 'MET']) };
    await w.runner.loadPack();
    await w.runner.draftEvidence();
    assert.match(w.prompt().prompt, /ITEMS WITHOUT EVIDENCE \(AC# \| file \| key \| text\):\nAC1 \| spec\.md \| k1 \| Item 1/);
    assert.equal(w.runner.s.finish.evidence, true);
    assert.ok(w.chat.some((l) => /1 Acceptance item has no evidence - drafting it/.test(l)), w.chat.join('\n'));
  } finally { await w.close(); }
});

test('stop --now still writes the session log, with the requirement counts', async () => {
  const w = await listenWorld();
  try {
    w.fake.board.requirements = { [CY]: VIEW(['MISSING', 'NOT_EXERCISED']) };
    const running = w.runner.run();
    for (let i = 0; i < 40 && !w.runner.drainer; i++) await new Promise((r) => setTimeout(r, 100));
    w.runner.stop(true);
    await running;
    const logs = w.fake.requests('POST', '/board/cycles/cy-listen/log');
    assert.equal(logs.length, 1, 'one session log');
    assert.match((logs[0].body as any).found, /Requirements by the calls: 1 missing · 1 not exercised\./);
    assert.match((logs[0].body as any).next, /--finish runs them/);
    assert.match(w.chat.at(-1)!, /Listen stopped without the finish - requirements: 1 missing · 1 not exercised · session log written/);
  } finally { await w.close(); }
});

test('--board names the board by AB#, name or id and listens to its recording cycle, else its newest (specs/030)', async () => {
  const boards = [
    { board: { id: 'b-1', project: 'odeysys', name: '#61813_Refund filters' }, cycleIds: ['cy-old', 'cy-new'], linkedItem: 'c1/61813' },
    { board: { id: 'b-2', project: 'odeysys', name: 'Export refunds' }, cycleIds: [], linkedItem: null },
    { board: { id: 'b-3', project: 'odeysys', name: 'Export refunds v2' }, cycleIds: ['cy-rec'], linkedItem: null },
  ];
  const cycles = [
    { id: 'cy-old', status: 'PAUSED', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'cy-new', status: 'PAUSED', createdAt: '2026-10-10T00:00:00Z' },
    { id: 'cy-rec', status: 'RECORDING', createdAt: '2026-10-02T00:00:00Z' },
  ];
  const alfred = { call: async (_m: string, path: string) => (path === '/board/boards' ? boards : cycles) };
  assert.deepEqual(await listen.cycleOfBoard(alfred, 'AB#61813'), { cycleId: 'cy-new', project: 'odeysys', board: 'b-1', recording: false });
  assert.equal((await listen.cycleOfBoard(alfred, 'export refunds v2')).cycleId, 'cy-rec');
  assert.equal((await listen.cycleOfBoard(alfred, 'b-1')).cycleId, 'cy-new');
  await assert.rejects(listen.cycleOfBoard(alfred, '#12'), /card number, not a board/);
  await assert.rejects(listen.cycleOfBoard(alfred, 'AB#999'), /No board has AB#999 as its main item/);
  await assert.rejects(listen.cycleOfBoard(alfred, 'Export refunds'), /has no cycle yet - press Record/);
  await assert.rejects(listen.cycleOfBoard(alfred, 'export'), /matches 2 boards/);
});
