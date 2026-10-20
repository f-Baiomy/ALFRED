import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { world } from './harness.ts';

/**
 * specs/022: the board chat lane of the /alfred-live runner - which messages it hands to its session, in what order, how it
 * follows the session's work, what happens when the session stops hearing the chat log - and its pure helpers. Since
 * 2026-10-19 nothing is answered in a fork, a copy or a headless run: only the session that ran /alfred-live answers.
 */

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const live: any = await import(pathToFileURL(fileURLToPath(new URL('../../skills/alfred-live/alfred-live.mjs', import.meta.url))).href);
const chatLane: any = await import(pathToFileURL(fileURLToPath(new URL('../../skills/alfred-live/chat.mjs', import.meta.url))).href);
const CHAT_SRC = readFileSync(fileURLToPath(new URL('../../skills/alfred-live/chat.mjs', import.meta.url)), 'utf8');

test('the lane never forks, copies or runs Claude itself - the session that ran /alfred-live answers (2026-10-19)', () => {
  assert.doesNotMatch(CHAT_SRC, /--fork-session|viaCopy|chatSessionArgs|pool\.(acquire|run)/);
  assert.equal(chatLane.chatSessionArgs, undefined);
  assert.equal(chatLane.sessionIdOf({ type: 'system', subtype: 'init', session_id: 's-1' }), 's-1');
  assert.equal(chatLane.sessionIdOf({ type: 'assistant' }), null);
  const LIVE_SRC = readFileSync(fileURLToPath(new URL('../../skills/alfred-live/alfred-live.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(LIVE_SRC, /--headless|runHeadless|headlessRun/);
});

test('messages go urgent first, then in waiting order; a runner answers only its own chats', () => {
  const chats = [{ messageId: 1, seq: 1, scope: 'cy1', project: 'p' }, { messageId: 2, seq: 2, scope: 'cy1', project: 'p', urgent: true },
    { messageId: 3, seq: 3, scope: 'project', project: 'p' }, { messageId: 4, seq: 4, scope: 'cy2', project: 'p' }];
  assert.deepEqual(chatLane.orderChats(chats).map((c: any) => c.messageId), [2, 1, 3, 4]);
  assert.deepEqual(chatLane.mineOf(chats, { cycleId: 'cy1' }).map((c: any) => c.messageId), [1, 2]);
  // the project's session answers the project chat only: a board chat waits for its own session (2026-10-19)
  assert.deepEqual(chatLane.mineOf(chats, { project: 'p' }).map((c: any) => c.messageId), [3]);
  assert.deepEqual(chatLane.mineOf(chats, {}).map((c: any) => c.messageId), [3]);
  assert.deepEqual(chatLane.mineOf(chats, { project: 'q' }), []);
  assert.deepEqual(chatLane.mineOf(chats, { cycleId: 'cy1', kind: 'listen' }), []);
});

test('a skill picked from the chat "/" list is named in its line; one it does not offer is an ordinary message', () => {
  assert.equal(chatLane.skillOf('skill:alfred-fix'), 'alfred-fix');
  assert.equal(chatLane.skillOf('skill:alfred-live'), null);
  assert.equal(chatLane.skillOf('typed'), null);
  assert.match(chatLane.chatLine({ messageId: 9, text: '/alfred-status', origin: 'skill:alfred-status' }, { project: 'p', scope: 'cy1' }), /picked \/alfred-status/);
  assert.doesNotMatch(chatLane.chatLine({ messageId: 9, text: 'hi', origin: 'typed' }, { project: 'p', scope: 'cy1' }), /picked/);
});

test("the session's significant work is read from its transcript", () => {
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
  const close = async () => { runner.pool.close(); await w.close(); };
  return { w, runner, lines, chat, promptFile, dir, close };
}

const waiting = (c: any, id: number, scope: string, text: string, extra: any = {}) => {
  c.messages.push({ id, project: 'p', scope, parentId: null, author: 'USER', kind: 'TEXT', text, state: 'WAITING', urgent: false, origin: 'typed',
    context: [], quote: null, extra: null, coversTo: null, replyTo: null, createdAt: '2026-10-15T10:00:00Z', ...extra });
  return { messageId: id, project: 'p', scope, kind: 'TEXT', urgent: !!extra.urgent, parentId: null, origin: 'typed', text, at: 't', seq: id };
};

test("the project's session answers the project chat: its messages become ✉ lines, urgent first - a board chat is not its", async () => {
  const store = { messages: [] as any[], holder: {} as Record<string, string>, terminal: [] as any[], watches: [], nextId: 50 };
  const changes = [waiting(store, 1, 'project', 'first'), waiting(store, 2, 'project', 'second', { urgent: true }), waiting(store, 3, 'cy1', 'not mine')];
  const { w, runner, chat, promptFile, close } = await chatWorld(changes);
  w.fake.board.chats = store;
  try {
    runner.o.chatId = 'proj-sess';
    await runner.once('0.0.0');
    await Promise.all([...runner.chatLane.chains.values()]);
    assert.throws(() => readFileSync(promptFile, 'utf8'), 'no Claude run was started');
    const lines = chat.filter((l: string) => l.startsWith('✉ board chat #'));
    assert.deepEqual(lines.map((l: string) => l.slice(0, 15)), ['✉ board chat #2', '✉ board chat #1'], chat.join(' | '));
    assert.equal(w.fake.log.some((l) => l.path === '/board/chats/messages/3/take'), false, "a board chat waits for the board's own session");
  } finally { await close(); }
});

test('a runner with no session to hand them to leaves the messages waiting - never answered in a run of its own', async () => {
  const store = { messages: [] as any[], holder: {} as Record<string, string>, terminal: [] as any[], watches: [], nextId: 50 };
  const { w, runner, lines, promptFile, close } = await chatWorld([waiting(store, 5, 'project', 'hello')]);
  w.fake.board.chats = store;
  try {
    await runner.once('0.0.0');
    await Promise.all([...runner.chatLane.chains.values()]);
    assert.throws(() => readFileSync(promptFile, 'utf8'), 'no Claude run was started');
    assert.equal(w.fake.log.some((l) => l.path === '/board/chats/messages/5/take'), false, 'not taken');
    assert.equal(store.messages.find((m) => m.id === 5).state, 'WAITING');
    assert.ok(lines.some((l) => /no Claude session follows this runner/.test(l)));
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
  assert.match(sent.at(-1).head, /waiting for your terminal/);
  const line = (o: any) => JSON.stringify(o);
  const ev = '<task-notification><event>✉ board chat #7: \\"make it interactive\\"</event></task-notification>';
  lane.onTerminal(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x/A.java' } }] } }));
  assert.equal(sent.length, 1, 'work before the terminal took the message is not its progress');
  lane.onTerminal(line({ type: 'queue-operation', operation: 'enqueue', content: ev }));
  assert.match(sent.at(-1).head, /queued in your terminal/);
  lane.onTerminal([line({ type: 'user', message: { content: ev } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-docker__search_cycle', input: {} }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/Page.ts' } }] } })].join('\n'));
  assert.equal(sent.at(-1).head, 'working in your terminal: reading Page.ts');
  assert.deepEqual(sent.at(-1).steps, ['thinking', 'search cycle', 'reading Page.ts']);
  lane.onTerminal(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-docker__chat_reply', input: { messageId: 7 } }] } }));
  assert.equal(sent.at(-1).ended, true);
  assert.equal(sent.at(-1).outcome, 'answered by your terminal');
  assert.equal(lane.pending.size, 0);
});

test('a card change the terminal took up ends on any write to that card, or when its turn ends (2026-10-18, #76)', () => {
  assert.ok(live.CARD_ANSWER_TOOLS.test('mcp__alfred-docker__board_comment'));
  assert.ok(live.CARD_ANSWER_TOOLS.test('mcp__alfred__board_move'));
  assert.ok(!live.CARD_ANSWER_TOOLS.test('mcp__alfred__board_get'));
  const sent: any[] = [];
  const reporter: any = { report: (b: any) => sent.push({ ...b }), end: async (b: any) => { sent.push({ ...b, ended: true }); } };
  const lane = new chatLane.ChatLane({ o: { chatId: null, log: () => {}, chat: () => {} } });
  lane.track({ key: 'c:76', marker: '✉ #76 ', reporter, done: () => false });
  const line = (o: any) => JSON.stringify(o);
  lane.onTerminal(line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'other work' }] } }));
  assert.equal(lane.pending.size, 1, 'a turn that never took it up does not end it');
  lane.onTerminal([line({ type: 'user', message: { content: '<event>✉ #76 "Air Arabia"</event>' } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-docker__board_comment', input: { number: 76 } }] } }),
    line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I moved #76' }] } })].join('\n'));
  assert.equal(sent.at(-1).ended, true);
  assert.equal(sent.at(-1).outcome, 'handled by your terminal');
  assert.equal(lane.pending.size, 0);
});

test('two changes on one card handed close together leave one strip working - the older one ends, never stuck (2026-10-20)', () => {
  const ends: any[] = [];
  const mk = (n: number): any => ({ report: () => {}, end: async (b: any) => { ends.push({ n, ...b }); } });
  const lane = new chatLane.ChatLane({ o: { chatId: null, log: () => {}, chat: () => {} } });
  lane.track({ key: 'c:100', marker: '✉ #100 ', reporter: mk(1), done: () => false });
  lane.track({ key: 'c:100', marker: '✉ #100 ', reporter: mk(2), done: (name: string) => /board_reply$/.test(name) });
  assert.deepEqual(ends.map((e) => [e.n, e.outcome]), [[1, 'merged into a newer change on this card']]);
  lane.onTerminal(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred__board_reply', input: { number: 100 } }] } }));
  assert.deepEqual(ends.map((e) => e.n), [1, 2]);
  assert.equal(lane.pending.size, 0);

  // held while the session is deaf: the newer change replaces the older, whose strip ends at once
  const dropped: string[] = [];
  const handed: string[] = [];
  lane.hold('c:101', () => handed.push('first'), () => dropped.push('first'));
  lane.hold('c:101', () => handed.push('second'), () => dropped.push('second'));
  lane.flushHeld();
  assert.deepEqual(dropped, ['first']);
  assert.deepEqual(handed, ['second']);
});

test('a message queued while the terminal was busy ends on its chat_reply even with no "received" event', () => {
  const sent: any[] = [];
  const reporter: any = { report: (b: any) => sent.push({ ...b }), end: async (b: any) => { sent.push({ ...b, ended: true }); } };
  const lane = new chatLane.ChatLane({ o: { chatId: null, log: () => {}, chat: () => {} } });
  lane.track({ key: 'm:8', marker: '✉ board chat #8', reporter,
    done: (name: string, input: any) => /(^|__)chat_reply$/.test(name) && input.messageId === 8 });
  const line = (o: any) => JSON.stringify(o);
  lane.onTerminal(line({ type: 'queue-operation', operation: 'enqueue', content: '<event>✉ board chat #8: \\"hi\\"</event>' }));
  assert.match(sent.at(-1).head, /queued in your terminal/);
  lane.onTerminal(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x/B.java' } }] } }));
  assert.equal(sent.at(-1).steps.length, 0, 'other work of the terminal is not its progress');
  lane.onTerminal(line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__alfred-docker__chat_reply', input: { messageId: 8 } }] } }));
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

test('a chat run may use every team_* tool - without them it could not even prepare a state change bundle', () => {
  const source = readFileSync(new URL('../src/tools/team.ts', import.meta.url), 'utf8');
  const registered = [...new Set(source.match(/'team_[a-z_]+'/g)!.map((s) => s.slice(1, -1)))];
  assert.ok(registered.length >= 29, `found ${registered.length}`);
  for (const tool of registered) assert.ok(chatLane.chatTools().includes(tool), tool);
});

test('an http MCP server gets the user key on every call - without it the board lock refused every write as HELD (specs/032)', () => {
  const entry = { type: 'http', url: 'http://localhost:3000/mcp' };
  assert.deepEqual(live.withIdentity(entry, { ALFRED_KEY: 'ak_1', ALFRED_VIA: 'sess-1' }).headers, { 'X-Alfred-Key': 'ak_1', 'X-Alfred-Via': 'sess-1' });
  assert.equal(live.withIdentity(entry, {}), entry, 'no key: unchanged');
  const stdio = { command: 'node', args: ['x.js'] };
  assert.equal(live.withIdentity(stdio, { ALFRED_KEY: 'ak_1' }), stdio, 'a stdio server inherits the env instead');
});

// ------------------------------------------------------------------------------- 2026-10-19: a deaf terminal
function deafWorld(extra: Record<string, unknown> = {}) {
  const logs: string[] = [];
  const chatLines: string[] = [];
  const calls: { method: string; path: string; body?: any }[] = [];
  const runner: any = { o: { chatId: 'term-1', cycleId: 'cy1', project: 'p', chatPath: 'C:/tmp/alfred-live/x.term1.chat.log', log: (l: string) => logs.push(l),
    chat: (l: string) => chatLines.push(l), alfred: { call: async (method: string, path: string, o: any) => { calls.push({ method, path, body: o?.body }); return null; } },
    ...extra }, say: (l: string) => logs.push(l) };
  let beats = 0;
  let rereads = 0;
  runner.beat = () => { beats++; };
  runner.rereadChats = () => { rereads++; };
  const lane = new chatLane.ChatLane(runner);
  const ended: any[] = [];
  const reporter = () => ({ report: () => {}, end: async (b: any) => { ended.push(b); } });
  return { lane, logs, chatLines, calls, ended, reporter, beats: () => beats, rereads: () => rereads };
}
const jl = (o: any) => JSON.stringify(o);
const delivered = (id: number, task = 'b4aunys0m') => jl({ type: 'user', message: { content:
  `<task-notification> <task-id>${task}</task-id> <summary>Monitor event: "Alfred live · p"</summary> <event>✉ board chat #${id}: "hi"</event>` } });
const stopped = (task = 'b4aunys0m') => jl({ type: 'user', message: { content:
  `<task-notification> <task-id>b7wdn4i4l</task-id> <task-id>${task}</task-id> <status>stopped</status> <summary>3 background shell command tasks didn't finish</summary>` } });

test('a session whose chat-log watch ended is deaf: what it was handed waits again, and the board says how to wake it (2026-10-19)', async () => {
  const { lane, logs, chatLines, calls, ended, reporter, beats } = deafWorld();
  lane.onTerminal(delivered(3)); // learns which background task delivers the ✉ lines
  assert.ok(lane.listeners.has('b4aunys0m'));
  lane.track({ key: 'm:9', marker: '✉ board chat #9', reporter: reporter(), done: () => false });
  lane.pending.get('m:9').item = { project: 'p', t: { messageId: 9 } };
  lane.onTerminal(jl({ type: 'user', message: { content: '<task-notification><task-id>other</task-id><status>completed</status></task-notification>' } }));
  assert.equal(lane.deafSince, null, 'another task ending changes nothing');
  lane.onTerminal(stopped());
  assert.ok(lane.deafSince, 'the watch that delivered the ✉ lines ended: deaf');
  const back = calls.find((c) => c.path === '/board/chats/messages/9/release');
  assert.ok(back, 'the message it never took up goes back to waiting');
  assert.equal(back!.body.failed, false, 'waiting, not failed');
  assert.equal(ended[0].outcome, 'your session is not listening - the message waits for it');
  const told = calls.find((c) => c.path === '/board/chats/cy1/system');
  assert.match(told!.body.text, /stopped listening/);
  assert.match(told!.body.text, /send \/alfred-live/);
  assert.doesNotMatch(told!.body.text, /copy/);
  assert.ok(chatLines.some((l) => /stopped hearing the board/.test(l)), 'and the session, if it comes back');
  assert.ok(logs.some((l) => /not listening/.test(l)));
  assert.ok(beats() >= 1, 'the board hears it now, not at the next heartbeat');
});

test('a handed message nobody takes up within the deadline (checked on the heartbeat) makes the session deaf - never "Claude has it" for ever', async () => {
  const { lane, calls } = deafWorld({ ackMs: 30 });
  lane.r.o.chat = () => {};
  await lane.toTerminal('cy1', 'p', [{ messageId: 11, urgent: false }], [{ messageId: 11, take: '#11 user: you hear me?' }]);
  lane.checkDeadlines(Date.now() + 10);
  assert.equal(lane.deafSince, null, 'not before the deadline');
  lane.checkDeadlines(Date.now() + 60);
  assert.ok(lane.deafSince);
  assert.ok(calls.some((c) => c.path === '/board/chats/messages/11/release'), 'it waits again');
  const { lane: busy } = deafWorld({ ackMs: 30 });
  busy.r.o.chat = () => {};
  await busy.toTerminal('cy1', 'p', [{ messageId: 12, urgent: false }], [{ messageId: 12, take: '#12' }]);
  busy.onTerminal(jl({ type: 'queue-operation', operation: 'enqueue', content: '<event>✉ board chat #12: "x"</event>' }));
  busy.checkDeadlines(Date.now() + 60);
  assert.equal(busy.deafSince, null, 'queued in a busy session is delivered - it answers after its current step');
});

test('while deaf nothing is taken or answered; the session watching the chat log again gets what waited', async () => {
  const { lane, calls, rereads } = deafWorld();
  lane.goDeaf('test');
  const routed: number[] = [];
  let takes = 0;
  lane.take = async (c: any) => { takes++; return { messageId: c.messageId }; };
  lane.toTerminal = async (_s: string, _p: string, _l: any, taken: any[]) => { routed.push(...taken.map((t) => t.messageId)); };
  await lane.answer('cy1', [{ messageId: 20, project: 'p' }]);
  assert.equal(takes, 0, 'not even taken: it stays waiting for the session');
  const handed: string[] = [];
  lane.hold('c:5', () => handed.push('#5'));
  lane.flushHeld();
  assert.deepEqual(handed, [], 'a card change waits too');
  lane.onTerminal(jl({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Monitor', input: { command: 'tail -n 0 -F "C:/tmp/alfred-live/x.term1.chat.log"' } }] } }));
  assert.equal(lane.deafSince, null, 'it ran the watch again');
  assert.ok(calls.some((c) => c.method === 'PUT' && c.path === '/board/chats/cy1/session'), 'Alfred is told the session answers again');
  assert.equal(rereads(), 1, 'what waited is read again and handed to it');
  lane.flushHeld();
  assert.deepEqual(handed, ['#5']);
  await lane.answer('cy1', [{ messageId: 21, project: 'p' }]);
  assert.deepEqual(routed, [21]);
});

test('a runner started after the watch ended knows it at once from the transcript, quietly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deaf-'));
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  const path = chatLane.transcriptPath(cwd, 'term-1', dir);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, [delivered(1), stopped()].join('\n') + '\n');
  const { lane, calls } = deafWorld({ cwd });
  const orig = chatLane.transcriptPath;
  // the lane resolves the transcript under the real home; point it at this one
  lane.followTerminal = function () {
    this.replaying = true;
    this.onTerminal(readFileSync(path, 'utf8'));
    this.replaying = false;
  };
  lane.followTerminal();
  assert.ok(lane.deafSince);
  assert.equal(calls.length, 0, 'nothing posted while the transcript is replayed - it may still hear again further on');
  assert.equal(typeof orig, 'function');
});

test('a runner that starts deaf says so on the board once, and never claims the chat for the terminal', async () => {
  const { lane, calls, chatLines } = deafWorld();
  lane.followTerminal = function () {
    this.replaying = true;
    this.onTerminal([delivered(1), stopped()].join('\n'));
    this.replaying = false;
  };
  await lane.start();
  const told = calls.filter((c) => c.path === '/board/chats/cy1/system' && /stopped listening/.test(c.body.text));
  assert.equal(told.length, 1, 'the board says the terminal does not hear it (2026-10-19: the user saw answers and believed their session wrote them)');
  assert.ok(!calls.some((c) => c.method === 'PUT' && c.path === '/board/chats/cy1/session'), 'Alfred is not told the terminal answers');
  assert.ok(chatLines.some((l) => /stopped hearing the board/.test(l)));
});
