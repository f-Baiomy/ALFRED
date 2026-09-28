import { Step, StepResult } from './relive-types';
import { buildHtmlRunReport, buildJsonRunReport, buildMarkdownRunReport, rowsFor } from './relive-run-export';

function step(key: string): Step {
  return {
    key,
    parentKey: null,
    label: `Step ${key}`,
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'odeysys',
    callRule: { name: key, enabled: true, priority: 0, stopProcessing: true, match: {}, actions: [] },
    unattributed: 'BLOCK',
    recording: {
      method: 'POST',
      url: 'https://app.local/x',
      requestHeaders: {},
      requestBody: '{}',
      status: 200,
      responseHeaders: {},
      responseBody: '{}',
      timestamp: 't',
      durationMs: 10,
      sessionId: null,
      operationId: null,
      serviceName: 'odeysys',
      source: 'inbound',
    },
    source: { callId: key, cycleId: null, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function result(stepKey: string, state: StepResult['state'], overrides: Partial<StepResult> = {}): StepResult {
  return {
    runId: 'run-1',
    stepKey,
    attempt: 1,
    state,
    mode: 'REPLAY',
    attribution: 'HEADER',
    differences: [],
    rulesApplied: [],
    variablesUsed: [],
    variablesProduced: [],
    unexpectedCalls: [],
    pauses: [],
    ...overrides,
  };
}

describe('relive-run-export', () => {
  const bigBody = 'x'.repeat(50_000);

  it('markdown report never truncates a step\'s full actual response body', () => {
    const rows = rowsFor([step('s1')], { s1: result('s1', 'FAILED', { actualResponse: { status: 500, headers: {}, body: bigBody } }) });
    const md = buildMarkdownRunReport(rows, 'Book flow', [], {});
    expect(md).toContain(bigBody);
  });

  it('html report never truncates a step\'s full actual response body', () => {
    const rows = rowsFor([step('s1')], { s1: result('s1', 'FAILED', { actualResponse: { status: 500, headers: {}, body: bigBody } }) });
    const html = buildHtmlRunReport(rows, 'Book flow', [], {});
    expect(html).toContain(bigBody);
  });

  it('json report never truncates a step\'s full actual response body', () => {
    const rows = rowsFor([step('s1')], { s1: result('s1', 'FAILED', { actualResponse: { status: 500, headers: {}, body: bigBody } }) });
    const json = buildJsonRunReport('Book flow', rows);
    expect(json).toContain(bigBody);
  });

  it('masks a secret variable\'s value in the md/html reports', () => {
    const rows = rowsFor([step('s1')], { s1: result('s1', 'FAILED', { error: 'token abc123 rejected', actualResponse: { status: 401, headers: {}, body: '{}' } }) });
    const md = buildMarkdownRunReport(rows, 'Book flow', ['token'], { token: 'abc123' });
    expect(md).not.toContain('abc123');
    expect(md).toContain('•');
  });

  it('a step with no result yet shows NOT_CALLED without throwing', () => {
    const rows = rowsFor([step('s1')], {});
    expect(buildMarkdownRunReport(rows, 'Book flow', [], {})).toContain('NOT_CALLED');
    expect(buildHtmlRunReport(rows, 'Book flow', [], {})).toContain('NOT_CALLED');
  });
});
