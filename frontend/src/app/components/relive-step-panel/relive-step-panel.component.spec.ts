import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { checkpointOf, defaultCallRule, modeOf, requestBodyOf } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveStepPanelComponent, variablesUsedBy } from './relive-step-panel.component';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{"origin":"DXB"}',
  status: 200,
  responseHeaders: { 'X-Ref': 'R-9' },
  responseBody: '{"results":12,"searchId":"S-1"}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 420,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function makeStep(overrides: Partial<Step> = {}): Step {
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
    ...overrides,
  };
}

describe('ReliveStepPanelComponent', () => {
  let fixture: ComponentFixture<ReliveStepPanelComponent>;
  let panel: ReliveStepPanelComponent;
  let emitted: Step[];

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ReliveStepPanelComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    fixture = TestBed.createComponent(ReliveStepPanelComponent);
    panel = fixture.componentInstance;
    emitted = [];
    panel.stepChange.subscribe((step) => {
      emitted.push(step);
      fixture.componentRef.setInput('step', step);
    });
    fixture.componentRef.setInput('step', makeStep());
    fixture.detectChanges();
  });

  const text = (): string => fixture.nativeElement.textContent;
  function open(box: string): void {
    panel.select(box);
    fixture.detectChanges();
  }

  it('is a call-card panel with the numbered strip and a one-line summary', () => {
    expect(fixture.nativeElement.querySelector('.intercept-panel.rl-step-panel')).toBeTruthy();
    expect(text()).toContain('How this step runs');
    expect(text()).toContain('REPLAY · ALFRED answers');
    const boxes = Array.from(fixture.nativeElement.querySelectorAll('.resend-flow-node') as NodeListOf<HTMLElement>).map((b) => b.textContent);
    expect(boxes.length).toBe(7);
    expect(boxes[4]).toContain('Call rule');
  });

  it('a mode button changes modeOf(step.callRule)', () => {
    open('mode');
    const live = Array.from(fixture.nativeElement.querySelectorAll('.rl-mode button') as NodeListOf<HTMLButtonElement>).find((b) => b.textContent!.includes('real supplier'))!;
    live.click();
    expect(modeOf(emitted.at(-1)!.callRule)).toBe('LIVE');
  });

  it('editing the request saves it in the call rule; asks what happens when it differs once you leave the edit', () => {
    const asked: string[] = [];
    panel.requestEdited.subscribe((key) => asked.push(key));
    open('edits');
    panel.setRequestBody('{"origin":"AUH"}');
    expect(requestBodyOf(emitted.at(-1)!.callRule)).toBe('{"origin":"AUH"}');
    expect(asked).toEqual([]);

    open('variables');
    expect(asked).toEqual(['c-supA']);
  });

  it('putting the recorded body back clears the request edit', () => {
    panel.setRequestBody('{"origin":"AUH"}');
    panel.resetRequestBody();
    expect(requestBodyOf(emitted.at(-1)!.callRule)).toBeNull();
  });

  it('the Answer box edits the mock answer', () => {
    open('answer');
    panel.setAnswer(503, '{"down":true}');
    expect(panel.mockAnswer()).toEqual({ status: 503, body: '{"down":true}' });
    expect(panel.answerEdited()).toBeTrue();
  });

  it('the label and optional flag are edited in the Recorded call box', () => {
    open('recorded');
    panel.setLabel('Supplier A search');
    panel.setOptional(true);
    expect(emitted.at(-1)).toEqual(jasmine.objectContaining({ label: 'Supplier A search', optional: true }));
  });

  it('the Call rule box embeds the Interception rule editor inline, and toggles pauses', () => {
    open('rule');
    expect(fixture.nativeElement.querySelector('.rule-editor.rule-editor-inline')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.dialog-backdrop')).toBeNull();
    expect(text()).toContain('Apply to this step');

    panel.togglePause('before');
    expect(checkpointOf(emitted.at(-1)!.callRule).before).toBeTrue();
  });

  it('applying the inline rule editor writes this step\'s call rule', () => {
    const draft = { ...panel.step().callRule, name: 'edited inline' };
    panel.ruleTarget.save(draft, null).subscribe();
    expect(emitted.at(-1)!.callRule.name).toBe('edited inline');
  });

  it('shows the attribution choice for a REPLAY child and emits the new choice', () => {
    open('rule');
    expect(text()).toContain("If ALFRED can't tell the call is yours");
    panel.setUnattributed('SEND_REAL');
    expect(emitted.at(-1)!.unattributed).toBe('SEND_REAL');
  });

  it('opening the call rule dialog and the reset emit the step key', () => {
    const opened: string[] = [];
    const reset: string[] = [];
    panel.openCallRule.subscribe((k) => opened.push(k));
    panel.resetRequested.subscribe((k) => reset.push(k));
    open('rule');
    (fixture.nativeElement.querySelector('.rl-danger') as HTMLButtonElement).click();
    panel.openCallRule.emit(panel.step().key);
    expect(opened).toEqual(['c-supA']);
    expect(reset).toEqual(['c-supA']);
  });

  describe('Values (extract & assert)', () => {
    it('a saved value previews against the recording and says which later step uses it', () => {
      const later = makeStep({ key: 'c-book', label: 'Book', callRule: { ...makeStep().callRule, actions: [{ type: 'SET_REQUEST_BODY', enabled: true, body: '{"id":"{{$.searchId}}"}' }] } });
      fixture.componentRef.setInput('steps', [panel.step(), later]);
      panel.addExtractRule({ from: 'JSON', path: 'searchId', as: 'searchId', missing: 'SKIP' });
      panel.addExtractRule({ from: 'HEADER', path: 'X-Missing', as: 'ref', missing: 'FALLBACK', fallback: 'none' });
      open('values');

      expect(panel.extractPreviews()[0]).toEqual({ found: true, value: 'S-1', fallback: false, usedBy: ['Book'] });
      expect(panel.extractPreviews()[1]).toEqual({ found: false, value: 'none', fallback: true, usedBy: [] });
      expect(text()).toContain('used by Book');
      expect(text()).toContain('Not in the recording');
    });

    it('update and remove patch the rule by index', () => {
      panel.addExtractRule();
      panel.updateExtractRule(0, { path: 'results', as: 'count' });
      expect(emitted.at(-1)!.extract[0]).toEqual(jasmine.objectContaining({ path: 'results', as: 'count' }));
      panel.removeExtractRule(0);
      expect(emitted.at(-1)!.extract).toEqual([]);
    });

    it('checks run against the recording before a run', () => {
      panel.setAssertions([
        { kind: 'STATUS', operator: 'EQUALS', value: '200' },
        { kind: 'JSON', path: 'results', operator: 'EQUALS', value: '13' },
      ]);
      open('values');
      expect(panel.assertionPreview().map((r) => r.passed)).toEqual([true, false]);
      expect(fixture.nativeElement.querySelector('app-scenario-assertion-editor')).toBeTruthy();
    });

    it('fields ticked in the response browser become saved values, or checks', () => {
      panel.onBrowsePicked([{ path: 'searchId', value: 'S-1', as: 'test', type: 'text' }]);
      expect(emitted.at(-1)!.extract).toEqual([{ from: 'JSON', path: 'searchId', as: 'searchId', missing: 'SKIP' }]);

      panel.browseAs.set('check');
      panel.onBrowsePicked([{ path: 'results', value: '12', as: 'test', type: 'number' }]);
      expect(emitted.at(-1)!.assertions).toEqual([{ kind: 'JSON', path: 'results', operator: 'EQUALS', value: '12' }]);
    });
  });

  it('variablesUsedBy reads both {{name}} and {{$.name}} from the call rule', () => {
    const step = makeStep({ callRule: { ...makeStep().callRule, actions: [{ type: 'SET_REQUEST_BODY', enabled: true, body: '{{$.a}} {{b}} {{$.a}}' }] } });
    expect(variablesUsedBy(step)).toEqual(['a', 'b']);
  });

  it('masks a secret variable in the request diff until Reveal secrets', () => {
    fixture.componentRef.setInput('variables', [{ name: 'token', value: 'DXB', secret: true }]);
    fixture.detectChanges();
    expect(panel.compare().originalRequest!.body).not.toContain('DXB');
    panel.toggleReveal();
    expect(panel.compare().originalRequest!.body).toContain('DXB');
  });
});
