import { buildMatrix, compareRuns, noteFor, recordingSide, runSide, sentChanges, stepSide, verdictOf, MatrixCell, StepSide } from './relive-run-compare';
import { cmpResult, cmpRun, cmpStep } from './relive-run-compare.testing';
import { NoiseRule } from './relive-types';

const none = () => [] as readonly NoiseRule[];

function side(outcome: StepSide['outcome'], status: number | null, durationMs: number | null): StepSide {
  return { outcome, status, durationMs, mode: 'LIVE', result: null, request: null, response: null, error: null };
}

describe('relive-run-compare', () => {
  const steps = [cmpStep('login'), cmpStep('search'), cmpStep('pax'), cmpStep('fare')];

  describe('verdictOf', () => {
    it('names a new failure, a fix, a changed answer, slower and faster steps', () => {
      expect(verdictOf(side('ok', 200, 100), side('fail', 500, 100), 0)).toBe('NEW_FAILURE');
      expect(verdictOf(side('fail', 502, 100), side('ok', 200, 100), 0)).toBe('FIXED');
      expect(verdictOf(side('ok', 200, 100), side('diff', 200, 100), 2)).toBe('CHANGED');
      expect(verdictOf(side('ok', 200, 1000), side('ok', 200, 2000), 0)).toBe('SLOWER');
      expect(verdictOf(side('ok', 200, 2000), side('ok', 200, 1000), 0)).toBe('FASTER');
      expect(verdictOf(side('ok', 200, 100), side('ok', 200, 110), 0)).toBe('SAME');
    });

    it('does not call a few milliseconds on a fast call slower', () => {
      expect(verdictOf(side('ok', 200, 10), side('ok', 200, 30), 0)).toBe('SAME');
    });

    it('a step that ran in only one of the two is not run, or a new failure when B failed it', () => {
      expect(verdictOf(side('ok', 200, 100), side('skip', null, null), 0)).toBe('NOT_RUN');
      expect(verdictOf(side('skip', null, null), side('fail', 500, 10), 0)).toBe('NEW_FAILURE');
    });
  });

  describe('compareRuns', () => {
    const a = cmpRun('a', '2026-10-02T15:40:00Z', steps, [
      cmpResult('login', 'COMPLETED', { status: 200, body: '{"user":"x","at":"2026-10-02T15:40:01Z"}' }, { durationMs: 400 }),
      cmpResult('search', 'COMPLETED', { status: 200, body: '{"journeys":14}' }, { durationMs: 20000 }),
      cmpResult('pax', 'COMPLETED', { status: 200, body: '{"paxCount":2}' }, { durationMs: 160 }),
      cmpResult('fare', 'FAILED', { status: 502, body: '{}' }, { durationMs: 90 }),
    ]);
    const b = cmpRun('b', '2026-10-02T16:16:00Z', steps, [
      cmpResult('login', 'COMPLETED', { status: 200, body: '{"user":"x","at":"2026-10-02T16:16:09Z"}' }, { durationMs: 398 }),
      cmpResult('search', 'COMPLETED', { status: 200, body: '{"journeys":9}' }, { durationMs: 48000 }),
      cmpResult('pax', 'FAILED', { status: 500, body: '{"message":"Failed to get pax details"}' }, { durationMs: 178 }),
      cmpResult('fare', 'COMPLETED', { status: 200, body: '{}' }, { durationMs: 392 }),
    ]);
    const cmp = compareRuns(runSide(a), runSide(b), none);
    const row = (key: string) => cmp.rows.find((r) => r.key === key)!;

    it('grades every step and counts the verdicts', () => {
      expect(row('login').verdict).toBe('SAME');
      expect(row('search').verdict).toBe('CHANGED');
      expect(row('pax').verdict).toBe('NEW_FAILURE');
      expect(row('fare').verdict).toBe('FIXED');
      expect(cmp.counts.NEW_FAILURE).toBe(1);
      expect(cmp.changedCount).toBe(3);
    });

    it('keeps a noise field out of the changed fields but listed as noise', () => {
      expect(row('login').fields.length).toBe(1);
      expect(row('login').fields[0]).toEqual(jasmine.objectContaining({ path: 'body.at', noise: true, cause: 'timestamp' }));
      expect(row('search').fields).toEqual([jasmine.objectContaining({ path: 'body.journeys', a: '14', b: '9', noise: false })]);
    });

    it('a noise rule of the cycle makes the field noise', () => {
      const rules: NoiseRule[] = [{ part: 'body', path: 'body.journeys', auto: false, count: false }];
      const withRule = compareRuns(runSide(a), runSide(b), () => rules);
      const search = withRule.rows.find((r) => r.key === 'search')!;
      expect(search.fields[0].noise).toBeTrue();
      // Still twice as slow.
      expect(search.verdict).toBe('SLOWER');
    });

    it('opens with an answer: B is worse when it has more new failures than fixes', () => {
      expect(cmp.verdict.tone).toBe('mixed');
      expect(cmp.verdict.text).toContain('1 new failure (Step pax)');
      expect(cmp.verdict.text).toContain('1 step fixed');
      const worse = compareRuns(runSide(cmpRun('a', 't', steps, [cmpResult('pax', 'COMPLETED', { status: 200 })])), runSide(cmpRun('b', 't', steps, [cmpResult('pax', 'FAILED', { status: 500 })])), none);
      expect(worse.verdict.lead).toBe('B is worse:');
    });

    it('says so when nothing changed', () => {
      const same = compareRuns(runSide(a), runSide(a), none);
      expect(same.verdict.tone).toBe('same');
      expect(same.changedCount).toBe(0);
    });

    it('a step only one run has still shows, after the others', () => {
      const extra = cmpRun('a2', 't', [...steps, cmpStep('old')], [cmpResult('old', 'COMPLETED', { status: 200 })]);
      const cmp2 = compareRuns(runSide(extra), runSide(b), none);
      expect(cmp2.rows[cmp2.rows.length - 1].key).toBe('old');
      expect(cmp2.rows[cmp2.rows.length - 1].verdict).toBe('NOT_RUN');
    });

    it('a step that did not run has no time, even when a 0 was stored', () => {
      const ran = cmpRun('a', 't', steps, [cmpResult('login', 'COMPLETED', { status: 200 }, { durationMs: 17 })]);
      const skipped = cmpRun('b', 't', steps, [cmpResult('login', 'NOT_CALLED', null, { durationMs: 0 })]);
      const login = compareRuns(runSide(ran), runSide(skipped), none).rows[0];
      expect(login.b.durationMs).toBeNull();
      expect(login.timeChangePct).toBeNull();
    });

    it('puts children right under their parent', () => {
      const withChild = [cmpStep('p'), cmpStep('q'), cmpStep('p.c', { parentKey: 'p', direction: 'outbound' })];
      const r = cmpRun('x', 't', withChild, []);
      const keys = compareRuns(runSide(r), runSide(r), none).rows.map((row) => [row.key, row.isChild]);
      expect(keys).toEqual([['p', false], ['p.c', true], ['q', false]]);
    });
  });

  describe('the recording as side A', () => {
    it('compares each step with what was recorded', () => {
      const b = runSide(cmpRun('b', 't', steps, [cmpResult('login', 'COMPLETED', { status: 200, body: '{"ok":false}' })]));
      const cmp = compareRuns(recordingSide(b), b, none);
      const login = cmp.rows.find((r) => r.key === 'login')!;
      expect(login.a.mode).toBe('RECORDED');
      expect(login.a.durationMs).toBe(100);
      expect(login.fields[0]).toEqual(jasmine.objectContaining({ path: 'body.ok', a: 'true', b: 'false' }));
      expect(cmp.rows.find((r) => r.key === 'search')!.verdict).toBe('NOT_RUN');
    });
  });

  describe('sentChanges', () => {
    it('lists a variable whose value changed and does not repeat it as a request field', () => {
      const s = cmpStep('pax');
      const a = stepSide(runSide(cmpRun('a', 't', [s], [cmpResult('pax', 'COMPLETED', { status: 200 }, {
        variablesUsed: [{ name: '$.sessionId', value: 'GGnU6' }],
        actualRequest: { method: 'GET', url: 'https://app.local/api/pax', headers: { cookie: 'sid=GGnU6' }, body: '{"sid":"GGnU6"}' },
      })])), s);
      const b = stepSide(runSide(cmpRun('b', 't', [s], [cmpResult('pax', 'COMPLETED', { status: 200 }, {
        variablesUsed: [{ name: '$.sessionId', value: 'LSucv' }],
        actualRequest: { method: 'GET', url: 'https://app.local/api/pax', headers: { cookie: 'sid=LSucv' }, body: '{"sid":"LSucv","extra":1}' },
      })])), s);
      const sent = sentChanges(a, b, []);
      expect(sent.map((c) => c.path)).toEqual(['{{$.sessionId}}', 'request.body.extra']);
    });
  });

  describe('compared values', () => {
    it('shows each value side by side, changed or missing', () => {
      const a = cmpRun('a', 't', steps, [], { variableTimeline: [{ name: '$.sid', value: '1', stepKey: 'login', at: 't' }, { name: '$.pnr', value: 'XK', stepKey: 'fare', at: 't' }] });
      const b = cmpRun('b', 't', steps, [], { variableTimeline: [{ name: '$.sid', value: '2', stepKey: 'login', at: 't' }] });
      const vars = compareRuns(runSide(a), runSide(b), none).variables;
      expect(vars).toEqual([
        { name: '$.sid', savedBy: 'Step login', a: '1', b: '2', change: 'changed' },
        { name: '$.pnr', savedBy: 'Step fare', a: 'XK', b: null, change: 'missing-b' },
      ]);
    });
  });

  describe('the run matrix', () => {
    it('one row per step, one cell per run, newest first', () => {
      const r1 = runSide(cmpRun('r1', '1', steps, [cmpResult('login', 'COMPLETED', { status: 200 })]));
      const r2 = runSide(cmpRun('r2', '2', steps, [cmpResult('login', 'FAILED', { status: 500 })]));
      const rows = buildMatrix([r2, r1]);
      expect(rows.length).toBe(4);
      expect(rows[0].cells.map((c) => [c.runId, c.outcome])).toEqual([['r2', 'fail'], ['r1', 'ok']]);
      expect(rows[0].varies).toBeTrue();
      expect(rows[1].cells.map((c) => c.outcome)).toEqual(['skip', 'skip']);
    });

    it('grades each time against the step\'s usual time', () => {
      const runs = [400, 100, 110, 100].map((ms, i) => runSide(cmpRun(`r${i}`, `${i}`, steps, [cmpResult('login', 'COMPLETED', { status: 200 }, { durationMs: ms })])));
      expect(buildMatrix(runs)[0].cells.map((c) => c.time)).toEqual(['slow2', 'even', 'even', 'even']);
    });

    const cell = (outcome: MatrixCell['outcome'], durationMs: number | null = 100): MatrixCell => ({ runId: 'x', outcome, durationMs, time: 'none' });

    it('names what stands out', () => {
      expect(noteFor([cell('fail'), cell('ok'), cell('ok'), cell('ok')])).toBe('first failure in 4 runs');
      expect(noteFor([cell('fail'), cell('fail'), cell('fail'), cell('ok')])).toBe('failing for the last 3 runs');
      expect(noteFor([cell('ok'), cell('fail'), cell('ok')])).toBe('fixed in the newest run');
      expect(noteFor([cell('diff'), cell('ok'), cell('diff'), cell('ok')])).toBe('changes on and off - a flaky answer or a noise field');
      expect(noteFor([cell('ok', 48000), cell('ok', 22000), cell('ok', 21000)])).toBe('twice as slow in the newest run');
      expect(noteFor([cell('ok'), cell('ok'), cell('ok')])).toBeNull();
    });
  });
});
