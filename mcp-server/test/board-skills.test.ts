import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ago } from '../src/tools/board.ts';
import { world } from './harness.ts';

/** specs/015: the tools the eleven skills use - waiting on, brief/spec writing, next steps, session log, test steps, links, proposals. */

test('ago says how long a card has waited', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(ago('2026-10-11T11:48:00Z', now), '12 min');
  assert.equal(ago('2026-10-11T08:00:00Z', now), '4 h');
  assert.equal(ago('2026-10-09T12:00:00Z', now), '2 d');
});

test('a comment, a reply and a question can say who the card waits on', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    await w.call('board_comment', { project: 'p', number: 1, did: 'd', found: 'f', next: 'a re-test', waitingOn: 'RETEST' });
    await w.call('board_reply', { project: 'p', number: 1, text: 'ok', waitingOn: 'CLAUDE' });
    const sent = w.fake.requests('POST', '/board/cards/card-1/comments').map((r) => r.body.waitingOn);
    assert.deepEqual(sent, ['RETEST', 'CLAUDE']);
  } finally { await w.close(); }
});

test('board_list shows who a card waits on, for how long, and what blocks it', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    Object.assign(w.fake.board.cards[0], { waiting: { who: 'USER', since: new Date(Date.now() - 2 * 3600_000).toISOString(), setBy: 'CLAUDE' },
      blockedBy: [{ project: 'p', number: 9, title: 'other', status: 'TO_DO' }] });
    const r = await w.call('board_list', { project: 'p' });
    assert.match(r.json.cards[0], /waiting on the user 2 h · 🔒 blocked by #9/);
  } finally { await w.close(); }
});

test('board_set_brief and board_put_spec write as Claude; a spec goes as plain text', async () => {
  const w = await world();
  try {
    const brief = await w.call('board_set_brief', { cycleId: 'cy', text: 'Import PNR\n## Test steps\n1. Open' });
    assert.equal(brief.isError, false, brief.text);
    assert.equal(w.fake.requests('PUT', '/board/cycles/cy/brief')[0].headers?.['x-alfred-actor'], 'claude');
    const spec = await w.call('board_put_spec', { cycleId: 'cy', name: 'spec.md', text: '# S\n## Acceptance\n1. works' });
    assert.equal(spec.isError, false, spec.text);
    const put = w.fake.requests('PUT', '/board/cycles/cy/specs/spec.md')[0];
    assert.equal(put.body, '# S\n## Acceptance\n1. works');
    assert.match(String(put.headers?.['content-type']), /text\/plain/);
  } finally { await w.close(); }
});

test('board_edit_spec replaces text that occurs once, and refuses a missing or repeated one', async () => {
  const w = await world();
  try {
    w.fake.board.specs['cy'] = { 'spec.md': '## Acceptance\n1. A works\n2. B works\n3. B works' };
    const ok = await w.call('board_edit_spec', { cycleId: 'cy', name: 'spec.md', find: 'A works', replace: 'A works fast' });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(w.fake.board.specs['cy']['spec.md'], '## Acceptance\n1. A works fast\n2. B works\n3. B works');
    const twice = await w.call('board_edit_spec', { cycleId: 'cy', name: 'spec.md', find: 'B works', replace: 'x' });
    assert.match(twice.json.message, /occurs 2 times/);
    const missing = await w.call('board_edit_spec', { cycleId: 'cy', name: 'spec.md', find: 'nope', replace: 'x' });
    assert.match(missing.json.message, /is not in spec.md/);
    w.fake.board.briefs['cy'] = { text: 'old step', updatedAt: null };
    await w.call('board_edit_spec', { cycleId: 'cy', name: 'brief', find: 'old', replace: 'new' });
    assert.equal(w.fake.board.briefs['cy'].text, 'new step');
  } finally { await w.close(); }
});

test('board_next_steps lists what waits on the user with why and since', async () => {
  const w = await world();
  try {
    w.fake.board.nextSteps = { waitingOnUser: [{ project: 'p', number: 11, title: 'PCC 409', status: 'INBOX', why: 'question', since: new Date(Date.now() - 86_400_000 * 2).toISOString() }],
      waitingOnClaude: 3, toDo: 3, inProgress: 0, fixed: 2, inbox: 4 };
    const r = await w.call('board_next_steps', { project: 'p' });
    assert.deepEqual(r.json.waitingOnUser, ['#11 PCC 409 - question · 2 d']);
    assert.equal(r.json.fixedNeedRetest, 2);
  } finally { await w.close(); }
});

test('session log, test steps and spec links', async () => {
  const w = await world();
  try {
    await w.call('board_session_log', { cycleId: 'cy', skill: 'alfred-review', did: 'Checked 120 calls', found: '2 cards', next: 'triage' });
    assert.equal(w.fake.board.log['cy'].length, 1);

    w.fake.board.steps['cy'] = [{ key: 'k1', text: 'Open import', state: 'UNTESTED', calls: 0, cardNumber: null, note: null },
      { key: 'k2', text: 'Pick a PCC', state: 'UNTESTED', calls: 0, cardNumber: null, note: null }];
    await w.call('board_mark_step', { cycleId: 'cy', stepKey: 'k1', state: 'SEEN', calls: 2 });
    await w.call('board_mark_step', { cycleId: 'cy', stepKey: 'k2', state: 'FAILED', cardNumber: 11, note: '409' });
    const steps = await w.call('board_steps', { cycleId: 'cy' });
    assert.deepEqual(steps.json.steps, ['[k1] ✓ Open import (2 calls)', '[k2] ✗ Pick a PCC (card #11: 409)']);

    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'x' });
    const linked = await w.call('board_link_spec', { project: 'p', number: 1, cycleId: 'cy', fileName: 'spec.md', itemKey: 'abc' });
    assert.equal(linked.isError, false, linked.text);
    assert.deepEqual(w.fake.requests('POST', '/board/cards/card-1/spec-items')[0].body, { cycleId: 'cy', fileName: 'spec.md', itemKey: 'abc' });
  } finally { await w.close(); }
});

test('board_block, merge and reopen proposals, and regressions', async () => {
  const w = await world();
  try {
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'a' });
    await w.call('board_add', { project: 'p', kind: 'BUG', title: 'b' });
    const blocked = await w.call('board_block', { project: 'p', number: 2, blockedBy: 1 });
    assert.match(blocked.json.card, /blocked by #1/);
    const unblocked = await w.call('board_block', { project: 'p', number: 2, blockedBy: 1, remove: true });
    assert.doesNotMatch(unblocked.json.card, /blocked by/);

    const merge = await w.call('board_propose', { project: 'p', number: 2, status: 'MERGE', intoNumber: 1, reason: 'same signature' });
    assert.match(merge.json.proposed, /proposed merge into #1/);
    const noInto = await w.call('board_propose', { project: 'p', number: 2, status: 'MERGE' });
    assert.equal(noInto.isError, true);

    w.fake.board.cards[0].status = 'DONE';
    const reopen = await w.call('board_propose', { project: 'p', number: 1, status: 'REOPEN', reason: 'fails again' });
    assert.match(reopen.json.proposed, /proposed reopen/);
    assert.equal(w.fake.requests('PUT', '/board/cards/card-1/proposal').at(-1)!.body.kind, 'REOPEN');

    w.fake.board.regressions = [{ number: 1, title: 'a', status: 'DONE', signature: '5xx|POST /x', calls: [{ ref: 'in:r1', label: 'POST /x · 500' }] }];
    const reg = await w.call('board_regressions', { project: 'p' });
    assert.deepEqual(reg.json.regressions, ['#1 a (DONE) [5xx|POST /x] - again: @[call:in:r1|POST /x · 500]']);
  } finally { await w.close(); }
});

test('board_status carries the live step', async () => {
  const w = await world();
  try {
    await w.call('board_status', { project: 'p', cycleId: 'cy', step: 'reviewing ODY-482 · 34/120 calls' });
    assert.equal(w.fake.requests('PUT', '/board/agent-status')[0].body.step, 'reviewing ODY-482 · 34/120 calls');
  } finally { await w.close(); }
});
