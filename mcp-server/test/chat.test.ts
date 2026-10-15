import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CYCLE } from './fixtures.ts';
import { world } from './harness.ts';
import { maskProseWith, type MaskContext } from '../src/masking.ts';
import { mirrorText, partOf, MIRROR_INLINE_BLOCK, type ChatMessageRow } from '../src/tools/chat.ts';

/** specs/022: the board chat tools - take, reply with records and terminal items, read, summary, watch, mirror. */

async function chatWorld() {
  const w = await world();
  w.fake.board.chats = { messages: [], holder: {}, terminal: [], watches: [], nextId: 1 };
  const ask = (text: string, extra: Record<string, unknown> = {}) => {
    const c = w.fake.board.chats!;
    const m = { id: c.nextId++, project: 'p', scope: CYCLE, parentId: null, author: 'USER', kind: 'TEXT', text, state: 'WAITING', urgent: false,
      origin: 'typed', context: [], quote: null, extra: null, coversTo: null, replyTo: null, createdAt: '2026-10-15T10:00:00Z', ...extra };
    c.messages.push(m);
    return m;
  };
  return { ...w, ask };
}

const row = (text: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow => ({ id: 5, project: 'p', scope: CYCLE, parentId: null,
  author: 'USER', kind: 'TEXT', text, state: 'WAITING', urgent: false, origin: 'typed', context: [], quote: null, extra: null, coversTo: null,
  replyTo: null, createdAt: '2026-10-15T10:00:00Z', ...extra });
const on = (): MaskContext => ({ on: true, redactions: [], count: 0 });

test('a take returns the message with what the user was looking at and the latest summary', async () => {
  const w = await chatWorld();
  try {
    w.ask('older', { kind: 'SUMMARY', author: 'CLAUDE', state: 'DONE', text: 'We decided on branch filters.' });
    const m = w.ask('why does #3 fail?', { context: ['card:p#3'], quote: 'the 500', urgent: true });
    const r = await w.call('chat_take', { project: 'p', scope: CYCLE, messageId: m.id, chatId: 'chat-a' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.take, /user ⚡urgent:\n> the 500\nwhy does #3 fail\?\n\(looking at: card:p#3\)/);
    assert.match(r.json.summary, /We decided on branch filters/);
    assert.match(r.json.then, /chat_reply/);
    assert.equal(w.fake.board.chats!.messages.find((x) => x.id === m.id).state, 'TAKEN');
  } finally { await w.close(); }
});

test('a take is refused when another chat holds the cycle, and when the message was already taken', async () => {
  const w = await chatWorld();
  try {
    const m = w.ask('hi');
    w.fake.board.chats!.holder[CYCLE] = 'chat-b';
    const refused = await w.call('chat_take', { project: 'p', scope: CYCLE, messageId: m.id, chatId: 'chat-a' });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Another chat \(chat-b\) holds this cycle/);
    delete w.fake.board.chats!.holder[CYCLE];
    await w.call('chat_take', { project: 'p', scope: CYCLE, messageId: m.id, chatId: 'chat-a' });
    const again = await w.call('chat_take', { project: 'p', scope: CYCLE, messageId: m.id, chatId: 'chat-a' });
    assert.equal(again.isError, true);
    assert.match(again.text, /taken/);
  } finally { await w.close(); }
});

test('a reply stores records, masked urgent items and the mirrored exchange for the terminal', async () => {
  const w = await chatWorld();
  try {
    const m = w.ask('should the token be Bearer abcdefghijklmnop?');
    const r = await w.call('chat_reply', { project: 'p', messageId: m.id, text: 'Yes - keep branch filters.',
      records: [{ kind: 'DECISION', text: 'Keep branch filters' }],
      toTerminal: [{ text: 'You edited Search.java; the chat changed it too (Authorization: Basic c2VjcmV0OnNlY3JldA==)', urgent: true, reason: 'changed-files' }] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.recorded, ['✓ recorded the decision "Keep branch filters" in the brief']);
    assert.equal(r.json.toTerminal.length, 1);
    const body = w.fake.log.filter((l) => l.path.endsWith('/reply')).pop()!.body;
    assert.equal(body.toTerminal.length, 2);
    const [urgent, mirror] = body.toTerminal;
    assert.equal(urgent.urgent, true);
    assert.doesNotMatch(urgent.text, /c2VjcmV0/);
    assert.match(urgent.text, /Authorization: \*\*\*REDACTED\*\*\*/);
    assert.equal(mirror.mirror, true);
    assert.equal(mirror.reason, 'exchange');
    assert.match(mirror.text, /you asked: should the token be Bearer \*\*\*REDACTED\*\*\*\?/);
    assert.match(mirror.text, /Claude answered: Yes - keep branch filters\./);
    assert.equal(w.fake.log.filter((l) => l.path.endsWith('/reply')).pop()!.headers?.['x-alfred-actor'], 'claude');
  } finally { await w.close(); }
});

test('the project chat has no terminal session: nothing is sent to one', async () => {
  const w = await chatWorld();
  try {
    const m = w.ask('across cycles?', { scope: 'project' });
    await w.call('chat_reply', { project: 'p', messageId: m.id, text: 'Two cycles show it.' });
    assert.deepEqual(w.fake.log.filter((l) => l.path.endsWith('/reply')).pop()!.body.toTerminal, []);
  } finally { await w.close(); }
});

test('updateId edits the earlier answer in place', async () => {
  const w = await chatWorld();
  try {
    const m = w.ask('watch it');
    const first = await w.call('chat_reply', { project: 'p', messageId: m.id, text: 'batch 1: fine' });
    const id = Number(String(first.json.replied).slice(1));
    await w.call('chat_reply', { project: 'p', messageId: m.id, text: 'batch 2: one 500', updateId: id });
    const answers = w.fake.board.chats!.messages.filter((x) => x.replyTo === m.id);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].text, 'batch 2: one 500');
    assert.equal(w.fake.board.chats!.terminal.filter((t) => t.mirror).length, 1, 'one mirrored item per exchange, not per update');
  } finally { await w.close(); }
});

test('chat_read gives a page, one message, a part, and the answer a mirrored reference points to', async () => {
  const w = await chatWorld();
  try {
    const q = w.ask('show the query');
    w.ask('here:\n```sql\nSELECT 1\n```', { author: 'CLAUDE', state: 'DONE', replyTo: q.id });
    const page = await w.call('chat_read', { project: 'p', scope: CYCLE });
    assert.equal(page.json.messages.length, 2);
    const part = await w.call('chat_read', { project: 'p', scope: CYCLE, answerOf: q.id, part: 'sql' });
    assert.equal(part.json.text.trim(), 'SELECT 1');
    const none = await w.call('chat_read', { project: 'p', scope: CYCLE, id: q.id, part: 'diff' });
    assert.match(none.json.nothing, /no diff part/);
  } finally { await w.close(); }
});

test('a summary, a watch and a runner mirror item are stored as Claude', async () => {
  const w = await chatWorld();
  try {
    const m = w.ask('tell me when AC3 passes');
    const s = await w.call('chat_summary', { project: 'p', scope: CYCLE, text: 'Decided: branch filters.', coversTo: m.id });
    assert.equal(s.isError, false, s.text);
    assert.equal(w.fake.board.chats!.messages.at(-1).kind, 'SUMMARY');
    const watch = await w.call('chat_watch', { project: 'p', scope: CYCLE, kind: 'ITEM_PASSES', target: 'ac3', label: 'AC3 passes', messageId: m.id });
    assert.equal(watch.json.watching, 'AC3 passes');
    const mirror = await w.call('chat_mirror', { project: 'p', scope: CYCLE, items: [{ text: 'compacted - password=hunter2', reason: 'compact' }] });
    assert.equal(mirror.isError, false, mirror.text);
    assert.equal(w.fake.board.chats!.terminal.at(-1).text, 'compacted - password=***REDACTED***');
    assert.equal(w.fake.board.chats!.terminal.at(-1).mirror, false);
    const refused = await w.call('chat_mirror', { project: 'p', scope: 'project', items: [{ text: 'x' }] });
    assert.equal(refused.isError, true);
  } finally { await w.close(); }
});

test('prose masking hides tokens, headers, password fields and JWTs', () => {
  const ctx = on();
  const out = maskProseWith(ctx, 'Bearer abc.def-ghij12 then Cookie: sid=1; x=2\n"password": "p@ss" and api_key=XYZ123 '
    + 'and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl');
  assert.doesNotMatch(out, /abc\.def|sid=1|p@ss|XYZ123|eyJhbGci/);
  assert.equal(ctx.count, 1);
  assert.equal(maskProseWith(on(), 'nothing secret here'), 'nothing secret here');
});

test('a mirrored exchange carries a long block as a reference and stays bounded', () => {
  const big = '```diff\n' + '+x\n'.repeat(MIRROR_INLINE_BLOCK) + '```';
  const text = mirrorText(on(), row('fix it?'), `Done.\n${big}\n${'y'.repeat(9000)}`, 'chat_read {"answerOf":5}');
  assert.match(text, /\[diff block, \d+ lines - chat_read \{"answerOf":5\}\]/);
  assert.match(text, /… \[the rest - chat_read/);
  assert.ok(text.length < 7000);
  assert.equal(partOf(row('```sql\nSELECT 2\n```'), 'sql')?.trim(), 'SELECT 2');
  assert.equal(partOf(row('x', { extra: { visual: '<svg/>' } }), 'visual'), '<svg/>');
});

test('board_changes lists chat messages to take, urgent first, and what the chat sent the terminal', async () => {
  const w = await chatWorld();
  try {
    w.fake.board.changes = { entries: [], cycles: [], cursor: '5.0.12', more: false,
      chats: [{ messageId: 11, project: 'p', scope: CYCLE, kind: 'TEXT', urgent: false, parentId: null, origin: 'typed', text: 'first', at: 't1' },
        { messageId: 12, project: 'p', scope: 'project', kind: 'TEXT', urgent: true, parentId: null, origin: 'typed', text: 'now please', at: 't2' }],
      fromChat: [{ id: 1, urgent: true, mirror: false, text: 'decision contradicts your step', reason: 'contradicts', state: 'SENT' },
        { id: 2, urgent: false, mirror: true, text: 'you asked: x', reason: 'exchange', state: 'SENT' }] };
    const r = await w.call('board_changes', { cursor: '0' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.chats.length, 2);
    assert.match(r.json.chats[0], /⚡ chat p project #12: "now please" → chat_take/);
    assert.match(r.json.chats[1], /chat cycle cy-booking #11/);
    assert.deepEqual(r.json.fromChat, ['⚡ decision contradicts your step', '💬 you asked: x']);
    assert.equal(r.json.nothing, undefined);
    assert.equal(r.json.cursor, '5.0.12');
  } finally { await w.close(); }
});
