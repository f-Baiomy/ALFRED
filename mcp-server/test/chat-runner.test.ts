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

test('a cycle chat is answered by the terminal session itself: the message becomes a ✉ line, no run, no copy (plan-terminal-answers.md)', async () => {
  const store = { messages: [] as any[], holder: {} as Record<string, string>, terminal: [] as any[], watches: [], nextId: 50 };
  const changes = [waiting(store, 4, 'cy1', 'why?')];
  const { w, runner, chat, promptFile, close } = await chatWorld(changes);
  w.fake.board.chats = store;
  try {
    runner.o.chatId = 'term-1';
    runner.o.cycleId = 'cy1';
    await runner.once('0.0.0');
    await Promise.all([...runner.chatLane.chains.values()]);
    assert.throws(() => readFileSync(promptFile, 'utf8'), 'no Claude run was started');
    const line = chat.find((l: string) => l.startsWith('✉ board chat #4'));
    assert.ok(line, `a ✉ line for the terminal: ${chat.join(' | ')}`);
    assert.match(line!, /"why\?"/);
    assert.match(line!, /chat_read \{"project":"p","scope":"cy1","id":4\}/);
    assert.match(line!, /chat_reply/);
    const took = w.fake.log.find((l) => l.path === '/board/chats/messages/4/take');
    assert.ok(took, 'the message is taken for the terminal');
    assert.equal(w.fake.log.some((l) => l.path === '/board/chats/messages/4/release'), false, 'and not given back');
  } finally { await close(); }
});

test('a message handed to the terminal shows its progress from the transcript: queued, on it, each step, then answered', () => {
  const sent: any[] = [];
  const reporter: any = { report: (b: any) => sent.push({ ...b }), end: async (b: any) => { sent.push({ ...b, ended: true }); } };
  const lane = new chatLane.ChatLane({ o: { chatId: null, log: () => {}, chat: () => {} } });
  lane.track({ key: 'm:7', marker: '✉ board chat #7', reporter,
    done: (name: string, input: any) => /(^|__)chat_reply$/.test(name) && input.messageId === 7 });
  assert.match(sent.at(-1).head, /waiting for its turn/);
  const line = (o: any) => JSON.stringify(o);
  const ev = '<task-notification><event>✉ board chat #7: \\"make it interactive\\"</event></task-notification>';
  lane.onTerminal(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x/A.java' } }] } }));
  assert.equal(sent.length, 1, 'work before the terminal took the message is not its progress');
  lane.onTerminal(line({ type: 'queue-operation', operation: 'enqueue', content: ev }));
  assert.match(sent.at(-1).head, /busy/);
  lane.onTerminal([line({ type: 'user', message: { content: ev } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-docker__search_cycle', input: {} }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/Page.ts' } }] } })].join('\n'));
  assert.equal(sent.at(-1).head, 'your terminal: reading Page.ts');
  assert.deepEqual(sent.at(-1).steps, ['thinking', 'search cycle', 'reading Page.ts']);
  lane.onTerminal(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-docker__chat_reply', input: { messageId: 7 } }] } }));
  assert.equal(sent.at(-1).ended, true);
  assert.equal(sent.at(-1).outcome, 'answered by your terminal');
  assert.equal(lane.pending.size, 0);
});

test('the ✉ line says urgent, and the runner tells Alfred the terminal answers the chat itself', async () => {
  const line = chatLane.chatLine({ messageId: 7, urgent: true, text: 'stop!' }, { project: 'p', scope: 'cy1' });
  assert.match(line, /^✉ board chat #7 ⚡: "stop!"/);
  const calls: any[] = [];
  const lane = new chatLane.ChatLane({ o: { chatId: 'term-1', cycleId: 'cy1', project: 'p', log: () => {},
    alfred: { call: async (method: string, path: string, opts: any) => { calls.push({ method, path, body: opts?.body }); return {}; } } } });
  await lane.start();
  const put = calls.find((c) => c.method === 'PUT' && c.path === '/board/chats/cy1/session');
  assert.ok(put, 'the session marker is stored');
  assert.equal(put.body.chatSessionId, 'term-1');
  assert.equal(put.body.forkedFrom, 'term-1');
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

test('a board change the user asks for is offered as a proposal, never sent back to the user to do by hand', () => {
  assert.match(chatLane.CHAT_RULES, /extra\.proposals/);
  assert.match(chatLane.CHAT_RULES, /Inbox too/);
  assert.match(chatLane.CHAT_RULES, /never tell the user to do it by hand/);
});

test('the chat Claude is taught to draw: the visuals guide, the design kit and the tools to check what it drew', () => {
  assert.match(chatLane.CHAT_RULES, /VISUALS/);
  assert.match(chatLane.CHAT_RULES, /Never hand-draw SVG/);
  assert.match(chatLane.CHAT_RULES, /await alfred\.calls\(/);
  assert.match(chatLane.CHAT_RULES, /<script type="module">/);
  for (const tool of ['board_lib', 'board_snippet_view', 'board_page_get', 'board_files', 'board_file']) assert.ok(chatLane.chatTools().includes(tool), tool);
});
