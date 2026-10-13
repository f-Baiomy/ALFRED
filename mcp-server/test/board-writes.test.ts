import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlfredClient, AlfredError } from '../src/alfred-client.ts';
import { tapFetch } from './fetch-tap.ts';
import { world } from './harness.ts';

/**
 * Writing to the board: the backend's error code reaches the tools (a paused board ends a batch by its code, never by a word in a
 * message), a create that timed out is looked up before it is called "not added", and the writes wait 30 s where a read waits 4.
 */

const PAUSED = [409, { error: 'paused', message: 'The board is paused - Claude adds no cards until the user resumes' }] as [number, unknown];
const THREE = ['First', 'Second', 'Third'].map((title) => ({ kind: 'BUG', title }));

const row = (over: Record<string, unknown>) => ({
  why: 'title shares passenger',
  card: { id: 'card-1', project: 'p', number: 1, kind: 'BUG', title: 'Second passenger lost', status: 'INBOX', author: 'CLAUDE', flags: [], teams: ['backend'],
    createdAt: new Date(Date.now() - 20_000).toISOString(), ...over },
});

/** The AlfredError a request ended in. */
const failure = (request: Promise<unknown>): Promise<AlfredError> => request.then(() => { throw new Error('the request should have failed'); }, (error) => error as AlfredError);

test('AlfredError keeps the backend\'s error code, and the message stays as it was', async () => {
  const w = await world();
  try {
    const client = new AlfredClient(w.fake.url);
    w.fake.board.refuseCreate = PAUSED;
    const paused = await failure(client.post('/board/cards', { body: { project: 'p', kind: 'BUG', title: 'x' } }));
    assert.ok(paused instanceof AlfredError);
    assert.equal(paused.kind, 'invalid');
    assert.equal(paused.status, 409);
    assert.equal(paused.code, 'paused');
    assert.equal(paused.message, 'Alfred rejected the request (409): The board is paused - Claude adds no cards until the user resumes');

    // A body without a message: its text is the message, and the code is still there.
    w.fake.board.refuseCreate = [400, { error: 'invalid' }];
    const bare = await failure(client.post('/board/cards', { body: {} }));
    assert.equal(bare.code, 'invalid');
    assert.equal(bare.message, 'Alfred rejected the request (400): {"error":"invalid"}');

    // Any other failure the backend explains carries its code too; a 404 is a not_found with none.
    w.fake.board.refuseCreate = [500, { error: 'internal', message: 'boom' }];
    const broken = await failure(client.post('/board/cards', { body: {} }));
    assert.equal(broken.kind, 'backend');
    assert.equal(broken.code, 'internal');
    assert.equal(broken.message, 'Alfred answered 500: boom');
    const missing = await failure(client.get('/board/cards/by-number/9', { query: { project: 'p' } }));
    assert.equal(missing.kind, 'not_found');
    assert.equal(missing.code, undefined);
  } finally { await w.close(); }
});

test('board_add_many stops at a paused board by its code and says the rest were not attempted', async () => {
  const w = await world();
  try {
    w.fake.board.refuseCreate = PAUSED;
    const r = await w.call('board_add_many', { project: 'p', cards: THREE });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.results.length, 3);
    assert.match(r.json.results[0], /^not added "First": Alfred rejected the request \(409\): The board is paused/);
    assert.equal(r.json.results[1], 'not attempted: board paused - "Second"');
    assert.equal(r.json.results[2], 'not attempted: board paused - "Third"');
    assert.equal(w.fake.requests('POST', '/board/cards').length, 1, 'no create was sent after the board said it is paused');

    // The code decides, not the words: a message that does not say "paused" still ends the batch.
    w.fake.board.refuseCreate = [409, { error: 'paused', message: 'Claude is on hold' }];
    const hold = await w.call('board_add_many', { project: 'p', cards: THREE });
    assert.equal(hold.json.results[1], 'not attempted: board paused - "Second"');
  } finally { await w.close(); }
});

test('board_add_many keeps going after a refusal that only mentions "paused" in its words', async () => {
  const w = await world();
  try {
    w.fake.board.refuseCreate = [409, { error: 'duplicate-of-closed', message: 'Same as #3 "Paused sessions are dropped", closed as Fine - not an issue: expected' }];
    const r = await w.call('board_add_many', { project: 'p', cards: THREE });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.results.length, 3);
    for (const line of r.json.results) assert.match(line, /^not added "(First|Second|Third)": .*closed as Fine/);
    assert.equal(w.fake.requests('POST', '/board/cards').length, 3, 'every card was tried');
  } finally { await w.close(); }
});

test('board_add_many: a create that timed out but was saved is reported as added, found by title and call on the board', async () => {
  const w = await world();
  const tap = tapFetch(w.fake.url, ({ method, path, body }) => (method === 'POST' && path === '/board/cards' && body?.title === 'Second passenger lost' ? { fail: 'after' } : undefined));
  try {
    w.fake.board.similar = [row({})];
    const r = await w.call('board_add_many', { project: 'p', cards: [
      { kind: 'BUG', title: 'Second passenger lost', links: [{ type: 'call', ref: 'in:a1', label: 'POST /orders · 500' }] },
      { kind: 'BUG', title: 'Avatar 404' },
    ] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.results[0], 'added #1 Second passenger lost {backend} · the create timed out, but the card is on the board');
    assert.match(r.json.results[1], /^added #2 Avatar 404 - no team yet$/);
    const look = w.fake.requests('GET', '/board/similar')[0];
    assert.equal(look.query.get('title'), 'Second passenger lost');
    assert.equal(look.query.get('call'), 'in:a1', 'the card\'s first call');
    assert.equal(look.query.get('project'), 'p');
    assert.equal(tap.timeoutOf('POST', '/board/cards'), 30_000);
  } finally { tap.restore(); await w.close(); }
});

test('board_add_many: a timed-out create the board does not have is "not added", the board was checked, and the batch goes on', async () => {
  const w = await world();
  const tap = tapFetch(w.fake.url, ({ method, path, body }) => (method === 'POST' && path === '/board/cards' && body?.title === 'First' ? { fail: 'before' } : undefined));
  try {
    const r = await w.call('board_add_many', { project: 'p', cards: THREE.slice(0, 2) });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.results[0], /^not added "First": Alfred is not reachable at .*no answer within 30 s.*\(checked the board: no card with this title was saved\)$/);
    assert.match(r.json.results[1], /^added #1 Second /);
    assert.equal(w.fake.requests('GET', '/board/similar').length, 1);
  } finally { tap.restore(); await w.close(); }
});

test('board_add_many: only a card of this project, by Claude, with this title and made in the last minute counts as the timed-out one', async () => {
  const w = await world();
  const tap = tapFetch(w.fake.url, ({ method, path }) => (method === 'POST' && path === '/board/cards' ? { fail: 'before' } : undefined));
  try {
    w.fake.board.similar = [
      row({ createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }), // too old
      row({ project: 'other' }), // another board
      row({ author: 'USER' }), // the user's
      row({ title: 'Second passenger lost too' }), // another title
    ];
    const r = await w.call('board_add_many', { project: 'p', cards: [{ kind: 'BUG', title: 'Second passenger lost' }] });
    assert.match(r.json.results[0], /^not added "Second passenger lost": .*\(checked the board: no card with this title was saved\)$/);
  } finally { tap.restore(); await w.close(); }
});

test('board_add_many: when Alfred does not answer the check either, the rest are not attempted', async () => {
  const w = await world();
  const tap = tapFetch(w.fake.url, ({ method, path }) => (method === 'POST' && path === '/board/cards') || path === '/board/similar' ? { fail: 'before' } : undefined);
  try {
    const r = await w.call('board_add_many', { project: 'p', cards: THREE });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.results[0], /^not added "First": .*\(could not check whether it was saved\)$/);
    assert.equal(r.json.results[1], 'not attempted: Alfred is not answering - "Second"');
    assert.equal(r.json.results[2], 'not attempted: Alfred is not answering - "Third"');
    assert.equal(w.fake.requests('POST', '/board/cards').length, 0, 'the fake never saw a create: they all timed out in flight');
  } finally { tap.restore(); await w.close(); }
});

test('a card another open card repeats says so: board_add_many in its result line, board_add beside the card', async () => {
  const w = await world();
  try {
    const plain = await w.call('board_add', { project: 'p', kind: 'BUG', title: 'No twin' });
    assert.equal(plain.json.similarOpen, undefined, 'a backend that sends no similarOpen changes nothing');

    w.fake.board.createExtra = { similarOpen: { number: 4, title: 'Second passenger lost', status: 'TO_DO' } };
    const note = 'same signature as open #4 "Second passenger lost" - link or board_propose MERGE';
    const one = await w.call('board_add', { project: 'p', kind: 'BUG', title: 'Passenger gone' });
    assert.equal(one.json.similarOpen, note);
    const many = await w.call('board_add_many', { project: 'p', cards: [{ kind: 'BUG', title: 'Passenger vanished' }] });
    assert.match(many.json.results[0], new RegExp(`^added #3 Passenger vanished - no team yet · ${note}$`));
  } finally { await w.close(); }
});

test('the writes wait 30 s - board_add, board_add_many (comment, spec item), board_comment, board_link - and the reads before them 4', async () => {
  const w = await world();
  const tap = tapFetch(w.fake.url);
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    assert.equal(tap.timeoutOf('POST', '/board/cards'), 30_000);

    await w.call('board_comment', { project: 'p', number: 1, did: 'a', found: 'b', next: 'c' });
    assert.equal(tap.timeoutOf('GET', '/board/cards/by-number/1'), 4_000);
    assert.equal(tap.timeoutOf('POST', '/board/cards/card-1/comments'), 30_000);

    await w.call('board_link', { project: 'p', number: 1, links: [{ type: 'cycle', ref: 'c1', label: 'flow' }] });
    assert.equal(tap.timeoutOf('POST', '/board/cards/card-1/links'), 30_000);

    await w.call('board_add_many', { project: 'p', cycleId: 'cy', cards: [{ kind: 'BUG', title: 'y',
      firstComment: { did: 'd', found: 'f', next: 'n' }, specItem: { fileName: 'spec.md', itemKey: 'k1' } }] });
    assert.equal(tap.timeoutOf('POST', '/board/cards/card-2/comments'), 30_000);
    assert.equal(tap.timeoutOf('POST', '/board/cards/card-2/spec-items'), 30_000);
  } finally { tap.restore(); await w.close(); }
});
