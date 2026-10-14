import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { beat, liveHolder, respondTo, whileBeating } from '../src/tools/live.ts';
import { tapFetch } from './fetch-tap.ts';
import { world } from './harness.ts';

/** /alfred-live: board_live hands back each card the user touched, ready to answer in one more call. */

const change = (over: Record<string, unknown>) => ({
  actor: 'USER', kind: 'COMMENT', text: null, oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z',
  project: 'p', number: 1, title: 'Fare changes at confirm', status: 'INBOX', cycleId: 'cy', cardId: 'card-1', replyTo: null, ...over,
});

test('board_live: an answer to your question, a move in the same burst, the thread with indexes - and never your own changes', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'QUESTION', title: 'Fare changes at confirm' });
    w.fake.board.activity['card-1'] = [
      { id: 1, actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** May fare.total change at confirm?', oldValue: null, newValue: null, at: '2026-10-13T08:59:00Z', replyTo: null },
      { id: 2, actor: 'USER', kind: 'COMMENT', text: 'Yes - but show it to the traveller', oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z', replyTo: 1 },
      { id: 3, actor: 'USER', kind: 'STATUS', text: null, oldValue: 'INBOX', newValue: 'TO_DO', at: '2026-10-13T09:00:01Z', replyTo: null },
    ];
    w.fake.board.changes = {
      entries: [
        change({ id: 2, text: 'Yes - but show it to the traveller', replyTo: 1 }),
        change({ id: 3, kind: 'STATUS', oldValue: 'INBOX', newValue: 'TO_DO' }),
        change({ id: 4, actor: 'CLAUDE', text: '**Reply** noted' }),
      ],
      cycles: [{ cycleId: 'cy', what: 'brief', name: 'ODY-482', detail: null, at: '2026-10-13T09:00:02Z' }],
      cursor: '4.1', more: false,
    };
    const r = await w.call('board_live', { project: 'p', settleMs: 0, timeoutSeconds: 5 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.cards.length, 1);
    const card = r.json.cards[0];
    assert.equal(card.number, 1);
    assert.equal(card.userDid.length, 2, 'Claude\'s own change is not handed back');
    assert.match(card.userDid[0], /^ANSWERS your question \[0\] - act on it now; reply in that thread \(board_reply replyTo 0\)/);
    assert.match(card.userDid[1], /moved it to To do/);
    assert.equal(card.thread.length, 3);
    assert.match(card.thread[0], /^\[0\] .*Claude: \*\*Question\*\* May fare\.total change at confirm\? \(question - answered\)$/);
    assert.match(card.thread[1], /^\[1\] ↳ reply to \[0\] /);
    assert.equal(card.openQuestions, undefined);
    assert.match(r.json.cycleChanges[0], /cycle cy "ODY-482": brief - re-read the brief \(task_context\)/);
    assert.equal(r.json.cursor, '4.1');
    const sent = w.fake.requests('GET', '/board/changes/wait')[0];
    assert.equal(sent.query.get('actor'), 'USER');
    assert.equal(sent.query.get('cursor'), 'now');

    // While it runs, another session's board_wait leaves the user's changes to it; once stopped, it does not.
    const waited = await w.call('board_wait', { project: 'p', timeoutSeconds: 1 });
    assert.match(waited.json.live, /\/alfred-live is answering the user/);
    await w.call('board_live_stop', { project: 'p' });
    const after = await w.call('board_wait', { project: 'p', timeoutSeconds: 1 });
    assert.equal(after.json.live, undefined);
  } finally { await w.close(); }
});

test('board_live with nothing new says so and hands back the cursor and the next call', async () => {
  const w = await world();
  try {
    w.fake.board.changes = { entries: [], cycles: [], cursor: '9.0', more: false };
    const r = await w.call('board_live', { project: 'p', cursor: '9.0', timeoutSeconds: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.cursor, '9.0');
    assert.match(r.json.next, /^board_live \{"cursor":"9\.0","project":"p"/);
    assert.equal(r.json.cards, undefined);
  } finally { await w.close(); }
});

test('what each change asks for: a question gets an answer, a plain note does not, a dismissed proposal a new plan', () => {
  const idx = (id: number | undefined) => id;
  assert.match(respondTo(change({ id: 5, text: 'Why does the second call drop the fare?' }) as never, undefined, idx), /^asks you \[5\] - answer it/);
  assert.match(respondTo(change({ id: 6, text: 'Checked on staging too.' }) as never, undefined, idx), /^comments \[6\] - answer in its thread when/);
  assert.match(respondTo(change({ id: 7, text: 'no, the other one' }) as never,
    { id: 3, actor: 'CLAUDE', kind: 'COMMENT', text: '**Reply** it is the fare', oldValue: null, newValue: null, at: '' }, idx), /^replies to Claude \[7\]/);
  assert.match(respondTo(change({ kind: 'PROPOSAL_DISMISSED' }) as never, undefined, idx), /what you will do instead/);
  assert.match(respondTo(change({ kind: 'STATUS', newValue: 'FIXED' }) as never, undefined, idx), /re-test steps/);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await sleep(10);
  }
}

const CHANGES = (extra: Record<string, unknown> = {}) => ({
  entries: [change({ id: 5, text: 'Why does the second call drop the fare?', ...extra })], cycles: [], cursor: '9.0', more: false,
});

test('board_live while the user has paused Claude: nothing is consumed, the cursor stays, and the call waits out its timeout', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Fare changes at confirm' });
    w.fake.board.agentState = 'PAUSED';
    w.fake.board.changes = CHANGES();
    const started = Date.now();
    const r = await w.call('board_live', { project: 'p', cursor: '4.0', settleMs: 0, timeoutSeconds: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.paused, true);
    assert.equal(r.json.cursor, '4.0', 'the cursor the call was given');
    assert.equal(r.json.cards, undefined, 'nothing to answer');
    assert.match(r.json.next, /^board_live \{"cursor":"4\.0","project":"p"/);
    assert.equal(w.fake.requests('GET', '/board/changes/wait').length, 0, 'a change after the cursor would have ended a wait at once - none was made');
    assert.ok(Date.now() - started >= 900, 'it waited, so a loop on it does not spin');
  } finally { await w.close(); }
});

test('board_live: paused while it waits, the change that woke it is not consumed either', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Fare changes at confirm' });
    let release!: () => void;
    w.fake.board.waitGate = new Promise<void>((resolve) => { release = resolve; });
    w.fake.board.changes = CHANGES();
    const pending = w.call('board_live', { project: 'p', cursor: '4.0', settleMs: 0, timeoutSeconds: 5 });
    await until(() => w.fake.requests('GET', '/board/changes/wait').length === 1);
    w.fake.board.agentState = 'PAUSED';
    release();
    const r = await pending;
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.paused, true);
    assert.equal(r.json.cursor, '4.0', 'not the 9.0 the wait returned');
    assert.equal(r.json.cards, undefined);
  } finally { await w.close(); }
});

test('board_live that finds the user has resumed answers what came meanwhile', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Fare changes at confirm' });
    w.fake.board.agentState = 'PAUSED';
    w.fake.board.changes = CHANGES();
    setTimeout(() => { w.fake.board.agentState = 'WATCHING'; }, 100);
    const r = await w.call('board_live', { project: 'p', cursor: '4.0', settleMs: 0, timeoutSeconds: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.paused, undefined);
    assert.equal(r.json.cards.length, 1);
    assert.equal(r.json.cursor, '9.0');
    assert.equal(w.fake.requests('GET', '/board/changes/wait')[0].query.get('cursor'), '4.0');
  } finally { await w.close(); }
});

test('the heartbeat is refreshed every few seconds while a wait lasts, and stops with it', async () => {
  const base = 'http://heartbeat.test:1';
  beat(base, 'p');
  const first = liveHolder(base)!.at;
  await sleep(5);
  const result = await whileBeating(base, 'p', async () => { await sleep(150); return 'waited'; }, 25);
  assert.equal(result, 'waited');
  const after = liveHolder(base)!.at;
  assert.ok(Date.parse(after) > Date.parse(first), 'beat again during the wait');
  await sleep(80);
  assert.equal(liveHolder(base)!.at, after, 'no beat once the wait is over');

  await assert.rejects(whileBeating(base, 'p', async () => { throw new Error('the wait failed'); }, 25), /the wait failed/);
  const failed = liveHolder(base)!.at;
  await sleep(80);
  assert.equal(liveHolder(base)!.at, failed, 'nor after a wait that failed');
  beat(base, 'p', true);
});

test('board_live beats every 20 s while it waits', async () => {
  const w = await world();
  try {
    let release!: () => void;
    w.fake.board.waitGate = new Promise<void>((resolve) => { release = resolve; });
    w.fake.board.changes = { entries: [], cycles: [], cursor: '1.0', more: false };
    mock.timers.enable({ apis: ['setInterval'] });
    const pending = w.call('board_live', { project: 'p', cursor: '1.0', timeoutSeconds: 50 });
    await until(() => w.fake.requests('GET', '/board/changes/wait').length === 1);
    const before = liveHolder(w.fake.url)!.at;
    await sleep(10);
    mock.timers.tick(19_000);
    assert.equal(liveHolder(w.fake.url)!.at, before, 'not before 20 s');
    mock.timers.tick(1_000);
    assert.ok(Date.parse(liveHolder(w.fake.url)!.at) > Date.parse(before), 'at 20 s');
    release();
    const r = await pending;
    assert.equal(r.isError, false, r.text);
    beat(w.fake.url, 'p', true);
  } finally { mock.timers.reset(); await w.close(); }
});

test('a card\'s context reads the card and its history together when the change names the card, one after the other when it does not', async () => {
  const w = await world();
  const tap = tapFetch(w.fake.url, ({ path }) => (path === '/board/cards/by-number/1' ? { delayMs: 80 } : undefined));
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Fare changes at confirm' });
    w.fake.board.activity['card-1'] = [{ id: 1, actor: 'USER', kind: 'COMMENT', text: 'Why does the second call drop the fare?', oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z', replyTo: null }];
    w.fake.board.changes = CHANGES({ id: 1 });
    const named = await w.call('board_live', { project: 'p', cursor: '4.0', settleMs: 0, timeoutSeconds: 1 });
    assert.equal(named.isError, false, named.text);
    assert.equal(named.json.cards[0].number, 1);
    const order = (event: string) => tap.events.indexOf(event);
    assert.ok(order('start GET /board/cards/card-1/activity') < order('end GET /board/cards/by-number/1'), tap.events.join('\n'));

    tap.events.length = 0;
    const { cardId: _gone, ...unnamed } = CHANGES({ id: 1 }).entries[0];
    w.fake.board.changes = { entries: [unnamed], cycles: [], cursor: '9.0', more: false };
    const after = await w.call('board_live', { project: 'p', cursor: '4.0', settleMs: 0, timeoutSeconds: 1 });
    assert.equal(after.json.cards[0].number, 1, 'a change with no card id still finds its card');
    assert.ok(order('end GET /board/cards/by-number/1') < order('start GET /board/cards/card-1/activity'), tap.events.join('\n'));
  } finally { tap.restore(); await w.close(); }
});

test('board_live_card gives the context of one card from the changes the caller holds, without waiting - and leaves the heartbeat alone', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'QUESTION', title: 'Fare changes at confirm' });
    w.fake.board.activity['card-1'] = [
      { id: 1, actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** May fare.total change at confirm?', oldValue: null, newValue: null, at: '2026-10-13T08:59:00Z', replyTo: null },
      { id: 2, actor: 'USER', kind: 'COMMENT', text: 'Yes - but show it to the traveller', oldValue: null, newValue: null, at: '2026-10-13T09:00:00Z', replyTo: 1 },
      { id: 3, actor: 'USER', kind: 'STATUS', text: null, oldValue: 'INBOX', newValue: 'TO_DO', at: '2026-10-13T09:00:01Z', replyTo: null },
    ];
    const r = await w.call('board_live_card', { project: 'p', number: 1, changes: [
      { id: 2, kind: 'COMMENT', text: 'Yes - but show it to the traveller', replyTo: 1, oldValue: null, newValue: null, actor: 'USER', at: '2026-10-13T09:00:00Z' },
      { id: 3, kind: 'STATUS', oldValue: 'INBOX', newValue: 'TO_DO' },
      { id: 4, kind: 'COMMENT', text: '**Reply** noted', actor: 'CLAUDE' },
    ] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.number, 1);
    assert.equal(r.json.userDid.length, 2, 'Claude\'s own change is left out');
    assert.match(r.json.userDid[0], /^ANSWERS your question \[0\] - act on it now; reply in that thread \(board_reply replyTo 0\)/);
    assert.match(r.json.userDid[1], /moved it to To do/);
    assert.equal(r.json.thread.length, 3);
    assert.match(r.json.thread[1], /^\[1\] ↳ reply to \[0\] /);
    assert.equal(r.json.masked, false);
    assert.equal(w.fake.requests('GET', '/board/changes').length, 0, 'it waits for nothing and asks the board for no changes');
    assert.equal(liveHolder(w.fake.url), null, 'a prefetch is no board_live loop');

    // The same card, as board_live hands it back, is the same context.
    w.fake.board.changes = { entries: [change({ id: 2, text: 'Yes - but show it to the traveller', replyTo: 1 }), change({ id: 3, kind: 'STATUS', oldValue: 'INBOX', newValue: 'TO_DO' })],
      cycles: [], cursor: '4.1', more: false };
    const live = await w.call('board_live', { project: 'p', settleMs: 0, timeoutSeconds: 1 });
    const { masked: _masked, maskedValues: _values, ...prefetch } = r.json;
    assert.deepEqual(live.json.cards[0], prefetch);
    assert.ok(liveHolder(w.fake.url), 'board_live is');
    beat(w.fake.url, 'p', true);

    const own = await w.call('board_live_card', { project: 'p', number: 1, changes: [{ kind: 'COMMENT', text: '**Reply** noted', actor: 'CLAUDE' }] });
    assert.match(own.json.nothing, /None of these changes is the user's/);
    const missing = await w.call('board_live_card', { project: 'p', number: 99, changes: [{ kind: 'COMMENT', text: 'hi' }] });
    assert.equal(missing.isError, true);
  } finally { await w.close(); }
});

test('a ▶ from the board: the chat takes the run (full prompt and note back), then ends it with its outcome; a cancelled run is not run', async () => {
  const w = await world();
  try {
    w.fake.board.skillQueue = [
      { id: 'run-1', project: 'p', cycleId: 'cy', cardNumber: 35, command: '/alfred-fix 35', prompt: '/alfred-fix 35\nAlfred: http://x', note: 'only the SQL', state: 'SENT' },
      { id: 'run-2', project: 'p', cycleId: 'cy', cardNumber: 36, command: '/alfred-fix 36', prompt: '/alfred-fix 36', state: 'CANCELLED' },
    ];
    const taken = await w.call('board_run_take', { id: 'run-1' });
    assert.equal(taken.json.command, '/alfred-fix 35');
    assert.equal(taken.json.prompt, '/alfred-fix 35\nAlfred: http://x');
    assert.equal(taken.json.note, 'only the SQL');
    const ended = await w.call('board_run_end', { id: 'run-1', outcome: '→ plan posted on #35', result: '#35 [4]' });
    assert.equal(ended.json.state, 'DONE');
    assert.deepEqual(w.fake.board.skillReports!['run-1'].map((r: any) => r.state), ['RUNNING', 'DONE']);
    assert.equal(w.fake.board.skillReports!['run-1'][1].result, '#35 [4]');

    w.fake.board.skillReports!['run-2'] = [];
    const cancelled = await w.call('board_run_take', { id: 'run-2' });
    assert.equal(cancelled.json.cancelled, true);
  } finally { await w.close(); }
});
