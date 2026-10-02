import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { checkpointOf, defaultCallRule, modeOf } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Step, StepResult } from '../../shared/utils/relive-types';
import { ReliveStepDrawerComponent } from './relive-step-drawer.component';

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

function makeStep(): Step {
  return {
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
    extract: [],
    assertions: [],
    noise: [],
  };
}

describe('ReliveStepDrawerComponent', () => {
  let fixture: ComponentFixture<ReliveStepDrawerComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ReliveStepDrawerComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    fixture = TestBed.createComponent(ReliveStepDrawerComponent);
    fixture.componentRef.setInput('step', makeStep());
    fixture.detectChanges();
  });

  it('shows the recorded request on the Request tab', () => {
    fixture.componentInstance.setTab('request');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('"origin":"DXB"');
  });

  it('T037: a first request edit is saved in the call rule and asks what happens when it differs', () => {
    const changes: Step[] = [];
    const asked: string[] = [];
    fixture.componentInstance.stepChange.subscribe((s) => changes.push(s));
    fixture.componentInstance.requestEdited.subscribe((k) => asked.push(k));

    fixture.componentInstance.saveRequestBody('{"origin":"CAI"}');

    expect(changes[0].callRule.actions.some((a) => a.type === 'SET_REQUEST_BODY' && a.body === '{"origin":"CAI"}')).toBeTrue();
    expect(asked).toEqual(['c-supA']);
  });

  it('T037: the Response tab edits the mock answer', () => {
    const changes: Step[] = [];
    fixture.componentInstance.stepChange.subscribe((s) => changes.push(s));
    fixture.componentInstance.saveMockAnswer(201, '{"edited":true}');
    const mock = changes[0].callRule.actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mock?.status).toBe(201);
    expect(mock?.body).toBe('{"edited":true}');
  });

  it('shows the recorded response on the Response tab', () => {
    fixture.componentInstance.setTab('response');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('"results":12');
  });

  it('editing the label emits an updated step', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input:not([type="checkbox"])');
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input'));

    expect(emitted!.label).toBe('Renamed');
  });

  it('closing emits closed', () => {
    const closedSpy = jasmine.createSpy('closed');
    fixture.componentInstance.closed.subscribe(closedSpy);
    fixture.nativeElement.querySelector('.icon-btn').click();
    expect(closedSpy).toHaveBeenCalled();
  });

  it('a mode button changes modeOf(step.callRule) and emits the updated step', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

    fixture.componentInstance.setMode('LIVE');

    expect(modeOf(emitted!.callRule)).toBe('LIVE');
  });

  it('toggling a pause adds/removes a checkpoint on the call rule', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

    fixture.componentInstance.togglePause('before');
    expect(checkpointOf(emitted!.callRule).before).toBeTrue();

    fixture.componentRef.setInput('step', emitted!);
    fixture.componentInstance.togglePause('before');
    expect(checkpointOf(emitted!.callRule).before).toBeFalse();
  });

  it('shows the call rule preview with the default REPLAY mock and a request-differs button', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Call rule');
    expect(text).toContain('Mock response');
    expect(text).toContain('When the request differs: Mock a failure');
  });

  it('opening the call rule emits the step key', () => {
    const openSpy = jasmine.createSpy('open');
    fixture.componentInstance.openCallRule.subscribe(openSpy);
    fixture.componentInstance.requestOpenCallRule();
    expect(openSpy).toHaveBeenCalledWith('c-supA');
  });

  it('shows the attribution choice for a REPLAY child, defaulting to Block', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain("If ALFRED can't tell the call is yours");
    expect(text).toContain('Block (default)');
    expect(text).toContain('Replay anyway');
    expect(text).toContain('Send to real system');
  });

  it('setUnattributed emits the updated step with the new choice', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));
    fixture.componentInstance.setUnattributed('SEND_REAL');
    expect(emitted!.unattributed).toBe('SEND_REAL');
  });

  describe('T065: Extract & assert', () => {
    it('addExtractRule appends a blank JSON rule; updateExtractRule patches it by index', () => {
      let emitted: Step | null = null;
      fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

      fixture.componentInstance.addExtractRule();
      expect(emitted!.extract).toEqual([{ from: 'JSON', path: '', as: '', missing: 'SKIP' }]);

      fixture.componentRef.setInput('step', emitted!);
      fixture.componentInstance.updateExtractRule(0, { path: 'body.searchId', as: 'searchId' });
      expect(emitted!.extract[0]).toEqual({ from: 'JSON', path: 'body.searchId', as: 'searchId', missing: 'SKIP' });
    });

    it('removeExtractRule drops the rule at that index', () => {
      const withRule = { ...makeStep(), extract: [{ from: 'JSON' as const, path: 'a', as: 'x', missing: 'SKIP' as const }] };
      fixture.componentRef.setInput('step', withRule);
      let emitted: Step | null = null;
      fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

      fixture.componentInstance.removeExtractRule(0);
      expect(emitted!.extract).toEqual([]);
    });

    it('renders the assertion editor bound to the step\'s own assertions', () => {
      const withAssertion = { ...makeStep(), assertions: [{ kind: 'STATUS' as const, operator: 'EQUALS' as const, value: '200' }] };
      fixture.componentRef.setInput('step', withAssertion);
      fixture.componentInstance.setTab('extract');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-scenario-assertion-editor')).toBeTruthy();
    });
  });

  describe('T061: run mode', () => {
    function makeResult(overrides: Partial<StepResult> = {}): StepResult {
      return {
        runId: 'run-1',
        stepKey: 'c-supA',
        attempt: 1,
        state: 'COMPLETED_WITH_DIFFERENCES',
        mode: 'REPLAY',
        attribution: 'INFLIGHT',
        actualResponse: { status: 200, headers: {}, body: '{"results":11}' },
        differences: [
          { part: 'body', path: 'body.results', recorded: '12', actual: '11', kind: 'UNEXPECTED', cause: null },
          { part: 'body', path: 'body.traceId', recorded: 'a', actual: 'b', kind: 'NOISE_AUTO', cause: 'trace id' },
        ],
        rulesApplied: [{ ruleId: 'r1', name: 'Currency → AED', tier: 'GLOBAL', actions: ['response body rewritten'] }],
        variablesUsed: [{ name: 'searchId', value: 'S-1' }],
        variablesProduced: [],
        durationMs: 12,
        error: null,
        unexpectedCalls: [],
        pauses: [],
        ...overrides,
      };
    }

    it('defaults to the Overview tab and shows the run tab bar once a result is set', () => {
      fixture.componentRef.setInput('result', makeResult());
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent;
      expect(text).toContain('Overview');
      expect(text).toContain('Rules & variables');
      expect(text).not.toContain('Configure');
      expect(fixture.componentInstance.tab()).toBe('overview');
      expect(text).toContain('COMPLETED_WITH_DIFFERENCES');
      expect(text).toContain('1 unexpected');
      expect(text).toContain('1 noise');
    });

    it('shows the tier pill and variables on the Rules & variables tab', () => {
      fixture.componentRef.setInput('result', makeResult());
      fixture.componentInstance.setTab('rules');
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent;
      expect(text).toContain('GLOBAL');
      expect(text).toContain('Currency → AED');
      expect(text).toContain('searchId');
    });

    it('filters the run log to this step key', () => {
      fixture.componentRef.setInput('result', makeResult());
      fixture.componentRef.setInput('runLog', [
        { at: '2026-09-27T10:00:00Z', stepKey: 'c-supA', kind: 'MATCHED', message: 'matched endpoint+order #1' },
        { at: '2026-09-27T10:00:01Z', stepKey: 'other', kind: 'MATCHED', message: 'not this step' },
      ]);
      fixture.componentInstance.setTab('log');
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent;
      expect(text).toContain('matched endpoint+order #1');
      expect(text).not.toContain('not this step');
    });

    it('T062: renders the Compare tab for a REPLAY step (recorded vs this run)', () => {
      fixture.componentRef.setInput('result', makeResult({ mode: 'REPLAY', actualRequest: { headers: {}, body: '{"origin":"DXB"}' } }));
      fixture.componentInstance.setTab('compare');
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent;
      expect(text).toContain('Unexpected (1)');
      expect(text).toContain('body.results');
      expect(text).toContain('Ignored as noise (1)');
    });

    it('T062: renders the Compare tab for a LIVE step, toggling to the Request phase', () => {
      fixture.componentRef.setInput('result', makeResult({ mode: 'LIVE' }));
      fixture.componentInstance.setTab('compare');
      fixture.componentInstance.setComparePhase('request');
      fixture.detectChanges();

      expect(fixture.componentInstance.comparePhase()).toBe('request');
      expect(fixture.componentInstance.compareInterception()?.originalRequest?.body).toContain('DXB');
    });

    it('T063: masks a secret variable value on the Overview quick look until Reveal is clicked', () => {
      fixture.componentRef.setInput(
        'result',
        makeResult({ actualResponse: { status: 200, headers: {}, body: '{"results":11,"token":"eyJhbGciOi9f2"}' } }),
      );
      fixture.componentRef.setInput('secretNames', ['token']);
      fixture.componentRef.setInput('variableValues', { token: 'eyJhbGciOi9f2' });
      fixture.detectChanges();

      let text = fixture.nativeElement.textContent;
      expect(text).toContain('Reveal secrets');
      expect(text).not.toContain('eyJhbGciOi9f2');
      expect(text).toContain('•••');

      fixture.componentInstance.toggleReveal();
      fixture.detectChanges();
      text = fixture.nativeElement.textContent;
      expect(text).toContain('eyJhbGciOi9f2');

      fixture.componentInstance.close();
      expect(fixture.componentInstance.revealed()).toBeFalse();
    });
  });
});
