import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWith } from '../src/tools/board.ts';
import { IN2 } from './fixtures.ts';
import { world } from './harness.ts';

/** The board tools Claude works with from anywhere: complete reading, search, changes and waits, replies, fixes, proposals. */

test('board_get gives every comment in full and reads a very long one in parts', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const long = 'L'.repeat(9000);
    await w.call('board_comment', { project: 'p', number: 1, did: 'short', found: 'b', next: 'c' });
    await w.call('board_comment', { project: 'p', number: 1, did: long, found: 'b', next: 'c' });
    const r = await w.call('board_get', { project: 'p', number: 1 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.history[0], /\*\*Next\*\* c$/);
    assert.match(r.json.history[1], /read the rest with board_get entry=1\)/);
    const part = await w.call('board_get', { project: 'p', number: 1, entry: 1 });
    assert.equal(part.json.text.totalLength, long.length + '**Did** \n\n**Found** b\n\n**Next** c'.length);
    assert.ok(part.json.text.text.includes(long));
  } finally { await w.close(); }
});

test('board_get pages a long history instead of cutting it', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.activity['card-1'] = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, actor: 'USER', kind: 'COMMENT', text: `note ${i} ${'n'.repeat(400)}`,
      oldValue: null, newValue: null, at: '2026-10-10T09:00:00Z' }));
    const first = await w.call('board_get', { project: 'p', number: 1 });
    assert.equal(first.json.historyTotal, 60);
    assert.ok(first.json.nextHistoryOffset > 0 && first.json.nextHistoryOffset < 60);
    const second = await w.call('board_get', { project: 'p', number: 1, historyOffset: first.json.nextHistoryOffset });
    assert.match(second.json.history[0], new RegExp(`^\\[${first.json.nextHistoryOffset}\\] .*note ${first.json.nextHistoryOffset} `));
  } finally { await w.close(); }
});

test('every mention says which tool opens it', () => {
  assert.equal(openWith('call', 'in:a1@cy'), 'investigate_call {"callId":"a1","cycleId":"cy"}');
  assert.equal(openWith('call', 'out:b2'), 'get_call {"callId":"b2","source":"external"}');
  assert.equal(openWith('spec', 'cy/spec.md#acceptance'), 'read_spec {"cycleId":"cy","name":"spec.md","section":"acceptance"}');
  assert.equal(openWith('card', 'odeysys#12'), 'board_get {"project":"odeysys","number":12}');
  assert.match(openWith('stmt', 'a1/88'), /^db_statements \{"callId":"a1"\} \(statement seq 88\)$/);
});

test('board_evidence opens the calls a card mentions, and says when one is gone', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Fare fails',
      description: `see @[call:in:${IN2}|POST /fare-confirmation · 500] and @[call:in:gone-1|GET /x · 200]` });
    const r = await w.call('board_evidence', { project: 'p', number: 1 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.total, 2);
    assert.match(r.json.evidence[0].call, /fare-confirmation → 500/);
    assert.match(r.json.evidence[0].open, /^investigate_call/);
    assert.equal(r.json.evidence[1].found, false);
  } finally { await w.close(); }
});

test('board_search looks across every board, with the latest comment of each card', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'shop', kind: 'BUG', title: 'Discount lost' });
    await w.call('board_add', { project: 'admin', kind: 'TASK', title: 'Login loops' });
    await w.call('board_comment', { project: 'shop', number: 1, did: 'traced it', found: 'cache', next: 'fix' });
    const r = await w.call('board_search', { mine: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.total, 2);
    const shop = r.json.cards.find((c: any) => c.project === 'shop');
    assert.match(shop.lastComment, /\*\*Did\*\* traced it/);
    const sent = w.fake.requests('GET', '/board/search')[0];
    assert.equal(sent.query.get('project'), null);
    assert.equal(sent.query.get('claudeTouched'), 'true');
  } finally { await w.close(); }
});

test('board_changes and board_wait show what the user did with its card, and hand back the cursor', async () => {
  const w = await world();
  try {
    w.fake.board.changes = {
      entries: [{ id: 7, actor: 'USER', kind: 'COMMENT', text: 'please check B too', oldValue: null, newValue: null, at: '2026-10-10T09:05:00Z',
        project: 'p', number: 3, title: 'Login loops', status: 'TO_DO', cycleId: null }],
      cycles: [{ cycleId: 'cy', what: 'spec', name: 'spec.md', detail: null, at: '2026-10-10T09:06:00Z' }],
      cursor: '7.1791650000000', more: false,
    };
    const changes = await w.call('board_changes', {});
    assert.equal(changes.isError, false, changes.text);
    assert.deepEqual(changes.json.changes, ['p #3 "Login loops" (TO_DO) - 2026-10-10T09:05:00Z User: please check B too']);
    assert.deepEqual(changes.json.cycleChanges, ['2026-10-10T09:06:00Z cycle cy: spec spec.md']);
    assert.equal(changes.json.cursor, '7.1791650000000');
    assert.equal(w.fake.requests('GET', '/board/changes')[0].query.get('cursor'), 'claude');

    const waited = await w.call('board_wait', { cursor: '6.0', timeoutSeconds: 5 });
    assert.equal(waited.isError, false, waited.text);
    const sent = w.fake.requests('GET', '/board/changes/wait')[0];
    assert.equal(sent.query.get('actor'), 'USER');
    assert.equal(sent.query.get('timeoutSeconds'), '5');
  } finally { await w.close(); }
});

test('board_reply and board_ask write as Claude; a question flags the card', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    await w.call('board_reply', { project: 'p', number: 1, text: 'It is the cache.' });
    const asked = await w.call('board_ask', { project: 'p', number: 1, question: 'Stack vouchers?' });
    assert.equal(asked.json.flagged, 'NEEDS_DECISION');
    const sent = w.fake.requests('POST', '/board/cards/card-1/comments');
    assert.deepEqual(sent.map((r) => r.body), [{ reply: 'It is the cache.' }, { question: 'Stack vouchers?' }]);
    assert.ok(sent.every((r) => r.headers?.['x-alfred-actor'] === 'claude'));
  } finally { await w.close(); }
});

test('board_fix records the change with code mentions and moves the card to Fixed', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.cards[0].status = 'IN_PROGRESS';
    const r = await w.call('board_fix', {
      project: 'p', number: 1, summary: 'Saved the discount', rootCause: 'the mapper skipped it',
      files: [{ path: 'src/main/java/OrderMapper.java', line: 142, note: 'map discount' }], commit: 'abc123', tests: 'OrderMapperTest passes',
      verify: 'POST /orders stores ORDERS.discount', impact: 'Every order save',
    });
    assert.equal(r.isError, false, r.text);
    const body = w.fake.requests('POST', '/board/cards/card-1/comments')[0].body;
    assert.match(body.did, /@\[code:src\/main\/java\/OrderMapper.java:142\|OrderMapper.java:142\] map discount/);
    assert.match(body.did, /Commit: abc123/);
    assert.equal(body.next, 'Verify: POST /orders stores ORDERS.discount');
    assert.equal(w.fake.requests('POST', '/board/cards/card-1/move')[0].body.status, 'FIXED');
  } finally { await w.close(); }
});

test('board_fix on an Inbox card records the fix but leaves sorting to the user', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const r = await w.call('board_fix', { project: 'p', number: 1, summary: 's', rootCause: 'r', verify: 'v' });
    assert.match(r.json.moved, /still in the Inbox/);
    assert.equal(w.fake.requests('POST', '/move').length, 0);
  } finally { await w.close(); }
});

test('board_propose, board_suggest_mark, board_link and board_edit go to the backend as Claude', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.cards[0].status = 'FIXED';
    const proposed = await w.call('board_propose', { project: 'p', number: 1, status: 'VERIFIED', reason: 'retest ok', evidence: '@[call:in:r1@cy|POST /orders · 201]' });
    assert.match(proposed.json.proposed, /proposed VERIFIED - waiting for the user/);
    const needsResolution = await w.call('board_propose', { project: 'p', number: 1, status: 'CLOSED' });
    assert.equal(needsResolution.isError, true);
    const mark = await w.call('board_suggest_mark', { cycleId: 'cy', fileName: 'spec.md', itemKey: 'i1', mark: 'PASS', evidence: 'ok' });
    assert.equal(mark.isError, false, mark.text);
    assert.deepEqual(w.fake.board.suggestions['cy/spec.md/i1'], { mark: 'PASS', evidence: 'ok' });
    await w.call('board_link', { project: 'p', number: 1, links: [{ type: 'call', ref: 'in:a1', label: 'GET /a · 200' }] });
    assert.equal(w.fake.requests('POST', '/board/cards/card-1/links').length, 1);
    await w.call('board_edit', { project: 'p', number: 1, title: 'better' });
    const patch = w.fake.requests('PATCH', '/board/cards/card-1')[0];
    assert.equal(patch.body.title, 'better');
    assert.ok([proposed, mark].length && w.fake.requests('PUT', '/proposal')[0].headers?.['x-alfred-actor'] === 'claude');
  } finally { await w.close(); }
});

test('board_for_call, board_similar and board_verify report what the backend found', async () => {
  const w = await world();
  try {
    w.fake.board.badges = { a1: [{ project: 'p', number: 4, kind: 'BUG', status: 'TO_DO', resolution: null, title: 'Orders 500' }] };
    const forCall = await w.call('board_for_call', { callIds: ['a1', 'b2'] });
    assert.deepEqual(forCall.json.calls, [{ callId: 'a1', cards: ['p #4 BUG Orders 500 - TO_DO'] }, { callId: 'b2', cards: [] }]);

    w.fake.board.similar = [{ why: 'same signature 5xx|POST /orders', card: { id: 'k', project: 'p', number: 4, kind: 'BUG', title: 'Orders 500', status: 'CLOSED',
      resolution: 'FINE', reason: 'expected', flags: [], scope: 'NOT_DECIDED', author: 'USER', cycleId: null, cycleDeleted: false, updatedAt: '', commentCount: 0, similarClosed: null } }];
    const similar = await w.call('board_similar', { call: 'in:a1' });
    assert.deepEqual(similar.json.similar, ['p #4 BUG Orders 500 - CLOSED (FINE: expected) - same signature 5xx|POST /orders']);

    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Orders 500' });
    w.fake.board.cards[0].status = 'FIXED';
    w.fake.board.retest = [{ number: 1, title: 'Orders 500', status: 'FIXED', verdict: 'PASSES', statusOnly: false, newBuild: false,
      summary: 'passes · 1 call since the fix', results: [{ text: 'Status !5xx', outcome: 'PASS', before: '500', after: ['201'], note: null }],
      calls: [{ ref: 'in:r1@cy', label: 'POST /orders · 201', passed: true, failed: null }], steps: [] }];
    const verified = await w.call('board_verify', { project: 'p', cycleId: 'cy', apply: true });
    assert.equal(verified.isError, false, verified.text);
    assert.deepEqual(verified.json.applied, ['#1 proposed Verified']);
    assert.equal(verified.json.report, '## Re-test p');
    assert.match(verified.json.checks[0].results[0], /^PASS Status !5xx · before 500 · now 201$/);
    assert.match(w.fake.requests('PUT', '/board/cards/card-1/proposal')[0].body.evidence, /@\[call:in:r1@cy\|POST \/orders · 201\]/);
  } finally { await w.close(); }
});

test('board_get shows threads and the questions the user has not answered yet', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'QUESTION', title: 'x' });
    w.fake.board.activity['card-1'] = [
      { id: 10, cardId: 'card-1', actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** Stack vouchers?', oldValue: null, newValue: null, at: 't1', replyTo: null },
      { id: 11, cardId: 'card-1', actor: 'USER', kind: 'COMMENT', text: 'No', oldValue: null, newValue: null, at: 't2', replyTo: 10 },
      { id: 12, cardId: 'card-1', actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** Name the branch?', oldValue: null, newValue: null, at: 't3', replyTo: null },
    ];
    const r = await w.call('board_get', { project: 'p', number: 1 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.history[0], /\(question - answered\)$/);
    assert.match(r.json.history[1], /^\[1\] ↳ reply to \[0\] t2 User: No$/);
    assert.match(r.json.history[2], /OPEN, waiting for the user/);
    assert.deepEqual(r.json.openQuestions, [2]);
  } finally { await w.close(); }
});

test('board_reply and board_comment answer one exact comment by its [index]', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.activity['card-1'] = [
      { id: 7, cardId: 'card-1', actor: 'USER', kind: 'CREATED', text: null, oldValue: null, newValue: 'INBOX', at: 't0', replyTo: null },
      { id: 8, cardId: 'card-1', actor: 'USER', kind: 'COMMENT', text: 'please check B too', oldValue: null, newValue: null, at: 't1', replyTo: null },
    ];
    const r = await w.call('board_reply', { project: 'p', number: 1, text: 'Checked B - same cause.', replyTo: 1 });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(w.fake.requests('POST', '/board/cards/card-1/comments')[0].body, { reply: 'Checked B - same cause.', replyTo: 8 });
    const notAComment = await w.call('board_reply', { project: 'p', number: 1, text: 'x', replyTo: 0 });
    assert.equal(notAComment.isError, true);
    assert.match(notAComment.json.message, /not a comment/);
    await w.call('board_comment', { project: 'p', number: 1, did: 'd', found: 'f', next: 'n', replyTo: 1 });
    assert.equal(w.fake.requests('POST', '/board/cards/card-1/comments').at(-1)!.body.replyTo, 8);
  } finally { await w.close(); }
});

test('board_changes says when the user answered your question', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'QUESTION', title: 'Vouchers' });
    w.fake.board.activity['card-1'] = [
      { id: 20, cardId: 'card-1', actor: 'CLAUDE', kind: 'COMMENT', text: '**Question** Stack vouchers?', oldValue: null, newValue: null, at: 't1', replyTo: null },
    ];
    w.fake.board.changes = {
      entries: [{ id: 21, cardId: 'card-1', actor: 'USER', kind: 'COMMENT', text: 'No, never', oldValue: null, newValue: null, at: 't2', replyTo: 20,
        project: 'p', number: 1, title: 'Vouchers', status: 'INBOX', cycleId: null }],
      cycles: [], cursor: '21.0', more: false,
    };
    const r = await w.call('board_changes', {});
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.changes, ['p #1 "Vouchers" (INBOX) - ANSWERS your question "Stack vouchers?": t2 User: No, never']);
  } finally { await w.close(); }
});

test('board_fix writes the re-test plan, board_verify needs no cycle, board_retest shows one card', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'N+1' });
    w.fake.board.cards[0].status = 'TO_DO';
    const fixed = await w.call('board_fix', { project: 'p', number: 1, summary: 'BatchSize', rootCause: 'eager', verify: 'open the page',
      expect: [{ kind: 'SQL_COUNT', table: 'TT_MAP', max: 3 }], steps: [{ text: 'Open the flight search page' }] });
    assert.equal(fixed.isError, false, fixed.text);
    assert.equal(fixed.json.retestPlan, '1 expectations, 1 steps');
    const plan = w.fake.requests('PUT', '/board/cards/card-1/retest-plan')[0];
    assert.equal(plan.headers?.['x-alfred-actor'], 'claude');
    assert.deepEqual(plan.body.expectations, [{ kind: 'SQL_COUNT', table: 'TT_MAP', max: 3 }]);

    w.fake.board.retest = [{ number: 1, title: 'N+1', status: 'FIXED', verdict: 'NO_CALLS', statusOnly: false, newBuild: true,
      summary: 'no calls since the fix', results: [], calls: [], steps: [{ text: 'Open the flight search page', endpoint: 'POST /x', seen: false, calls: 0 }] }];
    const live = await w.call('board_verify', { project: 'p' });
    assert.equal(live.json.source, 'live calls since the fix');
    assert.match(live.json.checks[0].card, /NO_CALLS: no calls since the fix · new build since the fix/);
    assert.deepEqual(live.json.checks[0].steps, ['not done - Open the flight search page [POST /x]']);
    assert.equal(w.fake.requests('GET', '/board/retest').length, 1);

    const one = await w.call('board_retest', { project: 'p', number: 1 });
    assert.equal(one.isError, false, one.text);
    assert.equal(one.json.plan.expectations.length, 1);
  } finally { await w.close(); }
});

test('board_add_many writes each card\'s first state comment and its Acceptance item in the same call', async () => {
  const w = await world();
  try {
    const r = await w.call('board_add_many', { project: 'p', cycleId: 'cy', cards: [
      { kind: 'BUG', title: 'Second passenger dropped', firstComment: { did: 'checked 12 calls', found: 'OrderMapper maps one', next: 'triage', waitingOn: 'USER' },
        specItem: { fileName: 'spec.md', itemKey: 'k1' } },
      { kind: 'NOTE', title: 'N+1 airports' },
    ] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.results[0], /^added #1 Second passenger dropped - no team yet · commented · linked to k1$/);
    assert.match(r.json.results[1], /^added #2 N\+1 airports - no team yet$/);
    const comment = w.fake.requests('POST', '/board/cards/card-1/comments')[0];
    assert.equal(comment.body.did, 'checked 12 calls');
    assert.equal(comment.body.waitingOn, 'USER');
    assert.deepEqual(w.fake.requests('POST', '/board/cards/card-1/spec-items')[0].body, { cycleId: 'cy', fileName: 'spec.md', itemKey: 'k1' });
    assert.equal(w.fake.requests('POST', '/board/cards/card-2/comments').length, 0);
  } finally { await w.close(); }
});

test('board_ask with options writes a questions block; previews, then and follow-ups go with it (specs/019)', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    await w.call('board_reply', { project: 'p', number: 1, text: 'Plan below.' });
    const asked = await w.call('board_ask', { project: 'p', number: 1, about: 0, questions: [
      { header: 'Steps', question: 'Keep all the steps?', why: 'The cycle replays them', options: [
        { label: 'Keep all', then: 'I record every step', recommended: true, preview: '<p>Covers <b>A1</b></p>' },
        { label: 'Rewrite', followUp: { header: 'Plan', question: 'Which plan?', options: [{ label: 'Short' }, { label: 'Long' }] } },
      ] },
      { header: 'Checks', question: 'Which checks?', multiSelect: true, options: [{ label: 'SQL' }, { label: 'Status' }] },
    ] });
    assert.equal(asked.isError, false, asked.text);
    assert.equal(asked.json.questions, 2);
    const text: string = w.fake.requests('POST', '/board/cards/card-1/comments')[1].body.question;
    assert.match(text, /^Keep all the steps\?\n\n```questions\n/);
    const block = JSON.parse(/```questions\n([\s\S]*)\n```$/.exec(text)![1]);
    assert.equal(block.about, 1);
    assert.equal(block.questions[0].options[0].then, 'I record every step');
    assert.equal(block.questions[0].options[0].recommended, true);
    assert.match(block.questions[0].options[0].preview, /\*\*A1\*\*/);
    assert.equal(block.questions[0].options[1].followUp.header, 'Plan');
    assert.equal(block.questions[1].multiSelect, true);
  } finally { await w.close(); }
});

test('board_ask carries triage facts: confidence on the recommended option, checked, severity and group', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const asked = await w.call('board_ask', { project: 'p', number: 1, questions: [
      { header: 'Triage', question: 'What should happen to #1?', checked: '#6 same 409 · line 121 unchanged',
        severity: { rank: 1, of: 4, note: 'blocks AC6' }, group: [7, 9],
        options: [{ label: 'To do', recommended: true, confidence: 'high' }, { label: 'Fine' }, { label: 'Merge #7 #9 into #1' }] },
    ] });
    assert.equal(asked.isError, false, asked.text);
    const text: string = w.fake.requests('POST', '/board/cards/card-1/comments')[0].body.question;
    const q = JSON.parse(/```questions\n([\s\S]*)\n```$/.exec(text)![1]).questions[0];
    assert.equal(q.options[0].confidence, 'high');
    assert.equal(q.checked, '#6 same 409 · line 121 unchanged');
    assert.deepEqual(q.severity, { rank: 1, of: 4, note: 'blocks AC6' });
    assert.deepEqual(q.group, [7, 9]);

    const bad = [
      { header: 'T', question: 'a?', options: [{ label: 'A', recommended: true }, { label: 'B', confidence: 'low' }] },
      { header: 'T', question: 'a?', group: [1], options: [{ label: 'A' }, { label: 'B' }] },
      { header: 'T', question: 'a?', options: [{ label: 'A', recommended: true, confidence: 'sure' }, { label: 'B' }] },
    ];
    for (const b of bad) assert.equal((await w.call('board_ask', { project: 'p', number: 1, questions: [b] })).isError, true, JSON.stringify(b));
  } finally { await w.close(); }
});

test('board_ask refuses a repeated header, one option, two recommended, or both question and questions', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const opts = [{ label: 'A' }, { label: 'B' }];
    const bad = [
      { questions: [{ header: 'S', question: 'a?', options: opts }, { header: 's', question: 'b?', options: opts }] },
      { questions: [{ header: 'S', question: 'a?', options: [{ label: 'A' }] }] },
      { questions: [{ header: 'S', question: 'a?', options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] }] },
      { question: 'a?', questions: [{ header: 'S', question: 'a?', options: opts }] },
      {},
    ];
    for (const b of bad) assert.equal((await w.call('board_ask', { project: 'p', number: 1, ...b })).isError, true, JSON.stringify(b));
    assert.equal(w.fake.requests('POST', '/board/cards/card-1/comments').length, 0);
  } finally { await w.close(); }
});

test('board_ask says when the same question is already open; board_withdraw_question takes one back with why', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    await w.call('board_ask', { project: 'p', number: 1, question: 'Stack vouchers?' });
    w.fake.board.askedNote = 'Already asked: [1] asks the same and is still open';
    const again = await w.call('board_ask', { project: 'p', number: 1, question: 'Stack vouchers?' });
    assert.match(again.json.why, /Already asked/);
    assert.equal(again.json.asked, undefined);
    const r = await w.call('board_withdraw_question', { project: 'p', number: 1, entry: 0, reason: 'same as [688], answered' });
    assert.equal(r.isError, false, r.text);
    const sent = w.fake.requests('POST', '/board/cards/card-1/questions/1/withdraw')[0];
    assert.deepEqual(sent.body, { headers: [], reason: 'same as [688], answered' });
    assert.equal(sent.headers?.['x-alfred-actor'], 'claude');
    assert.equal((await w.call('board_withdraw_question', { project: 'p', number: 1, entry: 5, reason: 'x' })).isError, true);
  } finally { await w.close(); }
});

test('board_get shows each question\'s state and the answers whole, previews cut to a mark', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const list = (w.fake.board.activity['card-1'] ??= []);
    const q = 'Keep?\n\n```questions\n' + JSON.stringify({ questions: [
      { header: 'Steps', question: 'Keep?', options: [{ label: 'Keep', preview: 'x'.repeat(3000) }, { label: 'Rewrite', followUp: { header: 'Plan', question: 'Which?' } }] },
      { header: 'Checks', question: 'Which checks?' }] }, null, 2) + '\n```';
    list.push({ id: 1, cardId: 'card-1', actor: 'CLAUDE', kind: 'COMMENT', text: `**Question** ${q}`, oldValue: null, newValue: null, at: '2026-10-10T09:00:00Z', replyTo: null });
    list.push({ id: 2, cardId: 'card-1', actor: 'USER', kind: 'COMMENT', text: '**Answers** Steps: Keep (note: all of them)\n\n```answers\n{\n  "Steps": {"chose": ["Keep"], "note": "all of them"}\n}\n```',
      oldValue: null, newValue: null, at: '2026-10-10T09:01:00Z', replyTo: 1 });
    w.fake.board.questions = { 'card-1': [
      { entryId: 1, idx: 0, header: 'Steps', text: 'Keep?', state: 'ANSWERED', laterUntil: null, parentIdx: null, parentOption: null },
      { entryId: 1, idx: 1, header: 'Checks', text: 'Which checks?', state: 'OPEN', laterUntil: null, parentIdx: null, parentOption: null },
      { entryId: 1, idx: 2, header: 'Plan', text: 'Which?', state: 'DROPPED', laterUntil: null, parentIdx: 0, parentOption: 'Rewrite' },
    ] };
    const r = await w.call('board_get', { project: 'p', number: 1 });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.openQuestions, [0]);
    assert.match(r.json.history[0], /questions: Steps ANSWERED · Checks OPEN · Plan not needed \(Steps answered otherwise\)/);
    assert.match(r.json.history[0], /"preview":"\(3000 chars\)"/);
    assert.match(r.json.history[1], /answers: \{"Steps":\{"chose":\["Keep"\],"note":"all of them"\}\}/);
  } finally { await w.close(); }
});

test('board_ask on an Alfred without the questions index asks in words, options listed - never a raw block', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.questionsMissing = true;
    const r = await w.call('board_ask', { project: 'p', number: 1, questions: [
      { header: 'Triage', question: 'What should happen to #50?', options: [{ label: 'To do', then: 'I move it', recommended: true }, { label: 'Fine' }] }] });
    assert.equal(r.isError, false, r.text);
    const text: string = w.fake.requests('POST', '/board/cards/card-1/comments')[0].body.question;
    assert.doesNotMatch(text, /```questions/);
    assert.match(text, /\*\*1\. Triage\*\* - What should happen to #50\?/);
    assert.match(text, /a\) \*\*To do\*\* \(recommended\) → then I move it/);
  } finally { await w.close(); }
});

test('board_retest_plan sends what a step\'s call must carry and passes on the warning about an endpoint no call ever hit (specs/020)', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    w.fake.board.planWarnings = ['No recorded call ever hit POST /agency/by-branch - the step cannot tick until one does. Did you mean POST /Admin2/agency/by-branch (12 calls)? Saved as written.'];
    const r = await w.call('board_retest_plan', { project: 'p', number: 1, steps: [
      { text: 'All Branches, Search', endpoint: 'POST /Booking2/refunded-requests/search', request: [{ path: '$.branchIds', shape: 'has:-11' }] },
      { text: 'Open the agency list', endpoint: 'POST /agency/by-branch' }] });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.warnings[0], /Did you mean POST \/Admin2\/agency\/by-branch/);
    const sent = w.fake.requests('PUT', '/board/cards/card-1/retest-plan')[0].body;
    assert.deepEqual(sent.steps[0].request, [{ path: '$.branchIds', shape: 'has:-11' }]);
  } finally { await w.close(); }
});

test('board_verify says which calls ran before the fix build, why a step did not tick, and that every answer was empty (specs/020)', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Branch filter' });
    w.fake.board.retest = [{ number: 1, title: 'Branch filter', status: 'FIXED', verdict: 'PASSES', statusOnly: false, newBuild: false,
      summary: 'passes · 2 calls since the fix · every answer was empty (2 calls, 0 rows) - not seen working on data · 5 calls before the fix build not counted',
      results: [], beforeBuild: 5, emptyAnswers: 2,
      calls: [{ ref: 'in:a', label: 'POST /search · 200', passed: true, failed: null }, { ref: 'in:b', label: 'POST /search · 200', passed: true, failed: null }],
      steps: [{ text: 'All Branches, Search', endpoint: 'POST /search', seen: false, calls: 0, note: '2 calls to the endpoint, none sent what the step asks: branchIds has -11' }] }];
    const r = await w.call('board_verify', { project: 'p' });
    const c = r.json.checks[0];
    assert.match(c.beforeBuild, /5 calls before the app start that carries the fix/);
    assert.match(c.emptyAnswers, /never propose Verified on it/);
    assert.match(c.steps[0], /not done - All Branches, Search \[POST \/search\] \(2 calls to the endpoint, none sent what the step asks/);
  } finally { await w.close(); }
});
