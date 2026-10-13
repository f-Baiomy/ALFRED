import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefSections, nextStep, requirementState } from '../src/tools/task.ts';
import { world } from './harness.ts';

/**
 * The harness: task_context gives a new session - any machine, any agent - the whole state of a task from Alfred, and
 * the `resume` prompt starts any MCP client on it.
 */

/** The checklist keys are sha-256 hex: board_link_spec and board_suggest_mark take them whole. */
const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);

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
      { key: KEY_A, text: 'Every passenger reaches the supplier', mark: { mark: 'FAIL', evidence: '' }, cards: [{ number: 1 }] },
      { key: KEY_B, text: 'The traveller is told of a new price', mark: null, suggestion: { mark: 'FAIL', evidence: '' } },
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
    assert.ok(t.includes(`✗ BUG [${KEY_A}] Every passenger reaches the supplier - cards #1`), 'an Acceptance item\'s key is printed in full, 64 characters');
    assert.ok(t.includes(`· BUG? [${KEY_B}] The traveller is told of a new price - you suggested FAIL`));
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

/** A task whose brief, requirements, findings and earlier runs are as long as a real one gets. */
function longTask(w: Awaited<ReturnType<typeof world>>, over: { findings: number; requirements?: number; outOfScope?: string; decisions?: string; description?: string }) {
  const id = 'cy-long';
  w.fake.addCycle({ id, name: 'ODY-500 long task', status: 'PAUSED' });
  const parts = ['## Task', 'ODY-500 - a long one.'];
  if (over.description) parts.push('## Description', over.description);
  if (over.outOfScope) parts.push('## Out of scope', over.outOfScope);
  if (over.decisions) parts.push('## Decisions', over.decisions);
  w.fake.board.briefs[id] = { text: parts.join('\n'), updatedAt: new Date(Date.now() - 3_600_000).toISOString() };
  w.fake.board.checklist[id] = [{ fileName: 'ODY-500.md', items: Array.from({ length: over.requirements ?? 12 }, (_, i) => ({
    key: i.toString(16).padStart(2, '0').repeat(32), text: `Requirement ${i}: the booking keeps every passenger through the supplier call`, mark: null })) }] as never;
  w.fake.board.log[id] = ['alfred-listen', 'alfred-review', 'alfred-fix'].map((skill, i) => ({
    skill, did: `did ${i} ${'x'.repeat(2000)}`, found: `found ${i} ${'y'.repeat(2000)}`, next: `next ${i} ${'z'.repeat(2000)}`,
    at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString() }));
  for (let n = 1; n <= over.findings; n++) {
    w.fake.board.cards.push({ id: `card-${n}`, project: 'odeysys', number: n, kind: 'BUG', title: `Finding ${n}: the second passenger is lost before OrderCreate`,
      status: 'TO_DO', flags: [], resolution: null, reason: null, cycleId: id, author: 'CLAUDE' });
  }
  return id;
}

const lines = (n: number, what: string) => Array.from({ length: n }, (_, i) => `- ${what} ${i}: ${Array(4).fill('kept as it is').join(', ')}`).join('\n');

test('task_context never cuts the brief\'s Out of scope and Decisions; the other sections are cut as before', async () => {
  const w = await world();
  try {
    const outOfScope = lines(45, 'out');
    const decisions = lines(45, 'decision');
    longTask(w, { findings: 3, outOfScope, decisions, description: 'D'.repeat(3000) });
    const r = await w.call('task_context', { task: 'ODY-500' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes(`OUT OF SCOPE: ${outOfScope.replace(/\n/g, '\n    ')}`), 'Out of scope is whole');
    assert.ok(r.text.includes(`DECISIONS: ${decisions.replace(/\n/g, '\n    ')}`), 'Decisions is whole');
    assert.match(r.text, /DESCRIPTION: D{1400}… \(3000 chars - get_brief for all\)/);
  } finally { await w.close(); }
});

test('task_context prints every Acceptance item\'s key in full, whatever it has to cut to fit', async () => {
  const w = await world();
  try {
    longTask(w, { findings: 150, requirements: 15, outOfScope: lines(45, 'out'), decisions: lines(45, 'decision') });
    const r = await w.call('task_context', { task: 'ODY-500' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.length <= 16_000, `${r.text.length} characters`);
    const keys = [...r.text.matchAll(/\[([0-9a-f]{64})\]/g)].map((m) => m[1]);
    assert.equal(keys.length, 15);
    assert.equal(new Set(keys).size, 15);
    assert.doesNotMatch(r.text, /\[[0-9a-f]{8}\]/, 'no 8-character key');
  } finally { await w.close(); }
});

test('task_context fits the reply by cutting the earlier runs first, then the tail of the findings', async () => {
  const w = await world();
  try {
    // Over the budget only because of the three earlier runs: they are shortened, no finding is.
    longTask(w, { findings: 40, outOfScope: lines(50, 'out'), decisions: lines(50, 'decision') });
    const runsCut = (await w.call('task_context', { task: 'ODY-500' })).text;
    assert.ok(runsCut.length <= 16_000, `${runsCut.length} characters`);
    assert.match(runsCut, /#40 BUG TO_DO - Finding 40/, 'every finding is there');
    assert.match(runsCut, /earlier run\(s\) not shown to fit this reply/);
    assert.match(runsCut, /\/alfred-listen · 1 h ago/, 'the newest run is kept');
  } finally { await w.close(); }

  const big = await world();
  try {
    // Many findings as well: the runs are gone, the findings are cut at their tail - and what is never cut, is not.
    longTask(big, { findings: 150, outOfScope: lines(50, 'out'), decisions: lines(50, 'decision') });
    const t = (await big.call('task_context', { task: 'ODY-500' })).text;
    assert.ok(t.length <= 16_000, `${t.length} characters`);
    assert.doesNotMatch(t, /\/alfred-listen · /, 'no run is shown');
    assert.match(t, /3 earlier run\(s\) not shown to fit this reply/);
    assert.match(t, /#1 BUG TO_DO - Finding 1:/, 'the findings keep their head');
    assert.match(t, /… \+\d+ more open - board_search \{"cycleId":"cy-long"\}/);
    assert.doesNotMatch(t, /#150 BUG/, 'and lose their tail');
    assert.match(t, /FINDINGS - 150 open/, 'the count stays whole');
    assert.ok(t.includes(`OUT OF SCOPE: ${lines(50, 'out').replace(/\n/g, '\n    ')}`));
    assert.match(t, /\nNEXT: [\s\S]*\nTOOLS: /);
  } finally { await big.close(); }
});

test('task_context says so, and still cuts nothing of Out of scope and Decisions, when those two alone are over the budget', async () => {
  const w = await world();
  try {
    const outOfScope = lines(130, 'out');
    const decisions = lines(130, 'decision');
    longTask(w, { findings: 5, outOfScope, decisions });
    const r = await w.call('task_context', { task: 'ODY-500' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.includes(`OUT OF SCOPE: ${outOfScope.replace(/\n/g, '\n    ')}`));
    assert.ok(r.text.includes(`DECISIONS: ${decisions.replace(/\n/g, '\n    ')}`));
    assert.match(r.text, /over the usual 16000: everything that may be cut was, and the brief's Out of scope and Decisions never are/);
    assert.doesNotMatch(r.text, /\/alfred-listen · /, 'everything that can be cut was');
    assert.match(r.text, /\nNEXT: [\s\S]*\nTOOLS: [\s\S]*\n\{"cycleId":"cy-long"/, 'and the reply still ends with its next step and its data line');
  } finally { await w.close(); }
});
