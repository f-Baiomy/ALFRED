import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
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
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => undefined;
    }
    spyOn(HTMLElement.prototype, 'scrollIntoView');
    TestBed.configureTestingModule({
      imports: [ReliveRunTimelineComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    fixture = TestBed.createComponent(ReliveRunTimelineComponent);
  });

  it('keeps a running timeline on the step it is holding, and scrolls that row into view', fakeAsync(() => {
    const steps = [makeStep('login', null), makeStep('search', null), makeStep('next', null)];
    fixture.componentRef.setInput('run', run({
      hold: { stepKey: 'search', reason: 'FAILED', since: '2026-09-29T13:36:53Z' },
    }));
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('results', {
      login: result('login', 'COMPLETED'),
      search: result('search', 'FAILED'),
    });
    fixture.detectChanges();
    tick(0);
    expect(fixture.componentInstance.trackKey()).toBe('search');
    const row = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    expect(row.classList).toContain('rl-here');
    expect(row.scrollIntoView).toHaveBeenCalled();
    fixture.destroy();
  }));

  it('after a reload interrupts the run, tracks the first step that was cancelled', fakeAsync(() => {
    const steps = [makeStep('login', null), makeStep('search', null)];
    fixture.componentRef.setInput('run', run({ status: 'INTERRUPTED' }));
    fixture.componentRef.setInput('steps', steps);
    fixture.componentRef.setInput('results', {
      login: result('login', 'COMPLETED'),
      search: result('search', 'CANCELLED'),
    });
    fixture.detectChanges();
    tick(0);
    expect(fixture.componentInstance.trackKey()).toBe('search');
    const row = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    expect(row.classList).toContain('rl-here');
    expect(row.scrollIntoView).toHaveBeenCalled();
    fixture.destroy();
  }));

  it('outlines a held call together with its children until the decision is made', () => {
    const search = makeStep('search', null);
    const supplier = makeStep('supplier', 'search');
    const next = makeStep('next', null);
    fixture.componentRef.setInput('run', run({
      hold: { stepKey: 'search', reason: 'DIFFERENCES', since: '2026-09-29T13:36:53Z' },
    }));
    fixture.componentRef.setInput('steps', [search, supplier, next]);
    fixture.componentRef.setInput('results', {
      search: result('search', 'COMPLETED_WITH_DIFFERENCES'),
      supplier: result('supplier', 'NOT_CALLED'),
      next: result('next', 'PENDING'),
    });
    fixture.detectChanges();

    const outline = fixture.nativeElement.querySelector('.rl-awaiting') as HTMLElement;
    expect(outline).not.toBeNull();
    expect(outline.querySelector('[data-step-key="search"]')).not.toBeNull();
    expect(outline.querySelector('[data-step-key="supplier"]')).not.toBeNull();
    expect(outline.querySelector('[data-step-key="next"]')).toBeNull();

    fixture.componentRef.setInput('run', run());
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rl-awaiting')).toBeNull();
  });

  it('outlines a checkpoint pause with its children, and drops it once the pause is gone', () => {
    const login = makeStep('login', null);
    const supplier = makeStep('supplier', 'login');
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', [login, supplier]);
    fixture.componentRef.setInput('results', {
      login: result('login', 'PAUSED'),
      supplier: result('supplier', 'PENDING'),
    });
    fixture.componentRef.setInput('pause', { stepKey: 'login', at: 'BEFORE' });
    fixture.detectChanges();

    const outline = fixture.nativeElement.querySelector('.rl-awaiting') as HTMLElement;
    expect(outline.querySelector('[data-step-key="login"]')).not.toBeNull();
    expect(outline.querySelector('[data-step-key="supplier"]')).not.toBeNull();

    fixture.componentRef.setInput('pause', null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rl-awaiting')).toBeNull();
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

  it('keeps a hold decision on screen, naming the step, without hiding the banner', () => {
    const search = makeStep('search', null, { label: 'flight-search' });
    fixture.componentRef.setInput('pinnedDecision', true);
    fixture.componentRef.setInput('run', run({ hold: { stepKey: 'search', reason: 'DIFFERENCES', since: '2026-09-27T10:00:30Z' } }));
    fixture.componentRef.setInput('steps', [search]);
    fixture.componentRef.setInput('results', { search: result('search', 'COMPLETED_WITH_DIFFERENCES') });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.rl-haltbox')).not.toBeNull();
    const bar: HTMLElement = fixture.nativeElement.querySelector('.rl-decision');
    expect(bar).not.toBeNull();
    expect(bar.classList).toContain('rl-diff');
    expect(bar.textContent).toContain('Holding on');
    expect(bar.textContent).toContain('flight-search');
    expect(bar.textContent).toContain('differences');

    const continueSpy = jasmine.createSpy();
    const retrySpy = jasmine.createSpy();
    const endSpy = jasmine.createSpy();
    fixture.componentInstance.continueRun.subscribe(continueSpy);
    fixture.componentInstance.retryHeld.subscribe(retrySpy);
    fixture.componentInstance.endRun.subscribe(endSpy);
    const buttons: HTMLButtonElement[] = Array.from(bar.querySelectorAll('button'));
    buttons.find((b) => b.textContent?.includes('Retry'))!.click();
    buttons.find((b) => b.textContent?.includes('Continue'))!.click();
    buttons.find((b) => b.textContent?.includes('End run'))!.click();
    expect(retrySpy).toHaveBeenCalled();
    expect(continueSpy).toHaveBeenCalled();
    expect(endSpy).toHaveBeenCalled();
  });

  it('keeps a checkpoint pause on screen, and offers Replay only after the call', () => {
    const login = makeStep('login', null, { label: 'loginAction' });
    fixture.componentRef.setInput('pinnedDecision', true);
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', [login]);
    fixture.componentRef.setInput('results', { login: result('login', 'PAUSED') });
    fixture.componentRef.setInput('pause', { stepKey: 'login', at: 'BEFORE' });
    fixture.detectChanges();

    let bar: HTMLElement = fixture.nativeElement.querySelector('.rl-decision');
    expect(bar.textContent).toContain('Paused before');
    expect(bar.textContent).toContain('loginAction');
    expect(bar.textContent).not.toContain('Replay');
    const continueSpy = jasmine.createSpy();
    fixture.componentInstance.checkpointContinue.subscribe(continueSpy);
    (bar.querySelectorAll('button')[0] as HTMLButtonElement).click();
    expect(continueSpy).toHaveBeenCalled();

    fixture.componentRef.setInput('pause', { stepKey: 'login', at: 'AFTER' });
    fixture.detectChanges();
    bar = fixture.nativeElement.querySelector('.rl-decision');
    expect(bar.textContent).toContain('Paused after');
    const replaySpy = jasmine.createSpy();
    const skipSpy = jasmine.createSpy();
    fixture.componentInstance.checkpointReplay.subscribe(replaySpy);
    fixture.componentInstance.checkpointSkip.subscribe(skipSpy);
    const buttons: HTMLButtonElement[] = Array.from(bar.querySelectorAll('button'));
    buttons.find((b) => b.textContent?.includes('Replay'))!.click();
    buttons.find((b) => b.textContent?.trim() === 'Skip')!.click();
    expect(replaySpy).toHaveBeenCalled();
    expect(skipSpy).toHaveBeenCalled();
  });

  it('leaves the pinned bar off a history snapshot', () => {
    fixture.componentRef.setInput('run', run({ hold: { stepKey: 'search', reason: 'FAILED', since: '2026-09-27T10:00:30Z' } }));
    fixture.componentRef.setInput('steps', [makeStep('search', null)]);
    fixture.componentRef.setInput('results', { search: result('search', 'FAILED') });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rl-decision')).toBeNull();
    expect(fixture.nativeElement.querySelector('.rl-haltbox')).not.toBeNull();
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

  function held(at: 'CHANGED' | 'BEFORE' | 'AFTER', phase: 'request' | 'response' = 'request') {
    return {
      callId: 'call-y', phase, source: 'outbound', method: 'GET', url: 'https://api.supplier-a.com/fares',
      timeoutSeconds: 30, pausedAt: Date.now(), relive: { runId: 'r-1', stepKey: null, at },
    } as const;
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.rl-held button')) as HTMLButtonElement[];
  }

  function click(label: string): void {
    const button = buttons().find((b) => b.textContent!.includes(label));
    expect(button).withContext(label).toBeTruthy();
    button!.click();
    fixture.detectChanges();
  }

  it('T056/T103: decides a request-changed hold in the run view', () => {
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', []);
    fixture.componentRef.setInput('results', {});
    fixture.componentRef.setInput('changedPauses', [held('CHANGED')]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Request changed');
    expect(fixture.nativeElement.textContent).toContain('mocked failure in');
    const decisions: unknown[] = [];
    fixture.componentInstance.decidePaused.subscribe((d) => decisions.push(d));

    click('Replay recorded answer');
    click('Send to real');
    expect(decisions.length).withContext('Send to real needs a second confirmation').toBe(1);
    click('Yes, contact the real supplier');
    click('Mock a failure');

    expect(decisions).toEqual([
      { callId: 'call-y', decision: { action: 'release', relive: 'REPLAY' } },
      { callId: 'call-y', decision: { action: 'release', relive: 'SEND_REAL' } },
      { callId: 'call-y', decision: { action: 'release', relive: 'FAIL' } },
    ]);
  });

  it('T103: a held child checkpoint offers Continue and Skip, and answers can be edited', () => {
    fixture.componentRef.setInput('run', run());
    fixture.componentRef.setInput('steps', []);
    fixture.componentRef.setInput('results', {});
    fixture.componentRef.setInput('changedPauses', [held('BEFORE')]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('continues in');
    const decisions: unknown[] = [];
    fixture.componentInstance.decidePaused.subscribe((d) => decisions.push(d));
    click('Continue');
    click('Skip');
    expect(decisions).toEqual([
      { callId: 'call-y', decision: { action: 'release' } },
      { callId: 'call-y', decision: { action: 'release', relive: 'FAIL' } },
    ]);

    fixture.componentRef.setInput('changedPauses', [held('CHANGED')]);
    fixture.detectChanges();
    click('Edit answer');
    fixture.componentInstance.setEditStatus('201');
    fixture.componentInstance.setEditBody('{"edited":true}');
    fixture.detectChanges();
    click('Answer with this');
    expect(decisions[2]).toEqual({ callId: 'call-y', decision: { action: 'release', relive: 'ANSWER', status: 201, body: '{"edited":true}' } });
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

  it('opens the shared call card under a row for a finished, failed, running, or interrupted step', () => {
    const login = makeStep('login', null, { label: 'loginAction' });
    const search = makeStep('search', null, { label: 'flight-search' });
    fixture.componentRef.setInput('run', run({ status: 'INTERRUPTED' }));
    fixture.componentRef.setInput('steps', [login, search]);
    fixture.componentRef.setInput('results', {
      login: result('login', 'COMPLETED', {
        durationMs: 81,
        actualRequest: { headers: { Accept: 'application/json' }, body: '{"from":"DXB"}' },
        actualResponse: { status: 200, headers: {}, body: '{"ok":true}' },
      }),
      search: result('search', 'CANCELLED'),
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-call-card')).toBeNull();

    const selected = jasmine.createSpy();
    fixture.componentInstance.selectStep.subscribe(selected);
    (fixture.nativeElement.querySelector('[data-step-key="login"]') as HTMLElement).click();
    fixture.detectChanges();

    const http = TestBed.inject(HttpTestingController);
    const listed = http.expectOne((req) => req.url.includes('/internal-calls') && req.params.get('operationId') === 'relive-run-1-login');
    listed.flush({
      calls: [{
        id: '3acadc40-1111-2222-3333-444444444444',
        original_url: 'http://localhost:8080/odeysysadmin/Admin2/loginAction',
        url: 'http://host.docker.internal:9001/odeysysadmin/Admin2/loginAction',
        method: 'POST',
        timestamp: '2026-09-29T18:22:33Z',
        duration_ms: 2412,
        status: 200,
        service_name: 'odeysys',
        state: 'COMPLETED',
        operation_id: 'relive-run-1-login',
        resend_of: 'bf7dc95e-1111-2222-3333-444444444444',
        resend_edits: { headers: ['Host', 'Cookie', 'Accept', 'Origin', 'Referer', 'User-Agent', 'Content-Type', 'Content-Length', 'Connection', 'Accept-Language', 'Accept-Encoding', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest'], body: true },
        interception: { applied: [{ action: 'SET_REQUEST_HEADER' }, { action: 'SET_RESPONSE_BODY' }], originalRequest: { method: 'POST', url: 'http://host.docker.internal:9001/odeysysadmin/Admin2/loginAction', headers: {} } },
      }],
      total: 1,
    });
    fixture.detectChanges();

    expect(selected).toHaveBeenCalledWith('login');
    const detail = fixture.nativeElement.querySelector('.rl-step-detail') as HTMLElement;
    expect(detail.querySelector('app-call-card')).not.toBeNull();
    expect(detail.textContent).toContain('200');
    expect(detail.textContent).toContain('2412 ms');
    expect(detail.textContent).toContain('intercepted');
    expect(detail.textContent).toContain('Resent from a Live Calls call');
    expect(detail.textContent).toContain('2 changes: 17 headers · body');
    expect(detail.textContent).toContain('show the whole cycle');
    expect(detail.textContent).toContain('resend of bf7dc95e');
    expect(detail.textContent).toContain('3acadc40');
    const bodyChips = Array.from(detail.querySelectorAll('button.block-chip')).filter((button) => button.textContent?.includes('Body')) as HTMLButtonElement[];
    const bodyChip = bodyChips[bodyChips.length - 1];
    bodyChip.click();
    fixture.detectChanges();
    http.match((req) => req.url.includes('/comments')).forEach((req) => req.flush([]));
    const detailReq = http.expectOne((req) => req.url.includes('/internal-calls/3acadc40-1111-2222-3333-444444444444/detail'));
    expect(detailReq.request.params.get('part')).toBe('response-body');
    detailReq.flush({ response: { status: 200, body: '{"viewForm":"redirect:/Dashboard/dashboard"}' } });
    fixture.detectChanges();
    expect(detail.textContent).toContain('viewForm');

    (fixture.nativeElement.querySelector('[data-step-key="login"]') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-relive-step-call')).toBeNull();

    (fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement).click();
    fixture.detectChanges();
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.includes('/internal-calls'))
      .flush({ calls: [], total: 0 });
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.endsWith('/calls'))
      .flush({ calls: [], total: 0 });
    fixture.detectChanges();
    const fallback = fixture.nativeElement.querySelector('.rl-step-detail') as HTMLElement;
    expect(fallback.querySelector('app-call-card')).not.toBeNull();
  });

  it('shows why a step failed, was skipped, or was not sent', () => {
    const search = makeStep('search', null, { label: 'flight-search' });
    const supplier = makeStep('supplier', 'search');
    const later = makeStep('later', null);
    fixture.componentRef.setInput('run', run({ status: 'FAILED', finishedAt: '2026-09-27T10:01:00Z' }));
    fixture.componentRef.setInput('steps', [search, supplier, later]);
    fixture.componentRef.setInput('results', {
      search: result('search', 'FAILED', {
        mode: 'LIVE',
        durationMs: 4134,
        actualResponse: {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
          body: '\u001f',
        },
        assertions: [{
          assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '' },
          passed: false,
          actual: '',
          message: 'Response body is not valid JSON.',
        }],
      }),
      supplier: result('supplier', 'NOT_CALLED'),
      later: result('later', 'SKIPPED', { error: 'Skipped - needs {{$.token}}, which flight-search did not produce' }),
    });
    fixture.detectChanges();

    const searchRow = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    const reason = 'The host answered 200, but the body is still gzip-compressed, so the JSON check could not read it. The check expected the whole body to equal "200".';
    expect(fixture.nativeElement.textContent).not.toContain(reason);
    expect(fixture.nativeElement.textContent).not.toContain('Not sent. Its parent failed before this call went out.');
    expect(fixture.nativeElement.textContent).not.toContain('Skipped - needs {{$.token}}, which flight-search did not produce');
    expect(searchRow.querySelector('.rl-p-fail')?.getAttribute('title')).toBe(reason);
    expect(fixture.nativeElement.querySelector('[data-step-key="later"] .rl-p-wait')?.getAttribute('title'))
      .toBe('Skipped - needs {{$.token}}, which flight-search did not produce');

    searchRow.click();
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.includes('/internal-calls'))
      .flush({ calls: [], total: 0 });
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.endsWith('/calls'))
      .flush({ calls: [], total: 0 });
    fixture.detectChanges();

    const detail = fixture.nativeElement.querySelector('.rl-step-detail') as HTMLElement;
    expect(detail.querySelector('.rl-why-list')?.textContent).toContain(reason);
    expect(detail.querySelector('app-call-card')).not.toBeNull();

    searchRow.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rl-why-list')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain(reason);
  });

  it('shows a whole-document JSON mismatch as differences, not a failure', () => {
    const body = '{"searchOffers":{"segments":[{"airportCode":"JED"}]}}';
    const search = makeStep('search', null, { label: 'flight-search' });
    fixture.componentRef.setInput('run', run({ status: 'FAILED', finishedAt: '2026-09-27T10:01:00Z' }));
    fixture.componentRef.setInput('steps', [search]);
    fixture.componentRef.setInput('results', {
      search: result('search', 'FAILED', {
        mode: 'LIVE',
        durationMs: 6969,
        actualResponse: { status: 200, headers: {}, body },
        differences: [{ part: 'body', path: 'searchOffers', recorded: '{}', actual: body, kind: 'UNEXPECTED', cause: null }],
        assertions: [{
          assertion: { kind: 'JSON', operator: 'EQUALS', value: '200', path: '' },
          passed: false,
          actual: body,
          message: `JSON path "" was "${body}", expected "200".`,
        }],
      }),
    });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.rl-pill')?.textContent).toContain('completed with differences');
    const row = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    expect(row.textContent).not.toContain('failed');
    expect(row.textContent).not.toContain('Failed');
    expect(row.textContent).not.toContain('searchOffers');
    expect(row.textContent).toContain('1 difference');
    expect(row.textContent).toContain('Differences');
    expect(row.textContent).not.toContain('Retry');

    fixture.componentInstance.setFilter('failed');
    fixture.detectChanges();
    expect(fixture.componentInstance.filteredRows().length).toBe(0);

    fixture.componentInstance.setFilter('diff');
    fixture.detectChanges();
    expect(fixture.componentInstance.filteredRows().map((r) => r.step.key)).toEqual(['search']);

    fixture.componentInstance.setFilter('all');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement).click();
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.includes('/internal-calls'))
      .flush({ calls: [], total: 0 });
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.endsWith('/calls'))
      .flush({ calls: [], total: 0 });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.rl-why-list')).toBeNull();
    expect(fixture.nativeElement.querySelector('.rl-why-more')).toBeNull();
    const detail = fixture.nativeElement.querySelector('.rl-step-detail') as HTMLElement;
    expect(detail.textContent).toContain('A check expected the whole body to equal "200".');
    expect(detail.textContent).toContain('searchOffers');
    expect(row.textContent).not.toContain('searchOffers');

    const liveRow = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    (liveRow.querySelector('.rl-p-diff') as HTMLButtonElement).click();
    fixture.detectChanges();
    const popup = fixture.nativeElement.querySelector('.rl-diff-dialog') as HTMLElement;
    expect(popup.textContent).toContain('searchOffers');
    expect(popup.textContent).toContain('Recorded');
    expect(popup.textContent).toContain('This run');
    expect(liveRow.textContent).not.toContain('searchOffers');

    (fixture.nativeElement.querySelector('.rl-reason-overlay') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rl-diff-dialog')).toBeNull();
  });

  it('opens the changed fields from the difference pill without putting them on the row', () => {
    const search = makeStep('search', null, {
      label: 'flight-search',
      recording: recording({
        responseHeaders: { 'Content-Type': 'application/json' },
        responseBody: '{"total":450,"traceId":"b-7c1e"}',
      }),
    });
    fixture.componentRef.setInput('run', run({ status: 'COMPLETED_WITH_DIFFERENCES' }));
    fixture.componentRef.setInput('steps', [search]);
    fixture.componentRef.setInput('results', {
      search: result('search', 'COMPLETED_WITH_DIFFERENCES', {
        actualResponse: {
          status: 200,
          headers: { 'Content-Type': 'application/json', Date: 'Tue' },
          body: '{"total":455,"traceId":"other"}',
        },
        differences: [{ part: 'body', path: 'response', recorded: 'recorded response', actual: 'different response', kind: 'UNEXPECTED' }],
      }),
    });
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    expect(row.textContent).toContain('1 difference');
    expect(row.textContent).not.toContain('455');
    expect(row.textContent).not.toContain('body.total');

    (row.querySelector('.rl-p-diff') as HTMLButtonElement).click();
    fixture.detectChanges();
    const popup = fixture.nativeElement.querySelector('.rl-diff-dialog') as HTMLElement;
    expect(popup.textContent).toContain('One difference: the response does not match the recording.');
    expect(popup.textContent).toContain('body.total');
    expect(popup.textContent).toContain('450');
    expect(popup.textContent).toContain('455');
    expect(popup.textContent).not.toContain('traceId');
    expect(popup.textContent).not.toContain('recorded response');
    expect(row.textContent).not.toContain('455');
    expect(fixture.nativeElement.querySelector('.rl-step-detail')).toBeNull();
  });

  it('opens a long failure in a formatted popup instead of pasting it into the row', () => {
    const actual = JSON.stringify({
      searchOffers: { segments: Array.from({ length: 30 }, (_, i) => ({ airportCode: 'JED', n: i })) },
    });
    const search = makeStep('search', null, { label: 'flight-search' });
    fixture.componentRef.setInput('run', run({ status: 'FAILED', finishedAt: '2026-09-27T10:01:00Z' }));
    fixture.componentRef.setInput('steps', [search]);
    fixture.componentRef.setInput('results', {
      search: result('search', 'FAILED', {
        actualResponse: { status: 200, headers: {}, body: actual },
        assertions: [{
          assertion: { kind: 'JSON', operator: 'EQUALS', value: '450', path: 'total' },
          passed: false,
          actual,
          message: `JSON path "total" was "${actual}", expected "450".`,
        }],
      }),
    });
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-step-key="search"]') as HTMLElement;
    expect(row.textContent).not.toContain('searchOffers');
    expect(row.querySelector('.rl-p-fail')?.getAttribute('title')).toBe('JSON path "total" did not equal "450".');

    row.click();
    fixture.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.includes('/internal-calls'))
      .flush({ calls: [], total: 0 });
    http.expectOne((req) => req.params.get('operationId') === 'relive-run-1-search' && req.url.endsWith('/calls'))
      .flush({ calls: [], total: 0 });
    fixture.detectChanges();

    const list = fixture.nativeElement.querySelector('.rl-why-list') as HTMLElement;
    expect(list.textContent).toContain('JSON path "total" did not equal "450".');
    expect(list.textContent).toContain('Click to show');
    expect(list.textContent).not.toContain('searchOffers');

    (list.querySelector('.rl-why-more') as HTMLButtonElement).click();
    fixture.detectChanges();
    const popup = fixture.nativeElement.querySelector('.rl-reason-body') as HTMLElement;
    expect(popup.textContent).toContain('"searchOffers"');
    expect(popup.textContent).toContain('\n');
    expect(fixture.nativeElement.querySelector('.rl-step-detail')).not.toBeNull();

    (fixture.nativeElement.querySelector('.rl-reason-overlay') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rl-reason-dialog')).toBeNull();
    expect(fixture.nativeElement.querySelector('.rl-step-detail')).not.toBeNull();
  });
});
