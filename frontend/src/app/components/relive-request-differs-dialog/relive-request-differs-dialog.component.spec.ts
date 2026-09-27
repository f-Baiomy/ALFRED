import { ComponentFixture, TestBed } from '@angular/core/testing';
import { defaultCallRule, onRequestChangedOf } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveRequestDiffersDialogComponent } from './relive-request-differs-dialog.component';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{}',
  status: 200,
  responseHeaders: {},
  responseBody: '{}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 100,
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
    label: 'Supplier A',
    enabled: true,
    optional: false,
    direction: 'outbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key: 'c-supA', parentKey: 's-search', label: 'Supplier A', recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: 'call-1', cycleId: null, direction: 'outbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

describe('ReliveRequestDiffersDialogComponent', () => {
  let fixture: ComponentFixture<ReliveRequestDiffersDialogComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ReliveRequestDiffersDialogComponent] });
    fixture = TestBed.createComponent(ReliveRequestDiffersDialogComponent);
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('step', makeStep());
    fixture.detectChanges();
  });

  it('choosing ASK applies immediately, no confirmation needed', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));
    fixture.componentInstance.choose('ASK');
    expect(onRequestChangedOf(emitted!.callRule)).toBe('ASK');
  });

  it('choosing Call live opens the danger confirmation instead of applying immediately', () => {
    const stepChangeSpy = jasmine.createSpy('stepChange');
    fixture.componentInstance.stepChange.subscribe(stepChangeSpy);
    fixture.componentInstance.choose('LIVE');
    expect(stepChangeSpy).not.toHaveBeenCalled();
    expect(fixture.componentInstance.confirmingLive()).toBeTrue();
  });

  it('Call live cannot be confirmed without ticking the checkbox', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

    fixture.componentInstance.choose('LIVE');
    fixture.componentInstance.confirmLive();
    expect(emitted).toBeNull();

    fixture.componentInstance.liveConfirmChecked.set(true);
    fixture.componentInstance.confirmLive();
    expect(onRequestChangedOf(emitted!.callRule)).toBe('LIVE');
  });

  it('Back returns to the card view without applying anything', () => {
    fixture.componentInstance.choose('LIVE');
    fixture.componentInstance.back();
    expect(fixture.componentInstance.confirmingLive()).toBeFalse();
  });

  it('the Call live button in the DOM is disabled until the checkbox is ticked', () => {
    fixture.componentInstance.choose('LIVE');
    fixture.detectChanges();
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.rl-danger');
    expect(button.disabled).toBeTrue();

    fixture.componentInstance.liveConfirmChecked.set(true);
    fixture.detectChanges();
    expect(button.disabled).toBeFalse();
  });
});
