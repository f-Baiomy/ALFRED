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
    assert.match(r.json.history[0], /Claude: \*\*Did\*\* a/);
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

test('get_brief and read_spec read the cycle\'s brief, spec text, one section and the checklist marks', async () => {
  const w = await world();
  try {
    w.fake.board.briefs['c1'] = { text: 'ODY-482', updatedAt: null };
    w.fake.board.specs['c1'] = { 'spec.md': '# ODY\n## Acceptance\n1. 201\n## Out of scope\n- x' };
    w.fake.board.checklist['c1'] = [{ fileName: 'spec.md', items: [{ text: '201', mark: { mark: 'PASS', evidence: '' } }] }];
    const brief = await w.call('get_brief', { cycleId: 'c1' });
    assert.equal(brief.json.brief, 'ODY-482');
    assert.deepEqual(brief.json.specFiles, ['spec.md (46 bytes)']);
    const spec = await w.call('read_spec', { cycleId: 'c1', name: 'spec.md', section: 'acceptance' });
    assert.equal(spec.isError, false, spec.text);
    assert.equal(spec.json.spec.text, '## Acceptance\n1. 201');
    assert.deepEqual(spec.json.checklist, ['PASS - 201']);
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
