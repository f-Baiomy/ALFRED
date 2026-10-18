import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Helper, boardWorktree, claudeAppDataDirs, desktopAccount, desktopAccountDir, desktopSessionsRoot, ensureMcp, installSkills, mcpDefaultName, mcpNameFor, normalizeServer, parseArgs, projectFolder, serverOf, shortHash,
  slug, tokensToday, transcriptOf, writeDesktopRecord, desktopHasRecord, DESKTOP_RESTART, findDesktopChat, desktopChatUrl,
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

test("a turn gives Claude its prompt on stdin and allows only Alfred's own MCP tools by name", () => {
  const dir = tmp();
  const out = join(dir, 'out.json');
  writeFileSync(join(dir, 'fake.mjs'), `import { writeFileSync, readFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8') }));
process.stdout.write('done');`);
  let claude;
  if (process.platform === 'win32') {
    claude = join(dir, 'claude.cmd');
    writeFileSync(claude, `@"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
  } else {
    claude = join(dir, 'claude');
    writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake.mjs" "$@"\n`);
    spawnSync('chmod', ['+x', claude]);
  }
  const h = quietHelper({ server: 'http://a:3000', api: new FakeApi(), machine: 'PC', mcp: 'alfred-docker', claude });

  const said = h.turn('11111111-2222-3333-4444-555555555555', '/alfred-resume "AB#1" & more', { create: true, cwd: dir });

  assert.equal(said, 'done');
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(seen.stdin, '/alfred-resume "AB#1" & more');
  assert.deepEqual(seen.argv, ['-p', '--session-id', '11111111-2222-3333-4444-555555555555', '--allowedTools', 'mcp__alfred-docker__*', 'Read', 'Grep', 'Glob']);
});

test('a START whose first turn fails leaves the session gone, not starting', async () => {
  const repo = tmp();
  const api = new FakeApi({ projects: [{ project: 'odeysys', machine: 'PC', folder: repo, openIn: 'BACKGROUND', worktrees: false }] });
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred', primary: true });
  h.turn = () => { throw new Error('claude exited 1: Error: Input must be provided'); };

  await assert.rejects(h.handle({ kind: 'START', boardId: 'b1', project: 'odeysys', args: '{}' }), /claude exited 1/);

  const reports = api.calls.filter((c) => c.path === '/board/sessions' && c.method === 'PUT');
  assert.deepEqual([...new Set(reports.map((r) => r.body.state))], ['STARTING', 'GONE']);
  assert.equal(reports.at(-1).body.state, 'GONE');
  assert.equal(reports[1].body.boardId, 'b1');
  assert.equal(h.sessions.size, 0);
});

test("on start, commands this helper's key took before a restart go back to the queue - never another helper's", async () => {
  const api = new FakeApi();
  api.call = async function (method, path, o = {}) {
    this.calls.push({ method, path, body: o.body });
    if (path === '/board/helper-commands' && method === 'GET') {
      return [
        { id: 'c1', kind: 'RESUME', state: 'TAKEN', helperKeyId: '0123456789abcdef' },
        { id: 'c2', kind: 'START', state: 'TAKEN', helperKeyId: 'fedcba9876543210' },
        { id: 'c3', kind: 'STOP', state: 'DONE', helperKeyId: '0123456789abcdef' },
      ];
    }
    return {};
  };
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC' });

  await h.requeueOrphans();

  const puts = api.calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => [c.path, c.body.state]), [['/board/helper-commands/c1', 'QUEUED']]);
});

test('START says what it is doing while it starts, in order (specs/032)', async () => {
  const repo = tmp();
  const api = new FakeApi({ projects: [{ project: 'odeysys', machine: 'PC', folder: repo, openIn: 'BACKGROUND', worktrees: false }] });
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred', primary: true });
  h.turn = () => 'ok';
  h.startRunner = () => null;

  await h.handle({ kind: 'START', boardId: 'b1', project: 'odeysys', args: '{}' });

  const reports = api.calls.filter((c) => c.path === '/board/sessions' && c.method === 'PUT').map((c) => c.body);
  assert.deepEqual(reports.filter((r) => r.progress).map((r) => r.progress), ['Getting ready', 'Reading the task', 'Starting to answer the board']);
  assert.equal(reports.at(-1).state, 'ANSWERING');
});

test('RELEASE writes the note when asked, stops Claude, then hands the board back (specs/032)', async () => {
  const api = new FakeApi();
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred' });
  const session = { id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: '11111111-2222-3333-4444-555555555555', cwd: tmp() };
  h.known = async () => session;
  const order = [];
  h.turn = (id, prompt) => { order.push(prompt.includes('Handover note') ? 'note' : 'turn'); return 'ok'; };
  h.stopRunner = () => order.push('stop');
  const realCall = api.call.bind(api);
  api.call = async (m, p, o) => { if (p === '/board/holders/release') order.push('release'); return realCall(m, p, o); };

  const withNote = await h.handle({ kind: 'RELEASE', boardId: 'b1', project: 'odeysys', args: '{"note":true,"boardRef":"AB#1"}' });
  assert.deepEqual(order, ['note', 'stop', 'release']);
  assert.match(withNote, /Handover note card/);

  order.length = 0;
  h.turn = () => { throw new Error('claude exited 1: weekly limit'); };
  const failedNote = await h.handle({ kind: 'RELEASE', boardId: 'b1', project: 'odeysys', args: '{"note":true}' });
  assert.deepEqual(order, ['stop', 'release'], 'a failed note still hands the board back');
  assert.match(failedNote, /no note \(claude exited 1/);
});

test('RESUME reads the messages sent while paused in the same command, and only then (specs/032)', async () => {
  const api = new FakeApi();
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred' });
  const session = { id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: '11111111-2222-3333-4444-555555555555', cwd: tmp() };
  h.known = async () => session;
  h.startRunner = () => null;
  const turns = [];
  h.turn = (id, prompt) => { turns.push(prompt); return 'ok'; };

  const r = await h.handle({ kind: 'RESUME', boardId: 'b1', project: 'odeysys', args: '{"unread":3,"boardRef":"AB#1","chatSeq":42}' });
  assert.deepEqual(turns, ['/alfred-resume AB#1']);
  assert.match(r, /read the 3 message/);
  const last = api.calls.filter((c) => c.path === '/board/sessions' && c.method === 'PUT').at(-1).body;
  assert.equal(last.lastChatSeq, 42);

  turns.length = 0;
  await h.handle({ kind: 'RESUME', boardId: 'b1', project: 'odeysys', args: '{}' });
  assert.deepEqual(turns, []);
  assert.equal(api.calls.filter((c) => c.path === '/board/skill-runs').length, 0);

  // "Resume Claude and verify": the step is queued for the session once it answers again
  await h.handle({ kind: 'RESUME', boardId: 'b1', project: 'odeysys', args: '{"thenRun":{"command":"/alfred-verify AB#1"}}' });
  const runs = api.calls.filter((c) => c.path === '/board/skill-runs');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].body.command, '/alfred-verify AB#1');
  assert.equal(runs[0].body.cycleId, 'b1');
});

test('a session Desktop has not read is never deep-linked - the board offers Restart Desktop instead (2026-10-18)', async () => {
  const dir = tmp();
  const id = writeDesktopRecord({ cliSessionId: '79143edc-0000-0000-0000-000000000000', cwd: 'C:/w', title: 't' }, dir);
  const made = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')).createdAt;
  assert.equal(desktopHasRecord(id, { dir, startedAt: made - 60_000 }), false, 'Desktop started before the record: not in its list');
  assert.equal(desktopHasRecord(id, { dir, startedAt: made + 60_000 }), true, 'started after it: read');
  assert.equal(desktopHasRecord(id, { dir, startedAt: null }), true, 'not running: opening it starts it and reads it');
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ createdAt: made, gitAnchorsFolderRealpath: 'C:/w' }));
  assert.equal(desktopHasRecord(id, { dir, startedAt: made - 60_000 }), true, 'Desktop rewrote it with its own fields: read');

  const api = new FakeApi();
  const opened = [];
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred',
    desktop: { record: () => 'local_x', open: (u) => opened.push(u), terminal: () => {}, has: () => false } });
  h.known = async () => ({ id: 's1', boardId: 'b1', project: 'odeysys', cliSessionId: 'x', cwd: tmp() });
  const r = await h.handle({ kind: 'OPEN_DESKTOP', boardId: 'b1', project: 'odeysys', args: '{}' });
  assert.equal(r, DESKTOP_RESTART);
  assert.deepEqual(opened, [], 'no link to a page that says the session cannot be found');
});

test('START opens the board as a Claude Desktop chat that runs it itself - visible answers, nothing written into it (specs/032 D13)', async () => {
  const repo = tmp();
  const api = new FakeApi({ projects: [{ project: 'odeysys', machine: 'PC', folder: repo, openIn: 'DESKTOP', worktrees: false }] });
  const chats = [];
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred', primary: true,
    desktop: { record: () => null, open: () => {}, terminal: () => {}, available: () => true,
      chat: (o) => chats.push(o), waitChat: async () => ({ sessionId: 'local_d1', cliSessionId: 'c1c1c1c1-0000-0000-0000-000000000000', cwd: repo }) } });
  h.turn = () => { throw new Error('nothing may be written into the chat'); };
  let runnerStarted = false;
  h.startRunner = () => { runnerStarted = true; return null; };

  const result = await h.handle({ kind: 'START', boardId: 'b1', project: 'odeysys', args: '{"title":"AB#1","boardRef":"AB#1"}' });

  assert.match(result, /Claude Desktop chat/);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].cwd, repo);
  assert.doesNotMatch(chats[0].prompt, /^\//, "Desktop's link refuses a prompt starting with /");
  assert.match(chats[0].prompt, /\/alfred-resume AB#1/);
  assert.match(chats[0].prompt, /\/alfred-live odeysys b1/);
  assert.equal(runnerStarted, false, 'the chat starts its own runner through /alfred-live');
  const take = api.calls.find((c) => c.path === '/board/holders/take');
  assert.equal(take.body.sessionId, 'c1c1c1c1-0000-0000-0000-000000000000');
  const reports = api.calls.filter((c) => c.path === '/board/sessions' && c.method === 'PUT');
  assert.ok(reports.some((r) => r.body.state === 'GONE' && r.body.cliSessionId !== 'c1c1c1c1-0000-0000-0000-000000000000'), 'the placeholder row goes');
  const last = reports.at(-1).body;
  assert.equal(last.cliSessionId, 'c1c1c1c1-0000-0000-0000-000000000000');
  assert.equal(last.state, 'ANSWERING');
  assert.equal(last.desktopId, 'local_d1');
  assert.equal(h.sessions.get('c1c1c1c1-0000-0000-0000-000000000000').chat, true);
});

test('a Desktop chat that never opens (the folder not trusted) leaves no session and says what to do', async () => {
  const repo = tmp();
  const api = new FakeApi({ projects: [{ project: 'odeysys', machine: 'PC', folder: repo, openIn: 'DESKTOP', worktrees: false }] });
  const h = quietHelper({ server: 'http://a:3000', api, machine: 'PC', mcp: 'alfred', primary: true,
    desktop: { record: () => null, open: () => {}, terminal: () => {}, available: () => true, chat: () => {}, waitChat: async () => null } });
  await assert.rejects(h.handle({ kind: 'START', boardId: 'b1', project: 'odeysys', args: '{}' }), /press Trust/);
  assert.equal(h.sessions.size, 0);
});

test("Desktop's own chats are found by folder and time, never a record the helper wrote", () => {
  const dir = tmp();
  writeDesktopRecord({ cliSessionId: 'aaaaaaaa-0000-0000-0000-000000000000', cwd: 'C:/w', title: 't' }, dir);
  assert.equal(findDesktopChat({ cwd: 'C:/w', since: 0 }, dir), null, 'adopted from the helper: not a Desktop chat');
  writeFileSync(join(dir, 'local_b.json'), JSON.stringify({ sessionId: 'local_b', cliSessionId: 'bbbb', cwd: 'C:\\W', createdAt: 2000 }));
  assert.equal(findDesktopChat({ cwd: 'c:/w', since: 1000 }, dir)?.cliSessionId, 'bbbb');
  assert.equal(findDesktopChat({ cwd: 'c:/w', since: 3000 }, dir), null, 'older than the link');
  assert.equal(findDesktopChat({ cliSessionId: 'bbbb' }, dir)?.sessionId, 'local_b');
  assert.match(desktopChatUrl({ cwd: 'C:\\w x', prompt: 'a b' }), /^claude:\/\/code\/new\?q=a%20b&folder=C%3A%5Cw%20x$/);
});
