import { checkResults, foundLine, missLines, stepChecks, tally, StepChecks } from './relive-checks';

describe('relive checks', () => {
  it('reads older assertions as one all-of group with the same meaning', () => {
    const checks = stepChecks([
      { kind: 'STATUS', operator: 'EQUALS', value: '200' },
      { kind: 'JSON', path: '$.journeys', operator: 'GT', value: '1' },
      { kind: 'HEADER', path: 'X-Ref', operator: 'EXISTS' },
      { kind: 'LATENCY', operator: 'LT', value: '2000' },
    ]);
    expect(checks.onMiss).toBe('FAIL');
    expect(checks.groups.length).toBe(1);
    expect(checks.groups[0].conditions).toEqual([
      { subject: 'RESPONSE_STATUS', operator: 'EQUALS', value: '200' },
      { subject: 'RESPONSE_JSON_FIELD', name: 'journeys', operator: 'AT_LEAST', value: '2' },
      { subject: 'RESPONSE_HEADER', name: 'X-Ref', operator: 'EXISTS', value: null },
      { subject: 'RESPONSE_TIME', operator: 'AT_MOST', value: '1999' },
    ]);
  });

  it('keeps checks that are already groups, and reads nothing as no checks', () => {
    const own: StepChecks = { version: 2, onMiss: 'WARN', groups: [] };
    expect(stepChecks(own)).toBe(own);
    expect(stepChecks([]).groups).toEqual([]);
    expect(stepChecks(undefined).groups).toEqual([]);
  });

  const checks: StepChecks = {
    version: 2,
    onMiss: 'FAIL',
    groups: [
      { combine: 'ALL', onMiss: 'DEFAULT', conditions: [{ subject: 'RESPONSE_STATUS', operator: 'EQUALS', value: '200' }] },
      { combine: 'ANY', onMiss: 'FAIL', conditions: [
        { subject: 'RESPONSE_JSON_FIELD', name: 'a', operator: 'EQUALS', value: '1' },
        { subject: 'RESPONSE_JSON_FIELD', name: 'b', operator: 'EQUALS', value: '2' },
      ] },
      { combine: 'ALL', onMiss: 'WARN', conditions: [{ subject: 'RESPONSE_TIME', operator: 'AT_MOST', value: '5000' }] },
    ],
  };

  it('joins the proxy verdicts to their groups and counts passes, failures and warnings', () => {
    const results = checkResults(checks, [
      { passed: true, rows: [{ holds: true }] },
      { passed: false, rows: [{ holds: false }, { holds: false }] },
      { passed: false, rows: [{ holds: false }] },
    ]);
    expect(results.groups.map((g) => g.onMiss)).toEqual(['FAIL', 'FAIL', 'WARN']);
    expect(tally(results)).toEqual({ passed: 1, failed: 1, warned: 1 });
    expect(missLines(results)).toEqual([
      { failed: true, text: 'Check 2 failed - none of: Response JSON field a equals 1 OR Response JSON field b equals 2' },
      { failed: false, text: 'Check 3 warning - Response time (ms) is at most 5000' },
    ]);
  });

  it('counts every group as missed when the checks could not be evaluated', () => {
    const results = checkResults(checks, null, 'the proxy could not evaluate the checks');
    expect(tally(results)).toEqual({ passed: 0, failed: 2, warned: 1 });
    expect(results.groups[0].rows[0]).toEqual({ holds: false, error: 'the proxy could not evaluate the checks' });
  });

  it('says what a condition found', () => {
    expect(foundLine({ holds: true, found: { values: ['200'] } })).toBe('got 200');
    expect(foundLine({ holds: false, found: { values: [] } })).toBe('not found');
    expect(foundLine({ holds: false, found: { fields: [{ path: 'journeys[*].origin', count: 3, values: ['CAI', 'AUH', 'CAI'], itemHolds: [true, false, true] }] } }))
      .toBe('journeys[*].origin: 3 items · 1 do not match');
    expect(foundLine({ holds: false, error: 'not a valid check' })).toBe('not a valid check');
  });
});
