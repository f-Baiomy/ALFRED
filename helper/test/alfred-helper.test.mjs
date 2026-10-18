import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Helper, boardWorktree, mcpNameFor, normalizeServer, parseArgs, projectFolder, serverOf, slug, tokensToday, transcriptOf, writeDesktopRecord,
} from '../alfred-helper.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'alfred-helper-'));

test('server addresses are normalised the same way everywhere', () => {
  assert.equal(normalizeServer('192.168.1.80:3000/'), 'http://192.168.1.80:3000');
  assert.equal(normalizeServer('https://alfred.lan'), 'https://alfred.lan');
  assert.equal(normalizeServer(''), '');
  const config = { servers: { 'http://a:3000': { key: 'k' } }, default: 'http://a:3000' };
  assert.equal(serverOf(config).key, 'k');
  assert.throws(() => serverOf(config, 'http://b:3000'), /No helper installed for http:\/\/b:3000/);
});

test('arguments and slugs', () => {
  assert.deepEqual(parseArgs(['install', '--server', 'x', '--autostart']), { _: ['install'], server: 'x', autostart: 'true' });
  assert.equal(slug('AB#61813 Seat map NDC'), 'ab-61813-seat-map-ndc');
  assert.equal(slug(''), 'board');
});

test("a project's folder is this PC's row, else a row for every PC", () => {
  const s = { projects: [
    { project: 'odeysys', machine: 'WORK-PC', folder: 'C:/w', openIn: 'TERMINAL' },
    { project: 'odeysys', machine: 'LAPTOP-2', folder: 'D:/w' },
    { project: 'alfred', folder: 'C:/a', worktrees: false },
  ] };
  assert.deepEqual(projectFolder(s, 'odeysys', 'work-pc'), { folder: 'C:/w', openIn: 'TERMINAL', worktrees: true });
  assert.equal(projectFolder(s, 'alfred', 'ANY').worktrees, false);
  assert.equal(projectFolder(s, 'nothing', 'WORK-PC'), null);
  assert.equal(projectFolder({}, 'odeysys', 'WORK-PC'), null);
});

test("the Alfred MCP server is found by Alfred's address in ~/.claude.json", () => {
  const home = tmp();
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    'alfred-lan-80': { type: 'http', url: 'http://192.168.1.80:3000/mcp' },
    alfred: { command: 'node', env: { ALFRED_URL: 'http://localhost:3000' } },
  } }));
  assert.equal(mcpNameFor('192.168.1.80:3000', home), 'alfred-lan-80');
  assert.equal(mcpNameFor('http://localhost:3000/', home), 'alfred');
  assert.equal(mcpNameFor('http://other:3000', home), null);
});

test('a Desktop record has the shape the official /desktop writes, once', () => {
  const dir = tmp();
  const id = writeDesktopRecord({ cliSessionId: 'abc', cwd: 'C:/w', title: 'AB#1' }, dir);
  assert.equal(id, 'local_abc');
  const r = JSON.parse(readFileSync(join(dir, 'local_abc.json'), 'utf8'));
  assert.equal(r.sessionId, 'local_abc');
  assert.equal(r.cliSessionId, 'abc');
  assert.equal(r.adoptedFromOtherSurface, true);
  assert.equal(r.title, 'AB#1');
  writeDesktopRecord({ cliSessionId: 'abc', cwd: 'C:/other', title: 'changed' }, dir);
  assert.equal(JSON.parse(readFileSync(join(dir, 'local_abc.json'), 'utf8')).title, 'AB#1');
  assert.equal(writeDesktopRecord({ cliSessionId: 'x' }, null), null);
});

test('transcripts are found by id and their tokens counted for today only', () => {
  const home = tmp();
  const dir = join(home, '.claude', 'projects', 'C--w');
  mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(dir, 's1.jsonl'), [
    JSON.stringify({ timestamp: `${today}T10:00:00Z`, message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    JSON.stringify({ timestamp: '2020-01-01T10:00:00Z', message: { usage: { input_tokens: 999, output_tokens: 1 } } }),
    'not json "usage"',
  ].join('\n'));
  const file = transcriptOf('s1', home);
  assert.ok(file);
  assert.equal(tokensToday(file, today), 150);
  assert.equal(transcriptOf('none', home), null);
});

test('each board gets its own git worktree, kept out of the repo status', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
  const repo = tmp();
  const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const a = boardWorktree(repo, 'AB#1 Seat map');
  assert.equal(a.worktree, true);
  assert.ok(existsSync(a.cwd));
  assert.match(a.cwd, /\.alfred-worktrees[\\/]ab-1-seat-map$/);
  assert.equal(boardWorktree(repo, 'AB#1 Seat map').cwd, a.cwd);
  assert.equal(git('status', '--porcelain').stdout.trim(), '');
  const plain = tmp();
  assert.deepEqual(boardWorktree(plain, 'x'), { cwd: plain, worktree: false });
});

test('a session open in Desktop or a terminal is seen; a -p run or a runner naming it is not (one writer, spike S2)', async () => {
  const { openInteractively } = await import('../alfred-helper.mjs');
  const lines = [
    'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1\\claude.exe --output-format stream-json --resume=desk-1', // how Desktop runs it
    'claude --resume term-1',
    'claude.exe -p --resume fork-1',
    'node alfred-live.mjs start --chat runner-1',
  ];
  assert.equal(openInteractively('desk-1', lines), true);
  assert.equal(openInteractively('term-1', lines), true);
  assert.equal(openInteractively('fork-1', lines), false);
  assert.equal(openInteractively('runner-1', lines), false);
  assert.equal(openInteractively('none', lines), false);
});

class FakeApi {
  constructor(settings = {}) {
    this.key = 'ak_0123456789abcdef.s';
    this.calls = [];
    this.settings = settings;
  }

  async call(method, path, o = {}) {
    this.calls.push({ method, path, body: o.body, query: o.query });
    if (path === '/board/me/settings') return this.settings;
    if (path === '/board/sessions' && method === 'GET') return this.sessions ?? [];
    return {};
  }
}

test('START: worktree, first turn, holder, runner, report - and nothing without a folder', async () => {
  const repo = tmp();
  const api = new FakeApi({ projects: [{ project: 'odeysys', machine: 'PC', folder: repo, openIn: 'BACKGROUND', worktrees: false }] });
  const h = new Helper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred' });
  const turns = [];
  h.turn = (id, prompt, o) => { turns.push({ id, prompt, ...o }); return 'ok'; };
  h.startRunner = () => null;

  const result = await h.handle({ kind: 'START', boardId: 'b1', project: 'odeysys', args: '{"title":"AB#1","boardRef":"AB#1"}' });

  assert.match(result, /Started [0-9a-f-]{36} in /);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, '/alfred-resume AB#1');
  assert.equal(turns[0].create, true);
  const take = api.calls.find((c) => c.path === '/board/holders/take');
  assert.equal(take.body.boardId, 'b1');
  const reports = api.calls.filter((c) => c.path === '/board/sessions' && c.method === 'PUT');
  assert.equal(reports[0].body.state, 'STARTING');
  assert.equal(reports.at(-1).body.state, 'ANSWERING');

  await assert.rejects(h.handle({ kind: 'START', boardId: 'b2', project: 'other', args: '{}' }), /NO_FOLDER/);
});

test('a command for a session that is not on this PC says NOT_HERE', async () => {
  const api = new FakeApi();
  api.sessions = [{ id: 's1', boardId: 'b1', cliSessionId: 'not-on-this-pc', machine: 'WORK-PC', current: true }];
  const h = new Helper({ server: 'http://a:3000', api, machine: 'LAPTOP-2', mcp: 'alfred' });
  await assert.rejects(h.handle({ kind: 'OPEN_TERMINAL', boardId: 'b1', sessionId: 's1', args: '{}' }), /NOT_HERE: .* \(it was on WORK-PC\)/);
});

test('moving a transcript between PCs is refused with the way that works', async () => {
  const h = new Helper({ server: 'http://a:3000', api: new FakeApi(), machine: 'PC' });
  await assert.rejects(h.handle({ kind: 'BRING_TRANSCRIPT', args: '{}' }), /Continue here from Alfred's copy/);
});
