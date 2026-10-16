import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { world } from './harness.ts';

/**
 * specs/022: the board chat lane of the /alfred-live runner - the session it forks or continues, the order it answers in,
 * what it sends the terminal - and its pure helpers.
 */

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const live: any = await import(pathToFileURL(fileURLToPath(new URL('../../skills/alfred-live/alfred-live.mjs', import.meta.url))).href);
const chatLane: any = await import(pathToFileURL(fileURLToPath(new URL('../../skills/alfred-live/chat.mjs', import.meta.url))).href);
const CHAT_SRC = readFileSync(fileURLToPath(new URL('../../skills/alfred-live/chat.mjs', import.meta.url)), 'utf8');

test('a chat forks the terminal once, then continues its own session; another machine starts from Alfred only', () => {
  const fork = chatLane.chatSessionArgs({ terminalId: 'term-1', transcriptExists: true, host: 'pc' });
  assert.deepEqual(fork.args, ['--resume', 'term-1', '--fork-session']);
  assert.equal(fork.forked, true);
  const cont = chatLane.chatSessionArgs({ session: { chatSessionId: 'fork-9', host: 'pc' }, terminalId: 'term-1', transcriptExists: true, host: 'pc' });
  assert.deepEqual(cont.args, ['--resume', 'fork-9']);
  assert.equal(cont.continued, true);
  const refork = chatLane.chatSessionArgs({ session: { chatSessionId: 'fork-9', host: 'pc' }, terminalId: 'term-1', transcriptExists: true, host: 'pc', refork: true });
  assert.deepEqual(refork.args, ['--resume', 'term-1', '--fork-session']);
  const elsewhere = chatLane.chatSessionArgs({ session: { chatSessionId: 'fork-9', host: 'laptop' }, terminalId: 'term-1', transcriptExists: false, host: 'pc' });
  assert.deepEqual(elsewhere.args, []);
  assert.match(elsewhere.note, /not on pc - this chat starts from Alfred's context only/);
  assert.deepEqual(chatLane.chatSessionArgs({}).args, []);
  assert.equal(chatLane.sessionIdOf({ type: 'system', subtype: 'init', session_id: 's-1' }), 's-1');
  assert.equal(chatLane.sessionIdOf({ type: 'assistant' }), null);
});

test('messages go urgent first, then in waiting order; a runner answers only its own chats', () => {
  const chats = [{ messageId: 1, seq: 1, scope: 'cy1', project: 'p' }, { messageId: 2, seq: 2, scope: 'cy1', project: 'p', urgent: true },
    { messageId: 3, seq: 3, scope: 'project', project: 'p' }, { messageId: 4, seq: 4, scope: 'cy2', project: 'p' }];
  assert.deepEqual(chatLane.orderChats(chats).map((c: any) => c.messageId), [2, 1, 3, 4]);
  assert.deepEqual(chatLane.mineOf(chats, { cycleId: 'cy1' }).map((c: any) => c.messageId), [1, 2]);
  assert.deepEqual(chatLane.mineOf(chats, { project: 'p' }).map((c: any) => c.messageId), [3]);
  assert.deepEqual(chatLane.mineOf(chats, { project: 'q' }), []);
  assert.deepEqual(chatLane.mineOf(chats, { cycleId: 'cy1', kind: 'listen' }), []);
});

test('a skill picked from the chat "/" list is run with the Skill tool; one it does not offer is an ordinary message', () => {
  assert.equal(chatLane.skillOf('skill:alfred-fix'), 'alfred-fix');
  assert.equal(chatLane.skillOf('skill:alfred-live'), null);
  assert.equal(chatLane.skillOf('typed'), null);
  const p = chatLane.chatPrompt({ server: 'alfred', project: 'p', scope: 'cy1',
    taken: [{ messageId: 9, take: '#9 user: /alfred-status', thread: [], origin: 'skill:alfred-status' }] });
  assert.match(p, /picked \/alfred-status/);
  assert.match(p, /Skill tool/);
  const plain = chatLane.chatPrompt({ server: 'alfred', project: 'p', scope: 'cy1', taken: [{ messageId: 9, take: '#9 user: hi', thread: [] }] });
  assert.doesNotMatch(plain, /Skill tool/);
});

test('the prompt keeps its head the same and puts the new things last; a continued session gets only what is new', () => {
  const taken = [{ messageId: 7, take: '#7 user: why?', thread: [] }];
  const first = chatLane.chatPrompt({ server: 'alfred', project: 'p', scope: 'cy1', taken, context: 'Latest summary: X' });
  const again = chatLane.chatPrompt({ server: 'alfred', project: 'p', scope: 'cy1', taken, context: 'Latest summary: X', delta: 'user: fix it', alreadyInSession: true });
  assert.ok(first.startsWith(chatLane.CHAT_RULES) && again.startsWith(chatLane.CHAT_RULES), 'same cached head');
  assert.ok(first.indexOf('ALFRED CONTEXT') < first.indexOf('MESSAGES TO ANSWER'));
  assert.doesNotMatch(again, /ALFRED CONTEXT/);
  assert.match(again, /already in your session/);
  assert.ok(again.indexOf('THE TERMINAL SESSION SINCE YOUR COPY') < again.indexOf('MESSAGES TO ANSWER'));
  assert.match(again, /messageId 7: #7 user: why\?/);
});

test('the terminal\'s significant work is read from its transcript; a compact there means a new copy', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-15T10:00:00Z', message: { content: 'fix the search' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-15T10:01:00Z', message: { content: [{ type: 'text', text: 'Fixed.' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'src/Search.java' } }, { type: 'tool_use', name: 'Read', input: {} }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-15T10:02:00Z', message: { content: '<command-name>/clear</command-name>' } }),
    'not json',
  ];
  const d = chatLane.deltaOf(lines, Date.parse('2026-10-15T09:00:00Z'));
  assert.equal(d.entries, 3);
  assert.match(d.text, /user: fix the search\nclaude: Fixed\.\nclaude edited src\/Search\.java/);
  assert.equal(d.at, Date.parse('2026-10-15T10:01:00Z'));
  assert.equal(chatLane.deltaOf(lines, Date.parse('2026-10-15T10:01:00Z')).entries, 0);
  assert.equal(chatLane.compactedSince(lines, 0), false);
  assert.equal(chatLane.compactedSince([...lines, JSON.stringify({ type: 'summary', timestamp: '2026-10-15T11:00:00Z' })], 0), true);
  assert.equal(chatLane.terminalLine({ urgent: true, text: 'contradicts\nyour step' }), '⚡ board chat: contradicts your step');
  assert.equal(chatLane.terminalLine({ urgent: false, text: '💬 board chat #3 - you asked' }), '💬 board chat #3 - you asked');
});

test('the transcript is watched through fs.watch events only - no timer in the chat lane', () => {
  assert.doesNotMatch(CHAT_SRC, /setInterval|setTimeout/);
  const dir = mkdtempSync(join(tmpdir(), 'chat-watch-'));
  const path = join(dir, 't.jsonl');
  writeFileSync(path, '');
  let listener: ((event: string) => void) | null = null;
  const seen: number[] = [];
  const w = new chatLane.TranscriptWatch(path, (at: number) => seen.push(at), { fsWatch: (_p: string, l: any) => { listener = l; return { close() {} }; } });
  writeFileSync(path, JSON.stringify({ type: 'user', timestamp: '2026-10-15T10:00:00Z', message: { content: 'go' } }) + '\n');
  listener!('change');
  assert.deepEqual(seen, [Date.parse('2026-10-15T10:00:00Z')]);
  listener!('change'); // nothing new
  assert.equal(seen.length, 1);
  w.close();
});

test('new transcript entries after multi-byte text are still seen (the size is bytes, not characters)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-watch-'));
  const path = join(dir, 't.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', timestamp: '2026-10-15T09:00:00Z', message: { content: 'قرار ─ ✓ 🧠 '.repeat(50) } }) + '\n');
  let listener: ((event: string) => void) | null = null;
  const seen: number[] = [];
  const w = new chatLane.TranscriptWatch(path, (at: number) => seen.push(at), { fsWatch: (_p: string, l: any) => { listener = l; return { close() {} }; } });
  appendFileSync(path, JSON.stringify({ type: 'user', timestamp: '2026-10-15T10:00:00Z', message: { content: 'edit notes' } }) + '\n');
  listener!('change');
  assert.deepEqual(seen, [Date.parse('2026-10-15T10:00:00Z')]);
  w.close();
});

async function chatWorld(chats: any[]) {
  const w = await world();
  w.fake.board.changes = { entries: [], cycles: [], chats, cursor: '0.0.9', more: false };
  const dir = mkdtempSync(join(tmpdir(), 'chat-runner-'));
  const promptFile = join(dir, 'prompt.json');
  process.env['FAKE_CLAUDE_MODE'] = 'chat';
  process.env['FAKE_CLAUDE_PROMPT'] = promptFile;
  const lines: string[] = [];
  const chat: string[] = [];
  const runner = new live.Runner({
    alfred: new live.Alfred(w.fake.url), server: 'alfred', mcpEntry: { type: 'http', url: `${w.fake.url}/mcp` }, project: 'p', cwd: dir,
    claude: process.execPath, claudeArgs: [FAKE], mcpConfigFile: join(dir, 'mcp.json'), host: 'pc', parallel: 1, warm: false,
    log: (l: string) => lines.push(l), chat: (l: string) => chat.push(l), settleMs: 0, waitSeconds: 1, draftEveryMs: 0, reportEveryMs: 5,
  });
  const close = async () => { runner.pool.close(); runner.chatPool?.close(); await w.close(); };
  return { w, runner, lines, chat, promptFile, dir, close };
}

const waiting = (c: any, id: number, scope: string, text: string, extra: any = {}) => {
  c.messages.push({ id, project: 'p', scope, parentId: null, author: 'USER', kind: 'TEXT', text, state: 'WAITING', urgent: false, origin: 'typed',
    context: [], quote: null, extra: null, coversTo: null, replyTo: null, createdAt: '2026-10-15T10:00:00Z', ...extra });
  return { messageId: id, project: 'p', scope, kind: 'TEXT', urgent: !!extra.urgent, parentId: null, origin: 'typed', text, at: 't', seq: id };
};

test('the project runner answers the project chat\'s waiting messages in one run, with live steps under the message', async () => {
  const store = { messages: [] as any[], holder: {}, terminal: [] as any[], watches: [], nextId: 50 };
  const changes = [waiting(store, 1, 'project', 'first'), waiting(store, 2, 'project', 'second', { urgent: true }), waiting(store, 3, 'cy1', 'not mine')];
  const { w, runner, promptFile, close } = await chatWorld(changes);
  w.fake.board.chats = store;
  try {
    await runner.once('0.0.0');
    await Promise.all([...runner.chatLane.chains.values()]);
    const sent = JSON.parse(readFileSync(promptFile, 'utf8'));
    assert.ok(sent.prompt.indexOf('messageId 2') < sent.prompt.indexOf('messageId 1'), 'urgent first');
    assert.doesNotMatch(sent.prompt, /messageId 3/);
    assert.ok(!sent.args.includes('--no-session-persistence'), 'a chat keeps its session');
    assert.ok(!sent.args.includes('--fork-session'), 'the project chat has no terminal to copy');
    assert.equal(store.messages.find((m) => m.id === 3).state, 'WAITING');
    const reports = w.fake.board.liveWork;
    assert.ok(reports.length && reports.every((r: any) => r.chatMessageId === 2 && r.cardNumber === 0), JSON.stringify(reports));
    assert.equal(reports.at(-1).state, 'DONE');
    assert.equal(reports.at(-1).usage.cacheRead, 9000);
    const session = w.fake.log.find((l) => l.method === 'PUT' && l.path === '/board/chats/project/session');
    assert.ok(session, 'the new session is stored');
    assert.equal(session!.body.forkedFrom, null);
    assert.equal(session!.body.host, 'pc');
  } finally { await close(); }
});

test('a cycle chat forks the terminal session found on this machine, and writes what it sent the terminal to the chat log', async () => {
  const store = { messages: [] as any[], holder: {} as Record<string, string>, terminal: [] as any[], watches: [], nextId: 50 };
  const changes = [waiting(store, 4, 'cy1', 'why?')];
  const { w, runner, chat, promptFile, dir, close } = await chatWorld(changes);
  w.fake.board.chats = store;
  const home = mkdtempSync(join(tmpdir(), 'chat-home-'));
  const transcript = chatLane.transcriptPath(dir, 'term-1', home);
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: '2026-10-15T09:00:00Z', message: { content: 'start' } }) + '\n');
  const realPath = chatLane.transcriptPath;
  try {
    runner.o.chatId = 'term-1';
    runner.o.cycleId = 'cy1';
    process.env['USERPROFILE'] = home;
    process.env['HOME'] = home;
    store.terminal.push({ id: 1, project: 'p', scope: 'cy1', urgent: true, text: 'contradicts your step', state: 'SENT' },
      { id: 2, project: 'p', scope: 'cy1', urgent: false, text: '💬 board chat #4 - you asked: why?', state: 'SENT' });
    w.fake.board.extra = (method, p) => (method === 'GET' && p[1] === 'chats' && p[3] === 'terminal' ? [200, store.terminal] : undefined);
    await runner.once('0.0.0');
    await Promise.all([...runner.chatLane.chains.values()]);
    const sent = JSON.parse(readFileSync(promptFile, 'utf8'));
    if (realPath(dir, 'term-1') === transcript) {
      assert.deepEqual(sent.args.slice(sent.args.indexOf('--resume'), sent.args.indexOf('--resume') + 3), ['--resume', 'term-1', '--fork-session']);
    }
    assert.deepEqual(chat.slice(-2), ['⚡ board chat: contradicts your step', '💬 board chat #4 - you asked: why?']);
    const delivered = w.fake.log.find((l) => l.path === '/board/chats/terminal/delivered');
    assert.deepEqual(delivered!.body.ids, [1, 2]);
  } finally { await close(); }
});

test('a run that answers nothing gives the messages back with why', async () => {
  const store = { messages: [] as any[], holder: {}, terminal: [] as any[], watches: [], nextId: 50 };
  const { w, runner, close } = await chatWorld([waiting(store, 5, 'project', 'hello')]);
  w.fake.board.chats = store;
  process.env['FAKE_CLAUDE_MODE'] = 'text-only';
  try {
    await runner.once('0.0.0');
    await Promise.all([...runner.chatLane.chains.values()]);
    const released = w.fake.log.find((l) => l.path === '/board/chats/messages/5/release');
    assert.ok(released, 'released');
    assert.equal(released!.body.failed, true);
    assert.equal(w.fake.board.liveWork.at(-1).state, 'FAILED');
  } finally { await close(); }
});

test('a runner reads the waiting chat messages from the start: those sent before it started are not skipped', () => {
  assert.equal(live.chatsFromStart('12.345.67'), '12.345.0');
  assert.equal(live.chatsFromStart('now'), 'now');
  assert.equal(live.chatsFromStart('12.345'), '12.345');
});
