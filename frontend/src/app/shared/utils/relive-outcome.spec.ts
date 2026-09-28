import { ActualCallOutcome, outcomeOf } from './relive-outcome';
import { AssertionResult } from './scenario-types';
import { DifferenceEntry } from './relive-types';

function actual(overrides: Partial<ActualCallOutcome> = {}): ActualCallOutcome {
  return { transportError: false, timedOut: false, noAnswer: false, status: 200, ...overrides };
}

const noAssertions: readonly AssertionResult[] = [];
const noDifferences: readonly DifferenceEntry[] = [];

describe('outcomeOf', () => {
  it('is FAILED on a transport error', () => {
    expect(outcomeOf(actual({ transportError: true }), { status: 200 }, noAssertions, noDifferences)).toBe('FAILED');
  });

  it('is FAILED on a timeout', () => {
    expect(outcomeOf(actual({ timedOut: true }), { status: 200 }, noAssertions, noDifferences)).toBe('FAILED');
  });

  it('is FAILED when no answer was received', () => {
    expect(outcomeOf(actual({ noAnswer: true, status: null }), { status: 200 }, noAssertions, noDifferences)).toBe('FAILED');
  });

  it('is FAILED on any 5xx response, per the clarification example: 201 -> 500 is red', () => {
    expect(outcomeOf(actual({ status: 500 }), { status: 201 }, noAssertions, noDifferences)).toBe('FAILED');
  });

  it('is FAILED on a status class change even without a 5xx (2xx -> 4xx)', () => {
    expect(outcomeOf(actual({ status: 404 }), { status: 200 }, noAssertions, noDifferences)).toBe('FAILED');
  });

  it('is FAILED when an assertion failed', () => {
    const failedAssertion: AssertionResult = { assertion: {} as never, passed: false, actual: '455', message: 'expected 450' };
    expect(outcomeOf(actual(), { status: 200 }, [failedAssertion], noDifferences)).toBe('FAILED');
  });

  it('is COMPLETED_WITH_DIFFERENCES on an unexpected difference, per the clarification example: Price 450 -> 455 is yellow', () => {
    const diff: DifferenceEntry = { part: 'body', path: 'total', recorded: '450', actual: '455', kind: 'UNEXPECTED', cause: null };
    expect(outcomeOf(actual(), { status: 200 }, noAssertions, [diff])).toBe('COMPLETED_WITH_DIFFERENCES');
  });

  it('is COMPLETED when an expected or noise difference is the only one present', () => {
    const diff: DifferenceEntry = { part: 'body', path: 'requestTime', recorded: 't1', actual: 't2', kind: 'NOISE_AUTO', cause: null };
    expect(outcomeOf(actual(), { status: 200 }, noAssertions, [diff])).toBe('COMPLETED');
  });

  it('is COMPLETED with no differences and a passing status/assertions', () => {
    expect(outcomeOf(actual(), { status: 200 }, noAssertions, noDifferences)).toBe('COMPLETED');
  });
});
