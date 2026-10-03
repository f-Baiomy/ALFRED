import { buildCompareReport, buildRunReport, stepNumbers } from './relive-run-report';
import { compareRuns, recordingSide, runSide } from './relive-run-compare';
import { cmpResult, cmpRun, cmpStep } from './relive-run-compare.testing';

const NOW = '2026-10-03T07:12:00Z';

describe('relive-run-report', () => {
  const login = cmpStep('login', { label: 'POST /login', serviceName: 'odeysys' });
  const price = cmpStep('price', { label: 'POST /price', serviceName: 'odeysys' });
  const supplier = cmpStep('price.s', {
    label: 'supplierB /price',
    parentKey: 'price',
    direction: 'outbound',
    recording: { ...cmpStep('x').recording, url: 'http://supplier-b:9003/price', durationMs: 29 },
  });
  const book = cmpStep('book', { label: 'POST /book', serviceName: 'odeysys' });
  const steps = [login, price, supplier, book];

  const failedRun = cmpRun('r1', '2026-10-02T16:33:11Z', steps, [
    cmpResult('login', 'COMPLETED', { status: 200, body: '{"ok":true,"at":"2026-10-02T16:33:12Z"}' }, { durationMs: 398, variablesProduced: [{ name: '$.sid', value: 'SECRET-SID' }] }),
    cmpResult('price', 'FAILED', { status: 502, body: '{"error":"Bad gateway"}' }, { durationMs: 114, variablesUsed: [{ name: '$.sid', value: 'SECRET-SID' }] }),
    cmpResult('price.s', 'FAILED', { status: 502, body: '{"error":"timeout"}' }, { durationMs: 30000 }),
  ], {
    finishedAt: '2026-10-02T16:33:18Z',
    variableTimeline: [{ name: '$.sid', value: 'SECRET-SID', stepKey: 'login', at: 't' }],
    log: [{ at: '2026-10-02T16:33:11.020Z', stepKey: null, kind: 'SENT', message: 'Run started' }, { at: '2026-10-02T16:33:12Z', stepKey: 'price.s', kind: 'ERROR', message: 'supplierB answered 502' }],
  });

  it('numbers steps 1, 2, 2.1, 3 with each supplier call under its parent', () => {
    const report = buildRunReport(failedRun, NOW);
    expect(report.steps.map((s) => [s.number, s.parentNumber])).toEqual([['1', null], ['2', null], ['2.1', '2'], ['3', null]]);
    expect(stepNumbers([]).size).toBe(0);
  });

  it('opens with an answer: where it failed and why, then the counts', () => {
    const report = buildRunReport(failedRun, NOW);
    expect(report.verdict.tone).toBe('bad');
    expect(report.verdict.lead).toBe('Failed at step 2, POST /price:');
    expect(report.verdict.text).toContain('The host answered 502; the recording was 200.');
    expect(report.verdict.text).toContain('1 of 4 steps passed');
    expect(report.counts).toEqual(jasmine.objectContaining({ passed: 1, failed: 2, notRun: 1 }));
  });

  it('explains itself for a reader who was not there', () => {
    const { about, title } = buildRunReport(failedRun, NOW);
    expect(title).toBe('Relive run report: Booking');
    expect(about.whatThisIs).toContain('"Booking" has 3 requests into odeysys');
    expect(about.whatThisIs).toContain('supplier-b:9003');
    expect(about.whatHappened).toContain('Step 2 (POST /price): the host answered 502');
    expect(about.whatHappened).toContain('took 7.0 s');
    expect(about.howToRead).toContain('glossary');
  });

  it('lists what needs attention, failures first', () => {
    const report = buildRunReport(failedRun, NOW);
    expect(report.needsAttention.map((n) => n.number)).toEqual(['2', '2.1']);
  });

  it('a step that did not run says why, with no time or mode of this run', () => {
    const bookStep = buildRunReport(failedRun, NOW).steps.find((s) => s.key === 'book')!;
    expect(bookStep.outcome).toBe('not run');
    expect(bookStep.reasons[0]).toContain('Not run');
    expect(bookStep.durationMs).toEqual({ recorded: 100, run: null });
    expect(bookStep.mode).toBeNull();
    expect(bookStep.recorded.response.status).toBe(200);
  });

  it('lists differences from the recording, noise flagged rather than counted', () => {
    const loginStep = buildRunReport(failedRun, NOW).steps[0];
    expect(loginStep.outcome).toBe('passed');
    expect(loginStep.differences).toEqual([jasmine.objectContaining({ path: 'body.at', noise: true, cause: 'timestamp' })]);
  });

  it('says which step saved each value and which steps used it', () => {
    const report = buildRunReport(failedRun, NOW);
    expect(report.variables).toEqual([{ name: '$.sid', value: 'SECRET-SID', secret: false, savedBy: '1 · POST /login', usedBy: ['2'] }]);
    expect(report.log.map((l) => l.step)).toEqual([null, '2.1']);
  });

  it('a run where everything matched passes', () => {
    const ok = cmpRun('r2', '2026-10-02T15:00:00Z', [login], [cmpResult('login', 'COMPLETED', { status: 200 })]);
    const report = buildRunReport(ok, NOW);
    expect(report.verdict).toEqual(jasmine.objectContaining({ tone: 'good', lead: 'Passed:' }));
    expect(report.about.whatHappened).toContain('Every step answered like the recording.');
  });

  describe('the comparison', () => {
    it('describes both sides, numbers the rows, and explains what changed', () => {
      const a = runSide(cmpRun('ra', '2026-10-02T13:49:19Z', steps, [cmpResult('login', 'COMPLETED', { status: 200 }), cmpResult('price', 'COMPLETED', { status: 200 })]));
      const b = runSide(failedRun);
      const report = buildCompareReport(compareRuns(a, b, () => []), a, b, 'Booking', NOW);
      expect(report.title).toBe('Relive run comparison: Booking');
      expect(report.a).toEqual(jasmine.objectContaining({ slot: 'A', role: 'before', runId: 'ra' }));
      expect(report.rows.map((r) => r.number)).toEqual(['1', '2', '2.1', '3']);
      expect(report.verdict.tone).toBe('bad');
      expect(report.about.whatHappened).toContain('Step 2 (POST /price)');
      expect(report.about.whatHappened).toContain('failed in B but not in A');
    });

    it('against the recording, side A is the recording', () => {
      const b = runSide(failedRun);
      const report = buildCompareReport(compareRuns(recordingSide(b), b, () => []), recordingSide(b), b, 'Booking', NOW);
      expect(report.a.isRecording).toBeTrue();
      expect(report.about.whatThisIs).toContain('compared with what was originally recorded');
    });
  });
});
