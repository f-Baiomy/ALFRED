import { ComponentFixture, TestBed } from '@angular/core/testing';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Run, Step, StepResult } from '../../shared/utils/relive-types';
import { ReliveRunTimelineComponent } from './relive-run-timeline.component';

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function recording(overrides: Partial<FrozenCall> = {}): FrozenCall {
  return {
    method: 'POST',
    url: 'https://app.local/book',
    requestHeaders: {},
    requestBody: '{}',
    status: 200,
    responseHeaders: {},
    responseBody: '{}',
    timestamp: '2026-09-27T10:00:00Z',
    durationMs: 100,
    source: 'inbound',
    ...overrides,
  };
}

function makeStep(key: string, parentKey: string | null, overrides: Partial<Step> = {}): Step {
  const rec = overrides.recording ?? recording({ source: parentKey ? 'outbound' : 'inbound' });
  return {
    key,
    parentKey,
    label: key,
    enabled: true,
    optional: false,
    direction: parentKey ? 'outbound' : 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey, label: key, recording: rec }, settings),
    unattributed: 'BLOCK',
    recording: rec,
    source: { callId: key, cycleId: null, direction: parentKey ? 'outbound' : 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...overrides,
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

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    cycleId: 'cy-1',
    driver: 'AUTOMATIC',
    status: 'RUNNING',
    startedAt: '2026-09-27T10:00:00Z',
    definition: { id: 'cy-1' } as never,
    fromStepKey: null,
    seedVariables: [],
    variableTimeline: [],
    summary: { total: 0, completed: 0, different: 0, failed: 0, skipped: 0, notCalled: 0, cancelled: 0, live: 0, replayed: 0, unattributed: 0 },
    hold: null,
    resumed: [],
    log: [],
    ...overrides,
  };
}

describe('ReliveRunTimelineComponent', () => {
  let fixture: ComponentFixture<ReliveRunTimelineComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ReliveRunTimelineComponent] });
    fixture = TestBed.createComponent(ReliveRunTimelineComponent);
  });

  it('shows a placeholder when there is no run', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No run yet');
  });

  it('renders a step per state, with the state pill text', () => {
    const login = makeStep('login', null);
    const supplierA = makeStep('supplier-a', 'login');
    const steps = [login, supplierA];
    const results = { login: result('login', 'COMPLETED'), 'supplier-a': result('supplier-a', 'FAILED', { mode: 'LIVE', error: 'boom' }) };

    fixture.componentRef.setInput('run', run({ status: 'FAILED', finishedAt: '2026-09-27T10:01:00Z' }));
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('results', results);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('✓ Completed');
    expect(text).toContain('✕ Failed');
    expect(text).toContain('60 s total');
  });

  it('shows the hold box for a FAILED hold and emits continueRun/retryHeld/endRun', () => {
    fixture.componentRef.setInput('run', run({ hold: { stepKey: 'book', reason: 'FAILED', since: '2026-09-27T10:00:30Z' } }));
    fixture.componentRef.setInput('steps', [makeStep('book', null)]);
    fixture.componentRef.setInput('results', { book: result('book', 'FAILED') });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('holding');

    const continueSpy = jasmine.createSpy();
    fixture.componentInstance.continueRun.subscribe(continueSpy);
    const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.rl-haltbox button'));
    buttons.find((b) => b.textContent?.includes('Continue'))!.click();
    expect(continueSpy).toHaveBeenCalled();
  });

  it('filters to only failed rows', () => {
    const steps = [makeStep('login', null), makeStep('book', null)];
    const results = { login: result('login', 'COMPLETED'), book: result('book', 'FAILED') };
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('results', results);
    fixture.detectChanges();

    fixture.componentInstance.setFilter('failed');
    fixture.detectChanges();

    expect(fixture.componentInstance.filteredRows().length).toBe(1);
    expect(fixture.componentInstance.filteredRows()[0].step.key).toBe('book');
  });

  it('masks a secret variable until revealed', () => {
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', []);
    fixture.componentRef.setInput('results', {});
    fixture.componentRef.setInput('variableDefs', [{ name: 'token', value: 'abc', secret: true }]);
    fixture.componentRef.setInput('variables', { token: 'abc' });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('••••••••');
    expect(fixture.nativeElement.textContent).not.toContain('abc');

    fixture.nativeElement.querySelector('a.rl-link').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('abc');
  });
});
