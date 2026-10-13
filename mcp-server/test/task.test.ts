import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefSections, nextStep, requirementState } from '../src/tools/task.ts';
import { world } from './harness.ts';

/**
 * The harness: task_context gives a new session - any machine, any agent - the whole state of a task from Alfred, and
 * the `resume` prompt starts any MCP client on it.
 */

const BRIEF = [
  'Bookings must keep every passenger.',
  '## Task',
  'ODY-482 - production lost the second passenger.',
  '## Description',
  'A traveller books one flight for two adults: search, confirm, book, open the booking.',
  '## Out of scope',
  'Payment, seats.',
  '## Test steps',
  '1. Search',
  '2. Book',
  '## Decisions',
  '- fare.total may change at confirm and must be shown (answered 12/10)',
].join('\n');

test('the brief splits into its sections by heading', () => {
  const s = briefSections(BRIEF);
  assert.deepEqual(s.map((x) => x.name), ['summary', 'task', 'description', 'out of scope', 'test steps', 'decisions']);
  assert.equal(s[2].text, 'A traveller books one flight for two adults: search, confirm, book, open the booking.');
});

test('the next step follows the board: brief, the user, inbox, to do, fixed, requirements', () => {
  const none = { waitingOnUser: [], waitingOnClaude: 0, toDo: 0, inProgress: 0, fixed: 0, inbox: 0 };
  assert.match(nextStep('T', false, false, none, []), /alfred-setup/);
  assert.match(nextStep('T', true, true, { ...none, waitingOnUser: [{ number: 1, title: 'q', why: 'question', since: '' }] }, []), /alfred-sync/);
  const card = (status: string) => ({ project: 'p', number: 1, kind: 'BUG', title: 't', status, flags: [], resolution: null, reason: null });
  assert.match(nextStep('T', true, true, none, [card('INBOX')]), /alfred-triage/);
  assert.match(nextStep('T', true, true, none, [card('TO_DO')]), /alfred-fix/);
  assert.match(nextStep('T', true, true, none, [card('FIXED')]), /alfred-verify/);
  assert.match(nextStep('T', true, false, none, []), /Acceptance list/);
});

test('task_context: the brief, the requirements with the user\'s marks, the findings, the decisions, earlier runs and the next step', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: 'cy-task', name: 'ODY-482 Book flight', status: 'PAUSED' });
    w.fake.board.briefs['cy-task'] = { text: BRIEF, updatedAt: new Date(Date.now() - 3_600_000).toISOString() };
    w.fake.board.checklist['cy-task'] = [{ fileName: 'ODY-482.md', items: [
      { key: 'aaaaaaaa11', text: 'Every passenger reaches the supplier', mark: { mark: 'FAIL', evidence: '' }, cards: [{ number: 1 }] },
      { key: 'bbbbbbbb22', text: 'The traveller is told of a new price', mark: null, suggestion: { mark: 'FAIL', evidence: '' } },
    ] }] as never;
    w.fake.board.steps['cy-task'] = [{ key: 's1', text: 'Search', state: 'SEEN', calls: 31, cardNumber: null, note: null },
      { key: 's2', text: 'Book', state: 'FAILED', calls: 3, cardNumber: 1, note: null }];
    w.fake.board.log['cy-task'] = [{ skill: 'alfred-listen', did: '214/214 checked', found: '#1 a passenger is lost', next: 'triage', at: new Date(Date.now() - 7_200_000).toISOString() }];
    await w.call('board_add', { project: 'odeysys', kind: 'BUG', title: 'Second passenger never reaches OrderCreate', cycleId: 'cy-task' });
    await w.call('board_add', { project: 'odeysys', kind: 'TASK', title: 'Price change is not shown', cycleId: 'cy-task' });
    await w.call('board_add', { project: 'odeysys', kind: 'NOTE', title: 'Avatar 404', cycleId: 'cy-task' });
    Object.assign(w.fake.board.cards[2], { status: 'CLOSED', resolution: 'FINE', reason: 'no avatar uploaded' });

    const r = await w.call('task_context', { task: 'ODY-482' });
    assert.equal(r.isError, false, r.text);
    const t = r.text;
    assert.match(t, /^TASK "ODY-482 Book flight" \(cycle cy-task\) · project odeysys · PAUSED/);
    assert.match(t, /shared memory across sessions, machines and agents/);
    assert.match(t, /TASK: ODY-482 - production lost the second passenger\./);
    assert.match(t, /DESCRIPTION: A traveller books one flight/);
    assert.match(t, /OUT OF SCOPE: Payment, seats\./);
    assert.match(t, /DECISIONS: - fare\.total may change at confirm/);
    assert.match(t, /REQUIREMENTS .* - 2: 0 pass · 1 fail · 0 can't tell · 1 unmarked/);
    assert.match(t, /✗ BUG \[aaaaaaaa\] Every passenger reaches the supplier - cards #1/);
    assert.match(t, /· BUG\? \[bbbbbbbb\] The traveller is told of a new price - you suggested FAIL/);
    assert.match(t, /✗ \[s2\] Book \(#1\)/);
    assert.match(t, /FINDINGS - 2 open \(1 bugs · 1 missing \/ to do · 0 notes · 0 questions\), 1 finished or closed/);
    assert.match(t, /Decided by the user \(never raise again\):\n    #3 FINE: no avatar uploaded - Avatar 404/);
    assert.match(t, /EARLIER RUNS[\s\S]*\/alfred-listen · 2 h ago[\s\S]*found: #1 a passenger is lost/);
    assert.match(t, /NEXT: \/alfred-triage/);
    assert.doesNotMatch(t, /1\. Search\n/, 'test steps come from the steps list with their results, not twice');
  } finally { await w.close(); }
});

test('a requirement\'s state matches the Task tab: mark, then linked cards, then the suggestion', () => {
  const cards = [{ number: 1, kind: 'BUG', status: 'TO_DO' }, { number: 2, kind: 'TASK', status: 'INBOX' }, { number: 3, kind: 'BUG', status: 'FIXED' }];
  const item = (over: object) => ({ key: 'k', text: 't', mark: null, ...over });
  assert.equal(requirementState(item({ mark: { mark: 'PASS' } }), cards), 'MET');
  assert.equal(requirementState(item({ cards: [{ number: 1 }] }), cards), 'BUG');
  assert.equal(requirementState(item({ cards: [{ number: 2 }] }), cards), 'MISSING');
  assert.equal(requirementState(item({ cards: [{ number: 3 }] }), cards), 'FIXED');
  assert.equal(requirementState(item({ mark: { mark: 'FAIL' }, cards: [{ number: 2 }] }), cards), 'MISSING');
  assert.equal(requirementState(item({ suggestion: { mark: 'PASS' } }), cards), 'MET?');
  assert.equal(requirementState(item({}), cards), 'NOT CHECKED');
});

test('task_context without a task lists the tasks, newest first; an unclear name asks which', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: 'cy-a', name: 'ODY-470 search', status: 'PAUSED', createdAt: '2026-10-01T00:00:00Z' });
    w.fake.addCycle({ id: 'cy-b', name: 'ODY-482 booking', status: 'RECORDING', createdAt: '2026-10-12T00:00:00Z' });
    const list = await w.call('task_context', {});
    assert.ok(list.text.indexOf('ODY-482 booking') < list.text.indexOf('ODY-470 search'), list.text);
    const unclear = await w.call('task_context', { task: 'ODY-4' });
    assert.match(unclear.text, /matches 2 tasks - ask the user which one/);
  } finally { await w.close(); }
});

test('the resume prompt starts any MCP client on a task from Alfred', async () => {
  const w = await world();
  try {
    const { connect } = await import('./harness.ts');
    const h = await connect(w.fake.url);
    try {
      const prompts = await h.client.listPrompts();
      assert.ok(prompts.prompts.some((p) => p.name === 'resume'));
      const p = await h.client.getPrompt({ name: 'resume', arguments: { task: 'ODY-482' } });
      const textOf = (p.messages[0].content as { text: string }).text;
      assert.match(textOf, /Call task_context with task "ODY-482"/);
      assert.match(textOf, /continues from Alfred, not from this conversation/);
    } finally { await h.close(); }
  } finally { await w.close(); }
});
