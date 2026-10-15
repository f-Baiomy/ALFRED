import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CYCLE, IN1, IN2 } from './fixtures.ts';
import { world } from './harness.ts';

/** specs/021: what Claude writes on the board is saved readable - each shorthand as its mention with its meaning. */

const item = (text: string, shortName: string | null = null) => ({ fileName: 'spec.md', itemKey: text.slice(0, 8), text, mark: null, evidence: null,
  verdict: { verdict: 'NO_DATA', callId: null, reason: null, cardId: null, judgedAt: null, counts: {} }, cardNumber: null, cardStatus: null, shortName });

async function boardWorld() {
  const w = await world();
  w.fake.board.requirements = { [CYCLE]: { cycleId: CYCLE, counts: {}, items: [item('The search lists All Agencies'), item("Searching with one branch returns only that branch's requests", 'one-branch search')] } };
  await w.call('board_add', { project: 'p', kind: 'TASK', title: 'Not exercised: All Agencies (AC1)', cycleId: CYCLE, shortName: 'All Agencies untested' });
  return w;
}

test('a comment\'s shorthand is saved as mentions with their meaning, and the reply says so', async () => {
  const w = await boardWorld();
  try {
    await w.call('board_add', { project: 'p', kind: 'TASK', title: 'second', cycleId: CYCLE });
    const r = await w.call('board_comment', { project: 'p', number: 2, did: 'Same as #1. AC2: calls #1 and #3 sent 3 branches.', found: 'AC9 has no item; #77 no card', next: 'see `#1` in code' });
    assert.equal(r.isError, false, r.text);
    const text = w.fake.board.activity['card-2'].at(-1).text as string;
    assert.match(text, /Same as @\[card:p#1\|All Agencies untested \(#1\)\]/);
    assert.match(text, /@\[spec:cy-booking\/spec\.md#ac2\|one-branch search \(AC2\)\]/);
    assert.ok(text.includes(`calls @[call:in:${IN1}@${CYCLE}|`), text);
    assert.ok(text.includes(`(call 1)] and @[call:in:${IN2}@${CYCLE}|`), text);
    assert.match(text, /POST booking\/fare-confirmation · 500 \(call 3\)\] sent 3 branches/);
    assert.match(text, /AC9 has no item; #77 no card/);
    assert.match(text, /see `#1` in code/);
    assert.match(r.text, /written as mentions with their meaning/);
    assert.match(r.text, /left as written[^"]*AC9, #77/);
  } finally { await w.close(); }
});

test('an item without a short name reads the first words of its text; [n] becomes who and when', async () => {
  const w = await boardWorld();
  try {
    await w.call('board_reply', { project: 'p', number: 1, text: 'first' });
    const r = await w.call('board_reply', { project: 'p', number: 1, text: 'As [0] said, AC1 is open.' });
    assert.equal(r.isError, false, r.text);
    const text = w.fake.board.activity['card-1'].at(-1).text as string;
    assert.match(text, /As @\[card:p#1\/e1\|Claude's comment · \d+ Oct [^\]]+\] said, @\[spec:cy-booking\/spec\.md#ac1\|the search lists All \(AC1\)\] is open\./);
  } finally { await w.close(); }
});

test('board_short_name names a card or an item once; a second name is the user\'s', async () => {
  const w = await boardWorld();
  try {
    assert.equal(w.fake.board.cards[0].shortName, 'All Agencies untested');
    const again = await w.call('board_short_name', { project: 'p', number: 1, shortName: 'other' });
    assert.equal(again.isError, true);
    const item = await w.call('board_short_name', { project: 'p', cycleId: CYCLE, ac: 1, shortName: 'All Agencies listed' });
    assert.equal(item.isError, false, item.text);
    assert.deepEqual(w.fake.board.itemNames?.[0], { cycleId: CYCLE, fileName: 'spec.md', itemKey: 'The sear', shortName: 'All Agencies listed' });
    const none = await w.call('board_short_name', { project: 'p', cycleId: CYCLE, ac: 7, shortName: 'x' });
    assert.match(none.text, /There is no AC7/);
  } finally { await w.close(); }
});
