import assert from 'node:assert/strict';
import { test } from 'node:test';
import { respondTo } from '../src/tools/live.ts';
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
