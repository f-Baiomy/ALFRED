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
    w.fake.board.verify = [{ number: 1, title: 'Orders 500', signature: '5xx|POST /orders', verdict: 'LOOKS_FIXED', calls: [{ ref: 'in:r1@cy', label: 'POST /orders · 201', signal: 'ok' }] }];
    const verified = await w.call('board_verify', { project: 'p', cycleId: 'cy', apply: true });
    assert.equal(verified.isError, false, verified.text);
    assert.deepEqual(verified.json.applied, ['#1 proposed Verified']);
    assert.match(w.fake.requests('PUT', '/board/cards/card-1/proposal')[0].body.evidence, /@\[call:in:r1@cy\|POST \/orders · 201\]/);
  } finally { await w.close(); }
});
