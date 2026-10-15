import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveItem, type RequirementRow, type RequirementsView } from '../src/tools/requirements.ts';
import { world } from './harness.ts';

/** specs/018: the requirement check through the MCP tools - verdicts by the calls, evidence Claude drafts. */

const KEY = (c: string) => c.repeat(64).slice(0, 64);
const CY = 'cy-req';

function item(n: number, text: string, verdict: RequirementRow['verdict']['verdict'], over: Partial<RequirementRow> = {}): RequirementRow {
  return {
    fileName: 'spec.md', itemKey: KEY(String(n)), text, mark: null, evidence: null, cardNumber: null, cardStatus: null,
    verdict: { verdict, callId: null, reason: null, cardId: null, judgedAt: null, counts: { contradicts: 0, wrong: 0, meets: 0, noData: 0, unknown: 0 } },
    ...over,
  };
}

const VIEW: RequirementsView = {
  cycleId: CY,
  items: [
    item(1, 'The Agency dropdown lists an "All Agencies" option.', 'MANUAL'),
    item(2, 'Searching with All Agencies returns requests of every agency.', 'NOT_EXERCISED',
      { evidence: { cycleId: CY, fileName: 'spec.md', itemKey: KEY('2'), project: 'odeysys', endpoint: 'POST /x/search', checks: [], howTo: 'All Agencies, Search', updatedBy: 'CLAUDE', updatedAt: null } }),
    item(3, 'The Branch dropdown keeps several branches selected at once.', 'MISSING', { cardNumber: 41, cardStatus: 'INBOX',
      verdict: { verdict: 'MISSING', callId: 'f89e0b77-194e-4294-a2ea-b2eb9c6f8717', reason: 'request $.branch* is a list - sent branchId: 948', cardId: 'c41',
        judgedAt: null, counts: { contradicts: 5, wrong: 0, meets: 0, noData: 0, unknown: 0 } } }),
    item(4, 'Searching with one branch returns only that branch\'s requests.', 'NO_DATA'),
    item(5, 'Export To Excel exports the rows matching the filters.', 'NO_EVIDENCE'),
  ],
  counts: { MISSING: 1, NO_DATA: 1, NOT_EXERCISED: 1, MANUAL: 1, NO_EVIDENCE: 1 },
};

test('an item is named by its key, its AC number or the start of its text', () => {
  assert.equal((resolveItem(VIEW.items, KEY('3')) as RequirementRow).itemKey, KEY('3'));
  assert.equal((resolveItem(VIEW.items, 'AC4') as RequirementRow).itemKey, KEY('4'));
  assert.equal((resolveItem(VIEW.items, '2') as RequirementRow).itemKey, KEY('2'));
  assert.equal((resolveItem(VIEW.items, 'the branch dropdown') as RequirementRow).itemKey, KEY('3'));
  assert.match(resolveItem(VIEW.items, 'Searching with') as string, /starts 2 items/);
  assert.match(resolveItem(VIEW.items, 'AC9') as string, /no AC9 - the cycle has 5/);
});

test('board_requirements: every item with its verdict by the calls, the deciding call and the card', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: CY, name: '61813 Refunded Requests filters', status: 'RECORDING' });
    w.fake.board.requirements = { [CY]: VIEW };
    const r = await w.call('board_requirements', { cycleId: '61813' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.counts, '1 missing · 1 no data · 1 not exercised · 1 manual · 1 no evidence');
    const lines = r.json.items as string[];
    assert.ok(lines[2].startsWith('AC3 MISSING (#41) @[call:in:f89e0b77-194e-4294-a2ea-b2eb9c6f8717@cy-req|call f89e0b77]'), lines[2]);
    assert.ok(lines[2].endsWith('- request $.branch* is a list - sent branchId: 948'), lines[2]);
    assert.match(lines[1], /AC2 NOT_EXERCISED .* - how: All Agencies, Search$/);
    assert.match(lines[4], /AC5 NO_EVIDENCE .* - board_evidence_put writes how the calls show it$/);
  } finally { await w.close(); }
});

test('board_evidence_put: several items in one call, each named as listed; a refusal says why and the rest are saved', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: CY, name: '61813 Refunded Requests filters', status: 'RECORDING' });
    w.fake.board.requirements = { [CY]: VIEW };
    const r = await w.call('board_evidence_put', { cycleId: CY, project: 'odeysys', items: [
      { item: 'AC3', endpoint: 'POST /odeysysadmin/Booking2/refunded-requests/search', checks: [{ kind: 'REQUEST_SHAPE', path: '$.branch*', shape: 'list' }],
        howTo: 'pick 2 branches, Search' },
      { item: 'The Agency dropdown', endpoint: 'UI' },
      { item: 'AC4', endpoint: 'REFUSE' },
      { item: 'AC12', endpoint: 'UI' },
    ] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.json.saved.map((s: string) => s.slice(0, 3)), ['AC3', 'AC1']);
    assert.equal(r.json.refused.length, 2, r.text);
    assert.match(r.json.refused[0], /^AC4: .*only the user changes it/);
    assert.match(r.json.refused[1], /no AC12/);
    const puts = w.fake.board.evidencePuts!;
    assert.equal(puts.length, 2);
    assert.deepEqual(puts[0].body, { fileName: 'spec.md', itemKey: KEY('3'), project: 'odeysys',
      endpoint: 'POST /odeysysadmin/Booking2/refunded-requests/search', checks: [{ kind: 'REQUEST_SHAPE', path: '$.branch*', shape: 'list' }],
      howTo: 'pick 2 branches, Search' });
  } finally { await w.close(); }
});

test('task_context shows each item\'s verdict by the calls and the counts; an Alfred without the check shows what it showed before', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: CY, name: '61813 Refunded Requests filters', status: 'RECORDING' });
    w.fake.board.checklist[CY] = [{ fileName: 'spec.md', items: VIEW.items.map((i) => ({ key: i.itemKey, text: i.text, mark: null })) }] as never;
    const before = await w.call('task_context', { task: CY });
    assert.doesNotMatch(before.text, /By the calls/);

    w.fake.board.requirements = { [CY]: VIEW };
    const t = (await w.call('task_context', { task: CY })).text;
    assert.match(t, /By the calls \(Alfred's requirement check, in code\): 1 missing · 1 no data · 1 not exercised · 1 manual · 1 no evidence/);
    assert.ok(t.includes(`[${KEY('3')}] The Branch dropdown keeps several branches selected at once. - calls: MISSING (request $.branch* is a list - sent branchId: 948)`), t);
    assert.ok(t.includes(`[${KEY('5')}] Export To Excel exports the rows matching the filters. - calls: no evidence yet`), t);
  } finally { await w.close(); }
});

test('board_verify with a task\'s cycle says the task is not done while an item is missing, even with no Fixed card', async () => {
  const w = await world();
  try {
    w.fake.addCycle({ id: CY, name: '61813 Refunded Requests filters', status: 'RECORDING' });
    w.fake.board.requirements = { [CY]: VIEW };
    const r = await w.call('board_verify', { project: 'odeysys', cycleId: CY });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.task, /^NOT DONE - 1 missing/);
  } finally { await w.close(); }
});
