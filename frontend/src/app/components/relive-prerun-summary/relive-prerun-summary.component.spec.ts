import { ComponentFixture, TestBed } from '@angular/core/testing';
import { applyMode, defaultCallRule } from '../../shared/utils/relive-call-rule';
import { FrozenCall, GlobalRulesSelection, ReliveCycle, ReliveSettings, Step, UnexpectedCallsPolicy } from '../../shared/utils/relive-types';
import { ReliveRerunSummaryComponent } from './relive-prerun-summary.component';

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
const globalRules: GlobalRulesSelection = { mode: 'NONE', selectedIds: [] };
const unexpectedCalls: UnexpectedCallsPolicy = { policy: 'BLOCK', rules: [], fallback: 'BLOCK' };

function makeStep(key: string, parentKey: string | null, overrides: Partial<Step> = {}): Step {
  return {
    key,
    parentKey,
    label: key,
    enabled: true,
    optional: false,
    direction: parentKey ? 'outbound' : 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey, label: key, recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: key, cycleId: null, direction: parentKey ? 'outbound' : 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...overrides,
  };
}

function cycle(overrides: Partial<ReliveCycle> = {}): ReliveCycle {
  return {
    id: 'c-1',
    name: 'Book flow',
    description: null,
    steps: [makeStep('s-1', null)],
    variables: [],
    cycleRules: [],
    globalRules,
    settings,
    noise: [],
    unexpectedCalls,
    createdAt: null,
    updatedAt: null,
    transient: false,
    lastRun: null,
    ...overrides,
  };
}

describe('ReliveRerunSummaryComponent', () => {
  let fixture: ComponentFixture<ReliveRerunSummaryComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ReliveRerunSummaryComponent] });
    fixture = TestBed.createComponent(ReliveRerunSummaryComponent);
    fixture.componentRef.setInput('open', true);
  });

  it('Start is enabled with no findings and no external calls', () => {
    fixture.componentRef.setInput('cycle', cycle());
    fixture.detectChanges();
    expect(fixture.componentInstance.canStart()).toBeTrue();
  });

  it('Start is disabled while a BLOCK finding remains', () => {
    const missingRecordingStep = { ...makeStep('s-1', null), recording: null as unknown as FrozenCall };
    fixture.componentRef.setInput('cycle', cycle({ steps: [missingRecordingStep] }));
    fixture.detectChanges();
    expect(fixture.componentInstance.canStart()).toBeFalse();
  });

  it('Start is disabled with a LIVE call until the confirmation is ticked', () => {
    const child = makeStep('c-1', 's-1');
    const liveChild = { ...child, callRule: applyMode(child.callRule, 'LIVE', recording) };
    fixture.componentRef.setInput('cycle', cycle({ steps: [makeStep('s-1', null), liveChild] }));
    fixture.detectChanges();

    expect(fixture.componentInstance.canStart()).toBeFalse();

    fixture.componentInstance.toggleLiveConfirmed(true);
    expect(fixture.componentInstance.canStart()).toBeTrue();
  });

  it('Run from here: a LIVE call under a step the run starts after is not listed', () => {
    const child = makeStep('c-1', 's-1');
    const liveChild = { ...child, callRule: applyMode(child.callRule, 'LIVE', recording) };
    fixture.componentRef.setInput('cycle', cycle({ steps: [makeStep('s-1', null), liveChild, makeStep('s-2', null)] }));
    fixture.componentRef.setInput('fromStepKey', 's-2');
    fixture.detectChanges();

    expect(fixture.componentInstance.externalItems()).toEqual([]);
    expect(fixture.componentInstance.canStart()).toBeTrue();
  });

  it('requestStart() does nothing when Start should be disabled', () => {
    const missingRecordingStep = { ...makeStep('s-1', null), recording: null as unknown as FrozenCall };
    fixture.componentRef.setInput('cycle', cycle({ steps: [missingRecordingStep] }));
    fixture.detectChanges();

    const startSpy = jasmine.createSpy('start');
    fixture.componentInstance.start.subscribe(startSpy);
    fixture.componentInstance.requestStart();

    expect(startSpy).not.toHaveBeenCalled();
  });

  it('requestStart() emits the chosen driver when allowed', () => {
    fixture.componentRef.setInput('cycle', cycle());
    fixture.detectChanges();

    const startSpy = jasmine.createSpy('start');
    fixture.componentInstance.start.subscribe(startSpy);
    fixture.componentInstance.setDriver('GUIDED');
    fixture.componentInstance.requestStart();

    expect(startSpy).toHaveBeenCalledWith({ driver: 'GUIDED' });
  });
});
