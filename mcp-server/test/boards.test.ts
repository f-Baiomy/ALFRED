import assert from 'node:assert/strict';
import { test } from 'node:test';
import { world } from './harness.ts';

const REFUND = { id: 'b-refund', project: 'p', name: 'Refund', isDefault: false, state: 'OPEN', migratedFrom: null };
const SPRINT = { id: 'b-sprint', project: 'p', name: 'Sprint', isDefault: false, state: 'OPEN', migratedFrom: null };

/** A cycle "c-shared" on two boards; "c-one" on Refund only; a board id answers GET /board/boards/{id}. */
function boards(method: string, p: string[]): [number, unknown?] | undefined {
  if (method === 'GET' && p[1] === 'boards' && p.length === 3) {
    const b = [REFUND, SPRINT].find((x) => x.id === p[2]);
    return b ? [200, { board: b, cards: 0, cycleIds: [], boardIds: [], linkedItem: null }] : [404];
  }
  if (method === 'GET' && p[1] === 'cycles' && p[3] === 'boards') {
    return [200, p[2] === 'c-shared' ? [REFUND, SPRINT] : p[2] === 'c-one' ? [REFUND] : []];
  }
  return undefined;
}

test('a task tool given a cycle on several boards asks which board; board picks one', async () => {
  const w = await world();
  try {
    w.fake.board.extra = boards;
    const refused = await w.call('get_brief', { cycleId: 'c-shared' });
    assert.match(refused.json.message, /on 2 boards - pass board: one of b-refund \("Refund", p\); b-sprint/);

    await w.call('get_brief', { cycleId: 'c-one' });
    assert.ok(w.fake.requests('GET', '/board/cycles/b-refund/brief').length >= 1, 'the cycle resolves to its only board');
    assert.equal(w.fake.requests('GET', '/board/cycles/c-one/brief').length, 0);

    await w.call('get_brief', { cycleId: 'c-shared', board: 'b-sprint' });
    assert.ok(w.fake.requests('GET', '/board/cycles/b-sprint/brief').length >= 1);
    assert.equal(w.fake.requests('GET', '/board/cycles/c-shared/brief').length, 0);
  } finally { await w.close(); }
});

test('board_record answers RUNNING with the options when another cycle records the project', async () => {
  const w = await world();
  try {
    w.fake.board.extra = (method, p, q, body) => {
      if (method === 'POST' && p[1] === 'boards' && p[3] === 'record') {
        return body.onRunning === 'ASK'
          ? [409, { error: 'RECORDING_CONFLICT', message: '"rec 14 Oct" is recording p: join it or pause it and start a new one' }]
          : [200, { cycleId: 'c-run', message: 'joined "rec 14 Oct"' }];
      }
      return undefined;
    };
    const asked = await w.call('board_record', { board: 'b-sprint' });
    assert.equal(asked.json.result, 'RUNNING');
    assert.match(asked.json.note, /rec 14 Oct/);
    const joined = await w.call('board_record', { board: 'b-sprint', onRunning: 'JOIN' });
    assert.equal(joined.json.recording, 'c-run');
  } finally { await w.close(); }
});

test('board_open sends askedIn and board_relate unrelates a cycle', async () => {
  const w = await world();
  try {
    w.fake.board.extra = (method, p, q, body) => {
      if (method === 'POST' && p[1] === 'boards' && p.length === 2) return [201, { ...REFUND, name: body.name }];
      if (method === 'DELETE' && p[1] === 'boards' && p[3] === 'cycles') return [200, REFUND];
      return boards(method, p);
    };
    const opened = await w.call('board_open', { project: 'p', name: 'Refund', askedIn: 'terminal' });
    assert.equal(opened.isError, false, opened.text);
    assert.equal(w.fake.requests('POST', '/board/boards')[0].body.askedIn, 'terminal');

    const r = await w.call('board_relate', { board: 'b-refund', cycleId: 'c-one', remove: true });
    assert.equal(r.isError, false, r.text);
    assert.equal(w.fake.requests('DELETE', '/board/boards/b-refund/cycles/c-one').length, 1);
  } finally { await w.close(); }
});
