import { ComponentFixture, TestBed } from '@angular/core/testing';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Step, StepResult } from '../../shared/utils/relive-types';
import { ReliveResultPanelComponent, ShownDifference } from './relive-result-panel.component';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{"origin":"DXB"}',
  status: 200,
  responseHeaders: {},
  responseBody: '{"results":12}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 420,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

const step: Step = {
  key: 'c-supA',
  parentKey: 's-search',
  label: 'POST /v2/search',
  enabled: true,
  optional: false,
  direction: 'outbound',
  serviceName: 'odeysys',
  callRule: defaultCallRule({ key: 'c-supA', parentKey: 's-search', label: 'POST /v2/search', recording }, settings),
  unattributed: 'BLOCK',
  recording,
  source: { callId: 'call-1', cycleId: null, direction: 'outbound' },
  extract: [
    { from: 'JSON', path: '$.results', as: 'count', missing: 'SKIP' },
    { from: 'JSON', path: '$.searchId', as: 'searchId', missing: 'SKIP' },
  ],
  assertions: [],
  noise: [],
};

function makeResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    runId: 'run-1',
    stepKey: 'c-supA',
    attempt: 2,
    state: 'COMPLETED_WITH_DIFFERENCES',
    mode: 'REPLAY',
    attribution: 'INFLIGHT',
    actualRequest: { method: 'POST', url: recording.url, headers: {}, body: '{"origin":"AUH"}' },
    actualResponse: { status: 200, headers: {}, body: '{"results":11,"token":"eyJhbGciOi9f2"}' },
    differences: [],
    rulesApplied: [{ ruleId: 'r1', name: 'Currency → AED', tier: 'GLOBAL', actions: ['response body rewritten'] }],
    variablesUsed: [{ name: 'token', value: 'eyJhbGciOi9f2' }],
    variablesProduced: [{ name: 'count', value: '11' }],
    durationMs: 12,
    error: null,
    unexpectedCalls: [],
    pauses: [],
    assertions: [
      { assertion: { kind: 'STATUS', operator: 'EQUALS', value: '200' }, passed: true, actual: '200', message: '' },
      { assertion: { kind: 'JSON', path: '$.results', operator: 'EQUALS', value: '12' }, passed: false, actual: '11', message: 'expected 12' },
    ],
    ...overrides,
  } as StepResult;
}

const diff: ShownDifference = { path: 'body.results', recorded: '12', actual: '11', part: 'body', kind: 'UNEXPECTED' };

describe('ReliveResultPanelComponent', () => {
  let fixture: ComponentFixture<ReliveResultPanelComponent>;
  let panel: ReliveResultPanelComponent;

  beforeEach(() => {
    fixture = TestBed.createComponent(ReliveResultPanelComponent);
    panel = fixture.componentInstance;
    fixture.componentRef.setInput('step', step);
    fixture.componentRef.setInput('result', makeResult());
    fixture.componentRef.setInput('differences', [diff]);
    fixture.componentRef.setInput('variableDefs', [{ name: 'token', value: 'eyJhbGciOi9f2', secret: true }]);
    fixture.componentRef.setInput('variables', { token: 'eyJhbGciOi9f2' });
    fixture.detectChanges();
  });

  const text = (): string => fixture.nativeElement.textContent;

  it('opens on the Response box for a step with differences, with the strip and summary', () => {
    expect(panel.box()).toBe('response');
    expect(text()).toContain('Relived from the recording');
    expect(text()).toContain('attempt 2 · REPLAY · 1 rule · 1 difference · 1 check failed');
    expect(fixture.nativeElement.querySelectorAll('.resend-flow-node').length).toBe(8);
  });

  it('lists the differences with ignore and count actions', () => {
    const ignored: { diff: ShownDifference; scope: string }[] = [];
    panel.ignore.subscribe((e) => ignored.push(e));
    const button = Array.from(fixture.nativeElement.querySelectorAll('.rl-drow button') as NodeListOf<HTMLButtonElement>).find((b) => b.textContent!.includes('Ignore in cycle'))!;
    button.click();
    expect(ignored).toEqual([{ diff, scope: 'CYCLE' }]);

    fixture.componentRef.setInput('markedPaths', new Set(['c-supA|body.results']));
    fixture.detectChanges();
    expect(text()).toContain('marked - counts from the next run');
  });

  it('shows rules applied, variables used (masked) and the values box', () => {
    panel.select('rules');
    fixture.detectChanges();
    expect(text()).toContain('Currency → AED');

    panel.select('variables');
    fixture.detectChanges();
    expect(text()).not.toContain('eyJhbGciOi9f2');

    panel.select('values');
    fixture.detectChanges();
    expect(text()).toContain('missing - not set');
    expect(text()).toContain('✓ passed');
    expect(text()).toContain('✗ expected 12');
  });

  it('diffs the recording against this run with the interception panel, request and response', () => {
    expect(fixture.nativeElement.querySelector('app-interception-panel')).toBeTruthy();
    expect(panel.compare().finalRequest!.body).toBe('{"origin":"AUH"}');
    expect(panel.compare().finalResponse!.body).not.toContain('eyJhbGciOi9f2');
  });

  it('opens on the Recorded call box for a step that completed', () => {
    fixture.componentRef.setInput('result', makeResult({ state: 'COMPLETED' }));
    fixture.detectChanges();
    expect(panel.box()).toBe('recorded');
  });
});
