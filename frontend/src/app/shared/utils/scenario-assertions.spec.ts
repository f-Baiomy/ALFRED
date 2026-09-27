import { Assertion, DraftResult } from './scenario-types';
import { evaluate, diffRuns } from './scenario-assertions';

function draft(overrides: Partial<DraftResult> = {}): DraftResult {
  return {
    key: 'd1',
    attempt: 1,
    status: 200,
    durationMs: 42,
    newCallId: 'c1',
    error: null,
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"currency":"EUR","total":123.5,"items":[{"id":1},{"id":2}]}' },
    extracted: {},
    ...overrides,
  };
}

describe('evaluate (assertions)', () => {
  it('STATUS EQUALS passes/fails correctly', () => {
    const a: Assertion = { kind: 'STATUS', operator: 'EQUALS', value: '200' };
    expect(evaluate([a], draft()).at(0)!.passed).toBeTrue();
    expect(evaluate([a], draft({ status: 500 })).at(0)!.passed).toBeFalse();
  });

  it('STATUS with no response status fails with a clear message', () => {
    const a: Assertion = { kind: 'STATUS', operator: 'EQUALS', value: '200' };
    const result = evaluate([a], draft({ status: null }))[0];
    expect(result.passed).toBeFalse();
    expect(result.message).toContain('No response status');
  });

  it('a draft with an error and no response fails all assertions with a clear message', () => {
    const assertions: Assertion[] = [
      { kind: 'STATUS', operator: 'EQUALS', value: '200' },
      { kind: 'JSON', path: 'currency', operator: 'EXISTS' },
    ];
    const results = evaluate(assertions, draft({ status: null, response: null, error: 'connection refused' }));
    expect(results.every((r) => !r.passed)).toBeTrue();
    expect(results[0].message).toContain('connection refused');
  });

  it('JSON EQUALS on a dotted path', () => {
    const a: Assertion = { kind: 'JSON', path: 'currency', operator: 'EQUALS', value: 'EUR' };
    expect(evaluate([a], draft())[0].passed).toBeTrue();
    const b: Assertion = { kind: 'JSON', path: 'currency', operator: 'EQUALS', value: 'USD' };
    expect(evaluate([a, b], draft())[1].passed).toBeFalse();
  });

  it('JSON GT/LT numeric comparison', () => {
    const gt: Assertion = { kind: 'JSON', path: 'total', operator: 'GT', value: '100' };
    const lt: Assertion = { kind: 'JSON', path: 'total', operator: 'LT', value: '100' };
    expect(evaluate([gt], draft())[0].passed).toBeTrue();
    expect(evaluate([lt], draft())[0].passed).toBeFalse();
  });

  it('JSON wildcard path passes when any item matches', () => {
    const a: Assertion = { kind: 'JSON', path: 'items[*].id', operator: 'EQUALS', value: '2' };
    expect(evaluate([a], draft())[0].passed).toBeTrue();
  });

  it('JSON EXISTS/NOT_EXISTS on a missing path', () => {
    const exists: Assertion = { kind: 'JSON', path: 'missing.path', operator: 'EXISTS' };
    const notExists: Assertion = { kind: 'JSON', path: 'missing.path', operator: 'NOT_EXISTS' };
    expect(evaluate([exists], draft())[0].passed).toBeFalse();
    expect(evaluate([notExists], draft())[0].passed).toBeTrue();
  });

  it('JSON assertion on a non-JSON body fails cleanly', () => {
    const a: Assertion = { kind: 'JSON', path: 'currency', operator: 'EXISTS' };
    const result = evaluate([a], draft({ response: { status: 200, headers: {}, body: 'not json' } }))[0];
    expect(result.passed).toBeFalse();
    expect(result.message).toContain('not valid JSON');
  });

  it('HEADER is case-insensitive', () => {
    const a: Assertion = { kind: 'HEADER', path: 'Content-Type', operator: 'CONTAINS', value: 'json' };
    expect(evaluate([a], draft())[0].passed).toBeTrue();
  });

  it('HEADER NOT_EXISTS on an absent header', () => {
    const a: Assertion = { kind: 'HEADER', path: 'x-nope', operator: 'NOT_EXISTS' };
    expect(evaluate([a], draft())[0].passed).toBeTrue();
  });

  it('LATENCY GT/LT', () => {
    const gt: Assertion = { kind: 'LATENCY', operator: 'GT', value: '10' };
    const lt: Assertion = { kind: 'LATENCY', operator: 'LT', value: '10' };
    expect(evaluate([gt], draft())[0].passed).toBeTrue();
    expect(evaluate([lt], draft())[0].passed).toBeFalse();
  });

  it('MATCHES uses a regex', () => {
    const a: Assertion = { kind: 'JSON', path: 'currency', operator: 'MATCHES', value: '^E.R$' };
    expect(evaluate([a], draft())[0].passed).toBeTrue();
  });

  it('an invalid regex fails rather than throwing', () => {
    const a: Assertion = { kind: 'JSON', path: 'currency', operator: 'MATCHES', value: '(' };
    expect(() => evaluate([a], draft())).not.toThrow();
    expect(evaluate([a], draft())[0].passed).toBeFalse();
  });
});

describe('diffRuns', () => {
  it('reports added/removed/changed JSON fields and status/latency deltas', () => {
    const before: DraftResult[] = [
      draft({ key: 'd1', status: 200, durationMs: 10, response: { status: 200, headers: {}, body: '{"a":1,"b":2}' } }),
    ];
    const after: DraftResult[] = [
      draft({ key: 'd1', status: 500, durationMs: 20, response: { status: 500, headers: {}, body: '{"a":1,"c":3}' } }),
    ];
    const [diff] = diffRuns(before, after);
    expect(diff.statusBefore).toBe(200);
    expect(diff.statusAfter).toBe(500);
    expect(diff.latencyBefore).toBe(10);
    expect(diff.latencyAfter).toBe(20);
    const byPath = Object.fromEntries(diff.fieldChanges.map((c) => [c.path, c.kind]));
    expect(byPath['b']).toBe('removed');
    expect(byPath['c']).toBe('added');
    expect(byPath['a']).toBeUndefined();
  });

  it('reports a draft present in only one run', () => {
    const before: DraftResult[] = [draft({ key: 'd1' })];
    const after: DraftResult[] = [draft({ key: 'd2' })];
    const diffs = diffRuns(before, after);
    expect(diffs.find((d) => d.key === 'd1')!.statusAfter).toBeNull();
    expect(diffs.find((d) => d.key === 'd2')!.statusBefore).toBeNull();
  });
});
