import { CardSummary } from '../../core/models/board.models';
import { BoardCycleRow, CyclePoint, CycleSummary } from '../../core/models/cycles-tab.models';
import {
  compareCycles, descriptionProse, environmentOf, hotSpots, markStep, parseSteps, pauseSuggested, readyToRetest, retestName, stepState,
  storySteps, verdictTone, versusLine,
} from './cycle-tab';

const point = (callId: string, at: string, method: string, path: string, status: number, failed = status >= 400): CyclePoint =>
  ({ direction: 'INBOUND', callId, at, method, path, status, ms: 100, failed });

function summary(over: Partial<CycleSummary> = {}): CycleSummary {
  return { cycleId: 'c', calls: 0, failed: 0, firstAt: null, lastAt: null, medianMs: null, hosts: [], endpoints: [], strip: [], inboundCallIds: [], ...over };
}

describe('cycle-tab (specs/033)', () => {
  it('names a re-test after its cards', () => {
    expect(retestName([{ number: 76, title: 'Baggage  differs' }], 'AB#1')).toBe('Re-test #76 · Baggage differs');
    expect(retestName([1, 2, 3, 4, 5].map((n) => ({ number: n, title: 't' })), 'AB#1')).toBe('Re-test #1 #2 #3 +2 · 5 cards');
    expect(retestName([], 'AB#1')).toBe('AB#1 · re-test');
  });

  it('reads steps from the description and ticks them by the calls, by hand above all', () => {
    const d = 'Re-test after 4f4139a\n- [ ] Search POST /api/search/flights\n- [x] Open details\n- [ ] Ancillaries GET /api/anc*\n- [-] Pay POST /api/pay';
    const steps = parseSteps(d);
    expect(steps.map((s) => s.mark)).toEqual([' ', 'x', ' ', '-']);
    expect(steps[0].endpoint).toEqual({ method: 'POST', path: '/api/search/flights' });
    expect(descriptionProse(d)).toBe('Re-test after 4f4139a');
    const s = summary({ strip: [point('1', '2026-10-18T13:16:00Z', 'POST', '/api/search/flights', 200), point('2', '2026-10-18T13:17:00Z', 'GET', '/api/ancillaries', 500),
      point('3', '2026-10-18T13:18:00Z', 'POST', '/api/pay', 200)] });
    expect(stepState(steps[0], s)).toEqual(jasmine.objectContaining({ done: true, by: 'calls' }));
    expect(stepState(steps[1], s)).toEqual(jasmine.objectContaining({ done: true, by: 'hand' }));
    expect(stepState(steps[2], s).done).toBe(false); // only a failed call so far
    expect(stepState(steps[3], s)).toEqual(jasmine.objectContaining({ done: false, by: 'hand' }));
    expect(markStep(d, 1, false).split('\n')[1]).toBe('- [-] Search POST /api/search/flights');
    expect(markStep(d, 0, true)).toBe(d); // not a step line: unchanged
  });

  it('puts the worst endpoints first', () => {
    const s = summary({ endpoints: [
      { direction: 'INBOUND', method: 'GET', path: '/a', calls: 3, failed: 0, lastStatus: 200, medianMs: 10, maxMs: 900, lastAt: null },
      { direction: 'INBOUND', method: 'GET', path: '/b', calls: 2, failed: 2, lastStatus: 500, medianMs: 10, maxMs: 20, lastAt: null },
    ] });
    expect(hotSpots(s).map((e) => e.path)).toEqual(['/b', '/a']);
  });

  it('compares two cycles: totals, status changes, slower, only in one', () => {
    const ep = (path: string, lastStatus: number, medianMs: number) =>
      ({ direction: 'INBOUND' as const, method: 'GET', path, calls: 1, failed: lastStatus >= 400 ? 1 : 0, lastStatus, medianMs, maxMs: medianMs, lastAt: null });
    const a = summary({ calls: 2, failed: 0, medianMs: 100, endpoints: [ep('/x', 200, 100), ep('/y', 200, 100), ep('/old', 200, 1)] });
    const b = summary({ calls: 2, failed: 1, medianMs: 300, endpoints: [ep('/x', 500, 100), ep('/y', 200, 400), ep('/new', 200, 1)] });
    const c = compareCycles(a, b);
    expect(c.totals[1].worse).toBeTrue();
    expect(c.statusChanged).toEqual([{ endpoint: 'GET /x', a: 200, b: 500, worse: true }]);
    expect(c.slower.map((s) => s.endpoint)).toEqual(['GET /y']);
    expect(c.onlyA).toEqual(['GET /old']);
    expect(c.onlyB).toEqual(['GET /new']);
    expect(versusLine('baseline', a, b)).toBe('vs baseline: 1 more failure, 200% slower');
    expect(versusLine('baseline', a, a)).toBeNull();
  });

  it('suggests a re-test only for Fixed cards no re-test saw since, and never again once hidden', () => {
    const card = (id: string, status: string, updatedAt: string) => ({ id, status, updatedAt }) as unknown as CardSummary;
    const row = (cycleId: string, cardIds: string[]): BoardCycleRow => ({ cycleId, kind: 'RETEST', baseline: false, archived: false, relatedAt: null,
      tests: cardIds.map((cardId) => ({ cardId, number: 1, title: '', status: 'FIXED', verdict: null, summary: null })), otherBoards: [] });
    const cards = [card('a', 'FIXED', '2026-10-18T12:00:00Z'), card('b', 'FIXED', '2026-10-18T14:00:00Z'), card('c', 'TO_DO', '2026-10-18T14:00:00Z')];
    const created = (id: string) => (id === 'r1' ? '2026-10-18T13:00:00Z' : null);
    expect(readyToRetest(cards, [row('r1', ['a', 'b'])], created, new Set()).map((c) => c.id)).toEqual(['b']);
    expect(readyToRetest(cards, [row('r1', ['a', 'b'])], created, new Set(['b']))).toEqual([]);
  });

  it('suggests a pause once every card of a recording re-test was checked', () => {
    const row = (verdicts: (string | null)[]): BoardCycleRow => ({ cycleId: 'r', kind: 'RETEST', baseline: false, archived: false, relatedAt: null,
      tests: verdicts.map((v, i) => ({ cardId: String(i), number: i, title: '', status: 'FIXED', verdict: v as never, summary: null })), otherBoards: [] });
    expect(pauseSuggested(row(['PASSES', 'FAILS']), true)).toBeTrue();
    expect(pauseSuggested(row(['PASSES', 'NO_CALLS']), true)).toBeFalse();
    expect(pauseSuggested(row(['PASSES']), false)).toBeFalse();
    expect(pauseSuggested(row([]), true)).toBeFalse();
  });

  it('groups the story by spacers, else by pauses', () => {
    const pts = [point('1', '2026-10-18T13:00:00Z', 'GET', '/a', 200), point('2', '2026-10-18T13:00:30Z', 'GET', '/b', 500),
      point('3', '2026-10-18T13:05:00Z', 'GET', '/c', 200)];
    const byGap = storySteps(pts, []);
    expect(byGap.map((s) => s.points.length)).toEqual([2, 1]);
    expect(byGap[0].failed).toBe(1);
    const bySpacer = storySteps(pts, [{ id: 's', label: 'Ancillaries', afterCallId: '1', anchorTimestamp: '2026-10-18T13:00:00Z' }]);
    expect(bySpacer.map((s) => s.label)).toEqual(['Start', 'Ancillaries']);
    expect(bySpacer[1].points.map((p) => p.callId)).toEqual(['2', '3']);
  });

  it('tones verdicts and names the environment', () => {
    expect(verdictTone('PASSES')).toBe('ok');
    expect(verdictTone('PARTIAL')).toBe('bad');
    expect(verdictTone(null)).toBe('unk');
    expect(environmentOf(summary({ hosts: ['env80:8080'] }))).toBe('env80');
    expect(environmentOf(summary({ hosts: ['localhost:8080'] }))).toBe('local');
    expect(environmentOf(summary())).toBeNull();
  });
});
