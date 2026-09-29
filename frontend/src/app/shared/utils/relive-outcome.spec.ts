import { ActualCallOutcome, displayedState, explainStep, formatReasonDetail, outcomeOf, StepReason } from './relive-outcome';
import { AssertionResult } from './scenario-types';
import { DifferenceEntry, StepResult, StepState } from './relive-types';

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

  it('is FAILED when a field assertion failed, even if the whole document also mismatched', () => {
    const field: AssertionResult = { assertion: { kind: 'JSON', operator: 'EQUALS', value: '450', path: 'total' }, passed: false, actual: '455', message: 'expected 450' };
    const document: AssertionResult = { assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '' }, passed: false, actual: '{"searchOffers":{}}', message: 'whole body' };
    expect(outcomeOf(actual(), { status: 200 }, [field], noDifferences)).toBe('FAILED');
    expect(outcomeOf(actual(), { status: 200 }, [document, field], noDifferences)).toBe('FAILED');
  });

  it('is COMPLETED_WITH_DIFFERENCES when the only failed check compared the whole JSON document', () => {
    const document: AssertionResult = { assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '' }, passed: false, actual: '{"searchOffers":{"segments":[]}}', message: 'whole body' };
    expect(outcomeOf(actual(), { status: 200 }, [document], noDifferences)).toBe('COMPLETED_WITH_DIFFERENCES');
    const list: AssertionResult = { assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '  ' }, passed: false, actual: '[{"id":1}]', message: 'whole body' };
    expect(outcomeOf(actual(), { status: 200 }, [list], noDifferences)).toBe('COMPLETED_WITH_DIFFERENCES');
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

function settled(
  state: StepState,
  overrides: Partial<Pick<StepResult, 'error' | 'assertions' | 'actualResponse'>> = {},
): Pick<StepResult, 'state' | 'error' | 'assertions' | 'actualResponse'> {
  return { state, error: null, assertions: [], actualResponse: null, ...overrides };
}

const gzipBody = {
  status: 200,
  headers: { 'content-encoding': 'gzip', 'content-type': 'application/json;charset=UTF-8' },
  body: '\u001f',
};

const unreadableJson: AssertionResult = {
  assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '' },
  passed: false,
  actual: '',
  message: 'Response body is not valid JSON.',
};

function said(summary: string, detail: string | null = null): StepReason {
  return { summary, detail };
}

describe('displayedState', () => {
  const document: AssertionResult = {
    assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '' },
    passed: false,
    actual: '{"searchOffers":{"segments":[]}}',
    message: 'JSON path "" was "{"searchOffers":{"segments":[]}}", expected "200".',
  };

  it('shows a stored whole-document mismatch as differences', () => {
    expect(displayedState(settled('FAILED', {
      assertions: [document],
      actualResponse: { status: 200, headers: {}, body: document.actual },
    }), 200)).toBe('COMPLETED_WITH_DIFFERENCES');
  });

  it('keeps a field assertion, a transport error, and an unreadable body as failures', () => {
    const field: AssertionResult = { assertion: { kind: 'JSON', operator: 'EQUALS', value: '450', path: 'total' }, passed: false, actual: '455', message: 'expected 450' };
    expect(displayedState(settled('FAILED', {
      assertions: [field],
      actualResponse: { status: 200, headers: {}, body: '{}' },
    }), 200)).toBe('FAILED');
    expect(displayedState(settled('FAILED', {
      assertions: [document, field],
      actualResponse: { status: 200, headers: {}, body: '{}' },
    }), 200)).toBe('FAILED');
    expect(displayedState(settled('FAILED', { error: 'connection reset', assertions: [document], actualResponse: { status: 200, headers: {}, body: '{}' } }), 200)).toBe('FAILED');
    expect(displayedState(settled('FAILED', { assertions: [unreadableJson], actualResponse: gzipBody }), 200)).toBe('FAILED');
  });
});

describe('explainStep', () => {
  it('says the host answered when a gzip body could not be read as JSON', () => {
    const lines = explainStep(settled('FAILED', { assertions: [unreadableJson], actualResponse: gzipBody }), 200);
    expect(lines).toEqual([
      said('The host answered 200, but the body is still gzip-compressed, so the JSON check could not read it. The check expected the whole body to equal "200".'),
    ]);
  });

  it('keeps a normal assertion message when the body is not gzip', () => {
    const failed: AssertionResult = { assertion: { kind: 'JSON', operator: 'EQUALS', value: '450', path: 'total' }, passed: false, actual: '455', message: 'JSON path "total" was "455", expected "450".' };
    expect(explainStep(settled('FAILED', { assertions: [failed], actualResponse: { status: 200, headers: {}, body: '{}' } }), 200))
      .toEqual([said('JSON path "total" was "455", expected "450".')]);
  });

  it('hides a long actual value behind a short summary', () => {
    const actual = JSON.stringify({
      searchOffers: { segments: Array.from({ length: 30 }, (_, i) => ({ airportCode: 'JED', n: i })) },
    });
    const failed: AssertionResult = {
      assertion: { kind: 'JSON', operator: 'EQUALS', value: '450', path: 'total' },
      passed: false,
      actual,
      message: `JSON path "total" was "${actual}", expected "450".`,
    };
    const [reason] = explainStep(settled('FAILED', { assertions: [failed], actualResponse: { status: 200, headers: {}, body: actual } }), 200);
    expect(reason.summary).toBe('JSON path "total" did not equal "450".');
    expect(reason.summary).not.toContain('searchOffers');
    expect(reason.detail).toBe(actual);
    expect(formatReasonDetail(reason.detail!)).toContain('\n  "searchOffers"');
  });

  it('names a 5xx and a status-class change', () => {
    expect(explainStep(settled('FAILED', { actualResponse: { status: 500, headers: {}, body: '' } }), 201))
      .toEqual([said('The host answered 500; the recording was 201.')]);
    expect(explainStep(settled('FAILED', { actualResponse: { status: 404, headers: {}, body: '' } }), 200))
      .toEqual([said('The host answered 404; the recording was 200.')]);
  });

  it('says when nothing came back, including the stored "no response" error', () => {
    expect(explainStep(settled('FAILED'), 200)).toEqual([said('No response came back.')]);
    expect(explainStep(settled('FAILED', { error: 'no response' }), 200)).toEqual([said('No response came back.')]);
    expect(explainStep(settled('FAILED', { error: 'connection reset' }), 200)).toEqual([said('connection reset')]);
  });

  it('says an unresolved token was not sent', () => {
    expect(explainStep(settled('FAILED', { error: 'unresolved {{bookingId}}' }), 200)).toEqual([said('Not sent: unresolved {{bookingId}}.')]);
  });

  it('shows a skip reason, and why a call was never sent', () => {
    expect(explainStep(settled('SKIPPED', { error: 'Skipped - needs {{$.token}}, which login did not produce' }), 200))
      .toEqual([said('Skipped - needs {{$.token}}, which login did not produce')]);
    expect(explainStep(settled('SKIPPED'), 200)).toEqual([said('Skipped before it was sent.')]);
    expect(explainStep(settled('NOT_CALLED'), 200, 'SKIPPED')).toEqual([said('Not sent. Its parent was skipped.')]);
    expect(explainStep(settled('NOT_CALLED'), 200, 'FAILED')).toEqual([said('Not sent. Its parent failed before this call went out.')]);
    expect(explainStep(settled('NOT_CALLED'), 200, 'COMPLETED')).toEqual([said('Not sent. The parent finished without this call.')]);
    expect(explainStep(settled('NOT_CALLED'), 200)).toEqual([said('This call was not sent.')]);
    expect(explainStep(settled('CANCELLED'), 200)).toEqual([said('Cancelled before it was sent.')]);
  });

  it('says nothing for a completed replay', () => {
    expect(explainStep(settled('COMPLETED', { actualResponse: gzipBody }), 200)).toEqual([]);
    expect(explainStep(settled('COMPLETED_WITH_DIFFERENCES'), 200)).toEqual([]);
  });
});
