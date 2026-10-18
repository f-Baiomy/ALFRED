import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemOfRef } from '../src/board-ref.ts';
import { world } from './harness.ts';

const FILTERS = { id: '261e0010-aaaa-bbbb-cccc-000000000001', project: 'odeysys', name: '#61813_Refunded Requests Filters', isDefault: false, state: 'OPEN',
  migratedFrom: null };
const EXPORT = { id: 'b-export', project: 'odeysys', name: 'Export refunds', isDefault: false, state: 'OPEN', migratedFrom: null };
const EXPORT2 = { id: 'b-export2', project: 'odeysys', name: 'Export refunds v2', isDefault: false, state: 'OPEN', migratedFrom: null };
const SUMMARIES = [
  { board: FILTERS, cards: 12, cycleIds: ['cy-1'], boardIds: [], linkedItem: 'c1/61813' },
  { board: EXPORT, cards: 0, cycleIds: [], boardIds: [], linkedItem: null },
  { board: EXPORT2, cards: 0, cycleIds: [], boardIds: [], linkedItem: null },
];

/** /board/boards (the list and one by id) and a cycle on no board. */
function boards(method: string, p: string[]): [number, unknown?] | undefined {
  if (method === 'GET' && p[1] === 'boards' && p.length === 2) return [200, SUMMARIES];
  if (method === 'GET' && p[1] === 'boards' && p.length === 3) {
    const b = SUMMARIES.find((s) => s.board.id === p[2]);
    return b ? [200, b] : [404];
  }
  if (method === 'GET' && p[1] === 'cycles' && p[3] === 'boards') return [200, p[2] === 'cy-1' ? [FILTERS] : []];
  if (method === 'GET' && p[1] === 'boards' && p[3] === 'stage') {
    return [200, { stage: 'DEFINE', next: '/alfred-setup AB#61813 - Claude reads the task', ref: 'AB#61813', counts: {},
      step: { kind: 'CLAUDE', skill: 'alfred-setup', command: '/alfred-setup AB#61813', count: 0 } }];
  }
  return undefined;
}

test('a ref names a work item as AB#, conn/id or its URL', () => {
  assert.deepEqual(itemOfRef('AB#61813'), { conn: null, id: '61813' });
  assert.deepEqual(itemOfRef('c1/61813'), { conn: 'c1', id: '61813' });
  assert.deepEqual(itemOfRef('https://dev.azure.com/x/p/_workitems/edit/61813'), { conn: null, id: '61813' });
  assert.equal(itemOfRef('#61813_Refunded'), null);
});

test('task_context takes a board by id, AB#, name or prefix - and a cycle on a board loads the board (specs/030)', async () => {
  const w = await world();
  try {
    w.fake.board.extra = boards;
    for (const ref of [FILTERS.id, 'AB#61813', '#61813_Refunded Requests Filters', '#61813_refunded', 'cy-1']) {
      if (ref === 'cy-1') w.fake.addCycle({ id: 'cy-1', name: 'retest one', status: 'PAUSED', createdAt: '2026-10-01T00:00:00Z' });
      const r = await w.call('task_context', { task: ref });
      assert.match(r.text, /TASK "#61813_Refunded Requests Filters" \(board 261e0010-aaaa-bbbb-cccc-000000000001 · AB#61813 · cycles: cy-1\) · project odeysys/,
        `${ref}: ${r.text.slice(0, 300)}`);
      assert.match(r.text, /STAGE: DEFINE \(Board → Define[^\n]*\nNEXT: \/alfred-setup AB#61813/);
      assert.match(r.text, /\nSTEP: CLAUDE \/alfred-setup AB#61813\n/);
    }
  } finally { await w.close(); }
});

test('a bare #n is a card number; an item with no board says how to make one; two names ask which', async () => {
  const w = await world();
  try {
    w.fake.board.extra = boards;
    const card = await w.call('task_context', { task: '#60' });
    assert.match(card.text, /#60.{0,3} is a card number, not a board/);
    const none = await w.call('task_context', { task: 'AB#999' });
    assert.match(none.text, /No board has AB#999 as its main item - make one from the item in the Team tab/);
    const two = await w.call('task_context', { task: 'export ref' });
    assert.match(two.text, /export ref.{0,3} matches 2 boards - ask the user which: b-export /);
  } finally { await w.close(); }
});

test('the board param of a task tool takes AB# and a name', async () => {
  const w = await world();
  try {
    w.fake.board.extra = boards;
    await w.call('get_brief', { board: 'AB#61813' });
    assert.ok(w.fake.requests('GET', `/board/cycles/${FILTERS.id}/brief`).length >= 1);
    await w.call('get_brief', { cycleId: 'Export refunds v2' });
    assert.ok(w.fake.requests('GET', '/board/cycles/b-export2/brief').length >= 1);
  } finally { await w.close(); }
});

test('check_calls takes a board as its cycle: the board recording cycle; a board with no cycle says how to start one (specs/030)', async () => {
  const w = await world();
  try {
    w.fake.board.extra = boards;
    w.fake.addCycle({ id: 'cy-1', name: 'retest one', status: 'PAUSED', createdAt: '2026-10-01T00:00:00Z' });
    const r = await w.call('check_calls', { cycle: 'AB#61813' });
    assert.ok(!r.isError, r.text.slice(0, 300));
    assert.match(r.text, /retest one|cy-1/);
    const none = await w.call('check_calls', { cycle: 'Export refunds v2' });
    assert.ok(none.isError);
    assert.match(none.text, /has no cycle yet - board_record starts one/);
  } finally { await w.close(); }
});
