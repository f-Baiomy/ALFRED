import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Helper, boardWorktree, claudeAppDataDirs, desktopAccount, desktopAccountDir, desktopSessionsRoot, ensureMcp, installSkills, mcpDefaultName, mcpNameFor, normalizeServer, parseArgs, projectFolder, serverOf, shortHash,
  slug, tokensToday, transcriptOf, writeDesktopRecord,
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

test("two Windows users on one PC each get their own folder, and an older row without one still serves", () => {
  const s = { projects: [
    { project: 'odeysys', machine: 'LAPTOP', folder: 'C:/old' },
    { project: 'odeysys', machine: 'LAPTOP', osUser: 'OMEN', folder: 'C:/Users/OMEN/odeysys' },
    { project: 'odeysys', machine: 'LAPTOP', osUser: 'work', folder: 'C:/Users/work/odeysys' },
  ] };
  assert.equal(projectFolder(s, 'odeysys', 'laptop', 'work').folder, 'C:/Users/work/odeysys');
  assert.equal(projectFolder(s, 'odeysys', 'LAPTOP', 'omen').folder, 'C:/Users/OMEN/odeysys');
  assert.equal(projectFolder(s, 'odeysys', 'LAPTOP', 'guest').folder, 'C:/old');
  assert.equal(projectFolder(s, 'odeysys', 'LAPTOP').folder, 'C:/old');
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

/** A Helper whose screen side (Desktop record, claude:// links, terminals, toasts, the folder dialog) does nothing. */
function quietHelper(o) {
  return new Helper({ desktop: { record: () => null, open: () => {}, terminal: () => {}, restart: async () => {} }, notify: () => {}, ...o });
}

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
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred', primary: true });
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

  h.pickFolder = () => null; // the user closed the picker
  await assert.rejects(h.handle({ kind: 'START', boardId: 'b2', project: 'other', args: '{}' }), /NO_FOLDER/);
});

test('the first START of a project on a PC asks for its folder here and keeps it in My settings', async () => {
  const repo = tmp();
  const api = new FakeApi({ projects: [] });
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred' });
  h.turn = () => 'ok';
  h.startRunner = () => null;
  h.pickFolder = () => repo;

  await h.handle({ kind: 'START', boardId: 'default:odeysys', project: 'odeysys', args: '{}' });

  const saved = api.calls.find((c) => c.path === '/board/me/settings' && c.method === 'PUT');
  assert.deepEqual(saved.body.projects, [{ project: 'odeysys', machine: 'PC', osUser: h.osUser, folder: repo, openIn: 'DESKTOP', worktrees: true }]);
});

test('a command for a session that is not on this PC says NOT_HERE', async () => {
  const api = new FakeApi();
  api.sessions = [{ id: 's1', boardId: 'b1', cliSessionId: 'not-on-this-pc', machine: 'WORK-PC', current: true }];
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'LAPTOP-2', mcp: 'alfred' });
  await assert.rejects(h.handle({ kind: 'OPEN_TERMINAL', boardId: 'b1', sessionId: 's1', args: '{}' }), /NOT_HERE: .* \(it was on WORK-PC\)/);
});

test('moving a transcript between PCs is refused with the way that works', async () => {
  const h = quietHelper({ server: 'http://a:3000', api: new FakeApi(), machine: 'PC' });
  await assert.rejects(h.handle({ kind: 'BRING_TRANSCRIPT', args: '{}' }), /Continue here from Alfred's copy/);
});

test("Alfred's skills replace Alfred-installed copies, never someone else's folder, and the retired one goes", () => {
  const root = tmp();
  mkdirSync(join(root, 'alfred-guide'));
  writeFileSync(join(root, 'alfred-guide', 'SKILL.md'), 'mine');
  mkdirSync(join(root, 'alfred-live'));
  writeFileSync(join(root, 'alfred-live', '.alfred-skill'), 'source');
  writeFileSync(join(root, 'alfred-live', 'old.md'), 'old');
  mkdirSync(join(root, 'alfred-qa'));
  writeFileSync(join(root, 'alfred-qa', '.alfred-skill'), '1.0.0');

  const lines = installSkills({ version: 'abc', files: {
    'alfred-live/SKILL.md': 'live', 'alfred-live/sub/x.mjs': 'x', 'alfred-guide/SKILL.md': 'theirs',
    '../evil/SKILL.md': 'no', 'alfred-live/../../evil.md': 'no', 'alfred-x/C:': 'no',
  } }, root);

  assert.equal(readFileSync(join(root, 'alfred-live', 'sub', 'x.mjs'), 'utf8'), 'x');
  assert.equal(existsSync(join(root, 'alfred-live', 'old.md')), false);
  assert.equal(readFileSync(join(root, 'alfred-live', '.alfred-skill'), 'utf8').trim(), 'alfred-abc');
  assert.equal(readFileSync(join(root, 'alfred-guide', 'SKILL.md'), 'utf8'), 'mine');
  assert.equal(existsSync(join(root, 'alfred-qa')), false);
  assert.equal(existsSync(join(root, '..', 'evil')), false);
  assert.ok(lines.some((l) => l.startsWith('skipped /alfred-guide')));
});

test("a new Alfred MCP server is named after Alfred's address and sends this user's key", () => {
  assert.equal(mcpDefaultName('localhost:3000'), 'alfred-local-3000');
  assert.equal(mcpDefaultName('http://192.168.1.80:3000'), 'alfred-lan-80');
  assert.equal(mcpDefaultName('http://192.168.1.80:3001'), 'alfred-lan-80-3001');
  assert.equal(mcpDefaultName('https://alfred.example.com'), 'alfred-alfred-example-com');

  const home = tmp();
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    'alfred-lan-80': { type: 'http', url: 'http://192.168.1.80:3000/mcp' },
    'alfred-local-3000': { type: 'http', url: 'http://other:1/mcp' },
    stdio: { command: 'node', env: { ALFRED_URL: 'http://localhost:3001' } },
  } }));
  const ran = [];
  const run = (a) => { ran.push(a.join(' ')); return { status: 0 }; };

  assert.deepEqual(ensureMcp('http://192.168.1.80:3000', 'ak_k', 'claude', home, run), { name: 'alfred-lan-80', changed: true });
  assert.deepEqual(ran, ['mcp remove alfred-lan-80 --scope user',
    'mcp add --scope user --transport http alfred-lan-80 http://192.168.1.80:3000/mcp --header X-Alfred-Key: ak_k']);
  ran.length = 0;
  assert.deepEqual(ensureMcp('http://localhost:3000', 'ak_k', 'claude', home, run), { name: 'alfred-local-3000-2', changed: true });
  ran.length = 0;
  assert.deepEqual(ensureMcp('http://localhost:3001', 'ak_k', 'claude', home, run), { name: 'stdio', changed: false });
  assert.deepEqual(ran, []);
});

test("the helper names versions the way Alfred does (the first 16 hex of SHA-256)", () => {
  assert.equal(shortHash('abc'), 'ba7816bf8f01cfea');
});

test('a second Alfred on the same PC never rewrites the shared helper or skills, and keeps its own worktrees', { skip: spawnSync('git', ['--version']).status !== 0 }, async () => {
  const repo = tmp();
  spawnSync('git', ['-C', repo, 'init', '-q']);
  spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const api = new FakeApi({ projects: [{ project: 'odeysys', folder: repo }] });
  const lan = quietHelper({ server: 'http://192.168.1.80:3000', api, machine: 'PC', mcp: 'alfred-lan-80', primary: false });
  lan.turn = () => 'ok';
  lan.startRunner = () => null;

  const result = await lan.handle({ kind: 'START', boardId: 'b1', project: 'odeysys', args: '{"title":"AB#1"}' });
  assert.match(result, /\.alfred-worktrees[\\/]lan-80-ab-1/);

  let fetched = false;
  lan.api = { call: async () => { fetched = true; return {}; } };
  await lan.keepCurrent({ helper: 'ffffffffffffffff', skills: 'eeeeeeeeeeeeeeee', node: true });
  assert.equal(fetched, false);
});

test("Claude Desktop from the Microsoft Store keeps its sessions inside its package, and the helper looks there first", { skip: process.platform !== 'win32' }, () => {
  const local = tmp();
  const roaming = tmp();
  const pkg = join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  const env = { LOCALAPPDATA: local, APPDATA: roaming };
  assert.equal(desktopSessionsRoot(env), join(roaming, 'Claude', 'claude-code-sessions'));
  mkdirSync(join(pkg, 'claude-code-sessions'), { recursive: true });
  assert.deepEqual(claudeAppDataDirs(env), [pkg, join(roaming, 'Claude')]);
  assert.equal(desktopSessionsRoot(env), join(pkg, 'claude-code-sessions'));
});

test('a token entered in Alfred for this PC is kept here, and forgetting it removes it', () => {
  const home = tmp();
  const before = process.env.ALFRED_HELPER_HOME;
  process.env.ALFRED_HELPER_HOME = home;
  try {
    const h = quietHelper({ server: 'http://a:3000', api: new FakeApi(), machine: 'PC', primary: true });
    h.keepToken('pat-123');
    const file = readdirSync(home).find((f) => f.startsWith('azure-token.'));
    assert.ok(file);
    assert.ok(!readFileSync(join(home, file), 'utf8').includes('pat-123')); // encrypted (DPAPI) or encoded, never as typed
    h.keepToken('');
    assert.equal(readdirSync(home).some((f) => f.startsWith('azure-token.')), false);
  } finally {
    if (before === undefined) delete process.env.ALFRED_HELPER_HOME; else process.env.ALFRED_HELPER_HOME = before;
  }
});

test('every tool the helper starts goes through the hidden wrappers - no console window flashes on Windows', () => {
  const src = readFileSync(new URL('../alfred-helper.mjs', import.meta.url), 'utf8');
  const direct = src.split('\n').filter((l) => /childProcess\.\w+\(/.test(l));
  assert.equal(direct.length, 3, direct.join('\n')); // spawn, spawnSync, execFileSync wrappers only
  assert.doesNotMatch(src, /import {[^}]*} from 'node:child_process'/);
  const shown = src.split('\n').filter((l) => l.includes(', windowsHide: false'));
  assert.equal(shown.length, 3, shown.join('\n')); // the folder picker and the two ways to open a terminal
});

test('the Windows folder window comes from wscript (no console), says which project, and returns only a real folder', { skip: process.platform !== 'win32' }, async () => {
  const { pickFolder } = await import('../alfred-helper.mjs');
  let seen;
  const answer = (path) => (cmd, args) => {
    seen = { cmd, script: readFileSync(args.at(-1), 'utf8') };
    const out = JSON.parse(seen.script.match(/CreateTextFile\(("(?:[^"\\]|\\.)*")/)[1]);
    writeFileSync(out, `\uFEFF${path}`, 'utf16le');
    return { status: 0 };
  };
  assert.equal(pickFolder('Pick the repo folder of odeysys', answer('C:\\work\\odeysys')), 'C:\\work\\odeysys');
  assert.equal(seen.cmd, 'wscript.exe');
  assert.match(seen.script, /BrowseForFolder\(0, "Pick the repo folder of odeysys"/);
  assert.equal(pickFolder('x', answer('')), null); // cancelled
  assert.equal(pickFolder('x', answer('::{20D04FE0-3AEA-1069-A2D8-08002B30309D}')), null); // "This PC"
});

test("session records go to the account Claude Desktop is signed in with now, even when another one wrote last", () => {
  const data = tmp();
  const home = tmp();
  const root = join(data, 'claude-code-sessions');
  const work = join(root, 'aaaa1111-0000-0000-0000-000000000001', 'org1');
  const gmail = join(root, 'bbbb2222-0000-0000-0000-000000000002', 'org2');
  mkdirSync(work, { recursive: true });
  mkdirSync(gmail, { recursive: true });
  writeFileSync(join(gmail, 'local_old.json'), '{}');
  writeFileSync(join(work, 'local_newer.json'), '{}');
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'aaaa1111-0000-0000-0000-000000000001', emailAddress: 'me@x.ae' } }));
  const agent = join(data, 'local-agent-mode-sessions', 'bbbb2222-0000-0000-0000-000000000002', 'org2', 'local_1', '.claude');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'bbbb2222-0000-0000-0000-000000000002', emailAddress: 'me@gmail.com' } }));

  writeFileSync(join(data, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'bbbb2222-0000-0000-0000-000000000002', 'oauth:tokenCache': 'secret' }));
  assert.deepEqual(desktopAccount(root, home), { uuid: 'bbbb2222-0000-0000-0000-000000000002', email: 'me@gmail.com' });
  assert.equal(desktopAccountDir(root, 'bbbb2222-0000-0000-0000-000000000002'), gmail);

  writeFileSync(join(data, 'config.json'), JSON.stringify({ lastKnownAccountUuid: 'aaaa1111-0000-0000-0000-000000000001' }));
  assert.equal(desktopAccount(root, home).email, 'me@x.ae'); // Claude Code's own account
  assert.equal(desktopAccountDir(root, undefined), work); // an older Desktop: the newest record wins
});
