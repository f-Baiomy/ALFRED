import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCapture, layoutSpacers, suppliersOf, toCallRecord, type CallSummaryDto, type CycleSpacer } from '../src/frontend.ts';
import { summaryOf } from './fake-alfred.ts';
import { world } from './harness.ts';
import { captureStatements, captureSummary, CYCLE, IN1, IN2, OUT1 } from './fixtures.ts';

const dto = (v: unknown) => v as CallSummaryDto;

test('list_cycles: name and status filters, call counts from both directions', async () => {
  const w = await world();
  try {
    const all = await w.call('list_cycles');
    assert.equal(all.json.cycles.length, 2);
    assert.equal(all.json.cycles.find((c: { id: string }) => c.id === CYCLE).callCount, 3);
    const named = await w.call('list_cycles', { nameContains: 'PAYMENT' });
    assert.deepEqual(named.json.cycles.map((c: { id: string }) => c.id), [CYCLE]);
    const recording = await w.call('list_cycles', { status: 'recording' });
    assert.equal(recording.json.cycles.length, 0);
  } finally { await w.close(); }
});

test('get_cycle by name: calls in run order across directions, comments under their call, DB summary and non-note findings', async () => {
  const w = await world();
  try {
    w.fake.state.comments.push({ id: 'cm1', callId: IN2, block: 'response-body', lineIndex: 0, lineText: '{', comment: 'payment answers 500', createdAt: '' });
    const r = await w.call('get_cycle', { cycle: 'fails at payment' });
    assert.equal(r.isError, false, r.text);
    const order = r.text.split('\n').filter((l) => l.startsWith('#')).map((l) => /id=(\S+)/.exec(l)![1]);
    assert.deepEqual(order, [IN1, OUT1, IN2]);
    assert.match(r.text, new RegExp(`#3 .*id=${IN2}\\n   💬 \\[response-body L1\\] payment answers 500`));
    // The DB lines are analyzeCapture's own words for the same capture (SC-003).
    const call = toCallRecord(dto(summaryOf(w.fake.state.calls.find((c) => c.record.id === IN1)!.record)), 'internal');
    const children = w.fake.state.calls.filter((c) => c.record.parentCallId === IN1).map((c) => toCallRecord(dto(summaryOf(c.record)), 'external'));
    const expected = analyzeCapture(call, { summary: captureSummary(), statements: captureStatements(), transactions: [], supplierMarkers: [] }, suppliersOf(IN1, children));
    assert.ok(r.text.includes(`◆ DB: ${expected.summary}`), 'summary line');
    const findings = expected.findings ?? [];
    assert.ok(findings.some((f) => f.severity === 'note'), 'fixture has a note to leave out');
    for (const f of findings.filter((x) => x.severity !== 'note')) assert.ok(r.text.includes(f.title), `finding ${f.title}`);
    for (const f of findings.filter((x) => x.severity === 'note')) assert.ok(!r.text.includes(f.title), `note ${f.title} left out`);
    assert.equal(r.json.totalCalls, 3);
    assert.equal(r.json.nextOffset, null);
  } finally { await w.close(); }
});

test('two cycles match the text: candidates, no guess', async () => {
  const w = await world();
  try {
    const r = await w.call('get_cycle', { cycle: 'booking fails' });
    assert.equal(r.json.candidates.length, 2);
  } finally { await w.close(); }
});

test('spacers land exactly where layoutSpacers puts them - top, after a call on an earlier page, at the end', async () => {
  const w = await world();
  try {
    const entries = w.fake.state.cycleEntries.get(CYCLE)!;
    const [, second, third] = entries.map((e) => e.record);
    const spacers = [
      { id: 'sp-top', label: 'start', afterCallId: null, anchorTimestamp: null },
      { id: 'sp-mid', label: 'pay', afterCallId: second.id, anchorTimestamp: second.timestamp },
      { id: 'sp-end', label: 'done', afterCallId: third.id, anchorTimestamp: third.timestamp },
    ] as CycleSpacer[];
    w.fake.state.spacers.set(CYCLE, spacers);
    const full = await w.call('get_cycle', { cycle: CYCLE, includeDb: false });
    const shape = full.text.split('\n').filter((l) => l.startsWith('#') || l.startsWith('──'))
      .map((l) => (l.startsWith('#') ? /id=(\S+)/.exec(l)![1] : l.split(' ')[1]));
    const calls = entries.map((e) => toCallRecord(dto(summaryOf(e.record)), e.source));
    const layout = layoutSpacers(calls, (c) => c, spacers, { descending: false, byTime: true });
    assert.deepEqual(shape, layout.merged.map((m) => (m.kind === 'item' ? m.item.id : m.spacer.label)));
    // Page 2 still shows the spacer anchored to call 2, which sits on page 1.
    const page2 = await w.call('get_cycle', { cycle: CYCLE, offset: 2, limit: 1, includeDb: false });
    assert.match(page2.text, /── pay ──[\s\S]*#3 [\s\S]*── done ──/);
    const page1 = await w.call('get_cycle', { cycle: CYCLE, offset: 0, limit: 2, includeDb: false });
    assert.equal(page1.json.nextOffset, 2);
    assert.ok(!page1.text.includes('── done ──'));
  } finally { await w.close(); }
});

test('a long comment is previewed in the story, never blowing the reply size', async () => {
  const w = await world();
  try {
    w.fake.state.comments.push({ id: 'cm-long', callId: IN1, block: 'response-body', lineIndex: 1, lineText: 'x', comment: 'stack\n'.repeat(8000), createdAt: '' });
    const r = await w.call('get_cycle', { cycle: CYCLE });
    assert.equal(r.isError, false);
    assert.match(r.text, /chars - list_comments callId in-flight-search commentId cm-long/);
    const full = await w.call('list_comments', { callId: IN1, commentId: 'cm-long' });
    assert.equal(full.json.comment.totalLength, 48000);
  } finally { await w.close(); }
});
