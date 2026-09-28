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

  it('T074: shows the "saved" badge and banner for a LIVE child that got an actual response', () => {
    const login = makeStep('login', null);
    const supplierA = makeStep('supplier-a', 'login');
    const results = {
      login: result('login', 'COMPLETED'),
      'supplier-a': result('supplier-a', 'COMPLETED', { mode: 'LIVE', actualResponse: { status: 200, headers: {}, body: '{}' } }),
    };

    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', [login, supplierA]);
    fixture.componentRef.setInput('results', results);
    fixture.detectChanges();

    expect(fixture.componentInstance.wasSavedLive(results['supplier-a'])).toBeTrue();
    expect(fixture.componentInstance.wasSavedLive(results['login'])).toBeFalse();
    expect(fixture.componentInstance.savedLiveCount()).toBe(1);
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('💾 saved');
    expect(text).toContain('1 call reached a real system');
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

  it('T056: shows the unexpected-calls card only when there is at least one', () => {
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', []);
    fixture.componentRef.setInput('results', {});
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Unexpected outbound calls');

    fixture.componentRef.setInput('unexpectedCalls', [{ callId: 'call-x', direction: 'outbound', at: '2026-09-27T10:00:00Z' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Unexpected outbound calls (1)');
    expect(fixture.nativeElement.textContent).toContain('call-x');
  });

  it('T056: shows a request-changed pause banner and emits openPausedCall for it', () => {
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', []);
    fixture.componentRef.setInput('results', {});
    fixture.componentRef.setInput('changedPauses', [
      { callId: 'call-y', phase: 'request', source: 'outbound', method: 'GET', url: 'https://api.supplier-a.com/fares', timeoutSeconds: 30, pausedAt: Date.now() },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('held - the request changed');
    expect(fixture.nativeElement.textContent).toContain('api.supplier-a.com/fares');

    const openSpy = jasmine.createSpy();
    fixture.componentInstance.openPausedCall.subscribe(openSpy);
    fixture.nativeElement.querySelector('.rl-pausebox button').click();
    expect(openSpy).toHaveBeenCalledWith('call-y');
  });

  it('T058: shows the checkpoint pause box for a BEFORE pause (no Replay button) and emits decisions', () => {
    const login = makeStep('login', null);
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', [login]);
    fixture.componentRef.setInput('results', { login: result('login', 'PAUSED') });
    fixture.componentRef.setInput('pause', { stepKey: 'login', at: 'BEFORE' });
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Paused before');
    expect(text).toContain('login');
    expect(text).not.toContain('↻ Replay');

    const continueSpy = jasmine.createSpy();
    fixture.componentInstance.checkpointContinue.subscribe(continueSpy);
    const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.rl-pausebox button'));
    buttons.find((b) => b.textContent?.includes('Continue'))!.click();
    expect(continueSpy).toHaveBeenCalled();
  });

  it('T058: shows Replay for an AFTER pause and emits checkpointReplay/checkpointSkip', () => {
    const login = makeStep('login', null);
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', [login]);
    fixture.componentRef.setInput('results', { login: result('login', 'PAUSED', { attempt: 1, durationMs: 120 }) });
    fixture.componentRef.setInput('pause', { stepKey: 'login', at: 'AFTER' });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Paused after');

    const replaySpy = jasmine.createSpy();
    const skipSpy = jasmine.createSpy();
    fixture.componentInstance.checkpointReplay.subscribe(replaySpy);
    fixture.componentInstance.checkpointSkip.subscribe(skipSpy);
    const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('.rl-pausebox button'));
    buttons.find((b) => b.textContent?.includes('Replay'))!.click();
    buttons.find((b) => b.textContent?.trim() === 'Skip')!.click();
    expect(replaySpy).toHaveBeenCalled();
    expect(skipSpy).toHaveBeenCalled();
  });

  describe('T075: canRunFromStep', () => {
    function bookStepNeeding(name: string): Step {
      return makeStep('book', null, {
        callRule: { name: 'book', enabled: true, priority: 0, stopProcessing: true, match: {}, actions: [{ type: 'SET_REQUEST_HEADER', name: 'X', value: `{{${name}}}`, enabled: true }] },
      });
    }

    it('refuses when a needed variable is neither defined nor available yet', () => {
      const book = bookStepNeeding('bookingId');
      fixture.componentRef.setInput('run', run());
      fixture.componentRef.setInput('steps', [book]);
      fixture.componentRef.setInput('results', { book: result('book', 'PENDING') });
      fixture.detectChanges();

      const check = fixture.componentInstance.canRunFromStep('book');
      expect(check.ok).toBeFalse();
      expect(check.reason).toContain('bookingId');
    });

    it('allows it once the variable is available (defined, or produced by an earlier step)', () => {
      const book = bookStepNeeding('bookingId');
      fixture.componentRef.setInput('run', run());
      fixture.componentRef.setInput('steps', [book]);
      fixture.componentRef.setInput('results', { book: result('book', 'PENDING') });
      fixture.componentRef.setInput('variables', { bookingId: 'B-1' });
      fixture.detectChanges();

      expect(fixture.componentInstance.canRunFromStep('book').ok).toBeTrue();
    });
  });
});
