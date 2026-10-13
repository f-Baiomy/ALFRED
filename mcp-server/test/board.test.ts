import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sectionOf } from '../src/tools/board.ts';
import { world } from './harness.ts';

test('board_add posts as Claude with the links, and reports the Inbox card', async () => {
  const w = await world();
  try {
    const r = await w.call('board_add', {
      project: 'odeysys', kind: 'BUG', title: 'Discount not saved', description: 'see @[call:in:a1|POST /orders · 201]',
      links: [{ type: 'call', ref: 'in:a1', label: 'POST /orders · 201' }],
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.added, '#1');
    assert.equal(r.json.status, 'INBOX');
    const sent = w.fake.requests('POST', '/board/cards')[0];
    assert.equal(sent.headers?.['x-alfred-actor'], 'claude');
    assert.deepEqual(sent.body.links, [{ type: 'call', ref: 'in:a1', label: 'POST /orders · 201' }]);
  } finally { await w.close(); }
});

test('a refusal from the backend reaches Claude word for word (a dismissed duplicate, a paused board)', async () => {
  const w = await world();
  try {
    w.fake.board.refuseCreate = [409, { error: 'duplicate-of-closed', message: 'Same as #3 "401 on health", closed as Fine - not an issue: expected' }];
    const r = await w.call('board_add', { project: 'p', kind: 'BUG', title: '401 again' });
    assert.equal(r.isError, true);
    assert.match(r.json.message, /Same as #3 "401 on health", closed as Fine - not an issue: expected$/);
  } finally { await w.close(); }
});

test('board_comment sends did / found / next / impact as Claude to the numbered card', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const r = await w.call('board_comment', { project: 'p', number: 1, did: 'read', found: 'NULL', next: 'rerun', impact: 'shared' });
    assert.equal(r.isError, false, r.text);
    const sent = w.fake.requests('POST', '/board/cards/card-1/comments')[0];
    assert.deepEqual(sent.body, { did: 'read', found: 'NULL', next: 'rerun', impact: 'shared' });
    assert.equal(sent.headers?.['x-alfred-actor'], 'claude');
  } finally { await w.close(); }
});

test('board_move offers only To do / In progress / Fixed', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const moved = await w.call('board_move', { project: 'p', number: 1, status: 'FIXED' });
    assert.equal(moved.isError, false, moved.text);
    const done = await w.call('board_move', { project: 'p', number: 1, status: 'DONE' });
    assert.equal(done.isError, true);
    assert.equal(w.fake.requests('POST', '/move').length, 1);
  } finally { await w.close(); }
});

test('board_get reads the card, its links and its whole history', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x', description: 'desc', links: [{ type: 'cycle', ref: 'c1', label: 'flow' }] });
    await w.call('board_comment', { project: 'p', number: 1, did: 'a', found: 'b', next: 'c' });
    const r = await w.call('board_get', { project: 'p', number: 1 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.card, /#1 BUG x - INBOX/);
    assert.deepEqual(r.json.links, ['cycle c1 - flow']);
    assert.equal(r.json.historyTotal, 1);
    assert.match(r.json.history[0], /^\[0\] .*Claude: \*\*Did\*\* a\n\n\*\*Found\*\* b\n\n\*\*Next\*\* c$/);
    assert.deepEqual(r.json.mentions, ['cycle c1 - flow → get_cycle {"cycleId":"c1"}']);
  } finally { await w.close(); }
});

test('board_closed_reasons lists what the user dismissed', async () => {
  const w = await world();
  try {
    w.fake.board.closedReasons = [{ number: 3, title: '401 on health', signature: '4xx|GET /health', resolution: 'FINE', reason: 'expected' }];
    const r = await w.call('board_closed_reasons', { project: 'p' });
    assert.deepEqual(r.json.closed, ['#3 401 on health - FINE: expected [4xx|GET /health]']);
  } finally { await w.close(); }
});

test('board_closed_reasons pages a long list with a nextOffset instead of failing over the reply budget', async () => {
  const w = await world();
  try {
    w.fake.board.closedReasons = Array.from({ length: 150 }, (_, i) => ({ number: i + 1, title: `Closed card ${i}`, signature: `4xx|GET /health/${i}`,
      resolution: 'FINE', reason: `expected ${'because it is the health probe '.repeat(8)}${i}` }));
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const r = await w.call('board_closed_reasons', { project: 'p', offset });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.json.total, 150);
      assert.ok(r.text.length <= 16_000);
      seen.push(...r.json.closed);
      pages++;
      if (r.json.nextOffset === undefined) break;
      assert.ok(r.json.nextOffset > offset, 'every page moves on');
      offset = r.json.nextOffset;
    }
    assert.ok(pages > 1, 'the list does not fit one reply');
    assert.equal(seen.length, 150);
    assert.equal(new Set(seen).size, 150, 'no card twice');
    assert.match(seen[0], /^#1 Closed card 0 - FINE: expected /);
    assert.match(seen[149], /^#150 Closed card 149 /);
    assert.equal(w.fake.requests('GET', '/board/closed-reasons')[0].query.get('limit'), '500', 'the backend has no offset: it is asked for all it answers');

    const small = await w.call('board_closed_reasons', { project: 'p', limit: 10, offset: 20 });
    assert.equal(small.json.closed.length, 10);
    assert.match(small.json.closed[0], /^#21 /);
    assert.equal(small.json.nextOffset, 30);
  } finally { await w.close(); }
});

test('board_closed_reasons says when Alfred answered its most', async () => {
  const w = await world();
  try {
    w.fake.board.closedReasons = Array.from({ length: 500 }, (_, i) => ({ number: i + 1, title: `c${i}`, signature: null, resolution: 'FINE', reason: null }));
    const r = await w.call('board_closed_reasons', { project: 'p', limit: 500 });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.note, /at most 500 closed cards/);
  } finally { await w.close(); }
});

test('board_list shows the calls among a card\'s first mentions, shortened', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Fare lost' });
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'No calls' });
    w.fake.board.cards[0].mentionChips = [
      { type: 'call', ref: 'in:3f2a9c1d-aaaa-bbbb-cccc-111122223333', label: 'POST /orders · 500' },
      { type: 'spec', ref: 'cy/spec.md', label: 'spec' },
      { type: 'CALL', ref: 'out:7b81e0aa-1111-2222-3333-444455556666@cy', label: 'GET /x' },
      { type: 'call', ref: 'in:3f2a9c1d-aaaa-bbbb-cccc-111122223333', label: 'again' },
    ];
    w.fake.board.cards[1].mentionChips = [{ type: 'stmt', ref: 'a1/3', label: 'INSERT' }];
    const r = await w.call('board_list', { project: 'p' });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.cards[0], /^#1 BUG Fare lost - INBOX.* · calls: in:3f2a9c1d… out:7b81e0aa…$/);
    assert.doesNotMatch(r.json.cards[1], /calls:/);
  } finally { await w.close(); }
});

test('get_brief and read_spec read the cycle\'s brief, spec text, one section and the checklist marks', async () => {
  const w = await world();
  try {
    w.fake.board.briefs['c1'] = { text: 'ODY-482', updatedAt: null };
    w.fake.board.specs['c1'] = { 'spec.md': '# ODY\n## Acceptance\n1. 201\n## Out of scope\n- x' };
    w.fake.board.checklist['c1'] = [{ fileName: 'spec.md', items: [{ key: 'i1', text: '201', mark: { mark: 'PASS', evidence: '' } }] }];
    const brief = await w.call('get_brief', { cycleId: 'c1' });
    assert.equal(brief.json.brief, 'ODY-482');
    assert.deepEqual(brief.json.specFiles, ['spec.md (46 bytes)']);
    const spec = await w.call('read_spec', { cycleId: 'c1', name: 'spec.md', section: 'acceptance' });
    assert.equal(spec.isError, false, spec.text);
    assert.equal(spec.json.spec.text, '## Acceptance\n1. 201');
    assert.deepEqual(spec.json.checklist, ['[i1] PASS - 201']);
  } finally { await w.close(); }
});

test('board_status says when the user paused Claude', async () => {
  const w = await world();
  try {
    w.fake.board.agentState = 'PAUSED';
    const r = await w.call('board_status', { project: 'p', cycleId: 'c1', callsChecked: 4, cardsAdded: 1 });
    assert.equal(r.json.paused, true);
    assert.equal(w.fake.requests('PUT', '/board/agent-status')[0].headers?.['x-alfred-actor'], 'claude');
  } finally { await w.close(); }
});

test('sectionOf keeps the heading and stops at the next one of the same level', () => {
  assert.equal(sectionOf('## A\nx\n### A1\ny\n## B\nz', 'a'), '## A\nx\n### A1\ny');
  assert.equal(sectionOf('no headings', 'a'), 'no headings');
});

test('board_add sends the card teams, and board_list shows them', async () => {
  const w = await world();
  try {
    const r = await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Upsell 405', teams: ['backend', 'frontend'] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(w.fake.requests('POST', '/board/cards')[0].body.teams, ['backend', 'frontend']);
    assert.match(r.json.card, /\{backend, frontend\} Upsell 405/);
    const none = await w.call('board_add', { project: 'p', kind: 'TASK', title: 'No team' });
    assert.match(none.json.teams, /board_assign/);
  } finally { await w.close(); }
});

test('board_teams lists what each team owns, and board_assign sets teams as Claude with the reason', async () => {
  const w = await world();
  try {
    const teams = await w.call('board_teams', {});
    assert.equal(teams.isError, false, teams.text);
    assert.match(teams.json.teams[1], /^backend: ⚙ Backend - owns: The Java services/);

    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const r = await w.call('board_assign', { project: 'p', number: 1, teams: ['database'], reason: 'The INSERT fails' });
    assert.equal(r.isError, false, r.text);
    const sent = w.fake.requests('PUT', '/board/cards/card-1/teams')[0];
    assert.deepEqual(sent.body, { teams: ['database'], reason: 'The INSERT fails' });
    assert.equal(sent.headers?.['x-alfred-actor'], 'claude');
    const missing = await w.call('board_assign', { project: 'p', number: 1, teams: ['qa'] });
    assert.equal(missing.isError, true);
  } finally { await w.close(); }
});
