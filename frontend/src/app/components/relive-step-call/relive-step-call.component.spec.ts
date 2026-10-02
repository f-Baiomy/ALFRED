import { FrozenCall, Step, StepResult } from '../../shared/utils/relive-types';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallRecord } from '../../core/models/call.model';
import { ReliveStepCallComponent, stepCallDetail, stepCallRecord } from './relive-step-call.component';

const recording: FrozenCall = {
  method: 'GET',
  url: 'http://host.docker.internal:9001/odeysysadmin/Admin2/userDetails',
  requestHeaders: { Accept: 'application/json' },
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: '{"recorded":true}',
  timestamp: '2026-09-29T17:00:00Z',
  durationMs: 40,
  serviceName: 'odeysys',
  sessionId: 'sess-recorded',
  source: 'inbound',
};

function step(overrides: Partial<Step> = {}): Step {
  return {
    key: 'user-details',
    parentKey: null,
    label: 'user details',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key: 'user-details', parentKey: null, label: 'user details', recording }, { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'HOLD', defaultDriver: 'AUTOMATIC', internalHosts: [] }),
    unattributed: 'BLOCK',
    recording,
    source: { callId: 'recorded-call', cycleId: null, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...overrides,
  };
}

function result(overrides: Partial<StepResult> = {}): StepResult {
  return {
    runId: 'run-1',
    stepKey: 'user-details',
    attempt: 1,
    state: 'COMPLETED',
    mode: 'LIVE',
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

describe('relive step call', () => {
  it('serves the stored request and response, not the recording, to the call card', () => {
    const done = result({
      durationMs: 73,
      startedAt: '2026-09-29T17:44:58Z',
      actualRequest: { headers: { Accept: 'text/plain', 'X-Session-ID': 'sess-live' }, body: '{"from":"DXB"}' },
      actualResponse: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' },
    });

    const call = stepCallRecord(step(), done);
    expect(call.method).toBe('GET');
    expect(call.response?.status).toBe(200);
    expect(call.duration_ms).toBe(73);
    expect(call.state).toBe('COMPLETED');
    expect(call.source).toBe('internal');
    expect(call.service_name).toBe('odeysys');
    expect(call.session_id).toBe('sess-live');
    expect(call.url).toBe(recording.url);

    expect(stepCallDetail(step(), done, 'request-body').request?.body).toBe('{"from":"DXB"}');
    expect(stepCallDetail(step(), done, 'response-body').response?.body).toBe('{"ok":true}');
    expect(stepCallDetail(step(), done, 'response-headers').response?.headers).toEqual({ 'Content-Type': 'application/json' });
    const full = stepCallDetail(step(), done);
    expect(full.request?.body).toBe('{"from":"DXB"}');
    expect(full.response?.status).toBe(200);
    expect(full.response?.body).not.toBe('{"recorded":true}');
  });

  it('keeps an in-progress step openable from the recording before a response exists', () => {
    const call = stepCallRecord(step(), result({ state: 'RUNNING', actualRequest: undefined, actualResponse: undefined }));
    expect(call.state).toBe('IN_PROGRESS');
    expect(call.response).toBeUndefined();
    expect(stepCallDetail(step(), result({ state: 'RUNNING' }), 'request-headers').request?.headers).toEqual({ Accept: 'application/json' });
    expect(stepCallDetail(step(), result({ state: 'RUNNING' }), 'response-body').response).toBeUndefined();
  });

  it('still describes a failed or cancelled step when nothing was stored', () => {
    const failed = stepCallRecord(step(), result({ state: 'FAILED', error: 'boom', mode: 'LIVE' }));
    expect(failed.state).toBe('ERROR');
    expect(failed.error).toBe('boom');
    expect(failed.response).toBeUndefined();

    const cancelled = stepCallRecord(step(), result({ state: 'CANCELLED', mode: 'REPLAY' }));
    expect(cancelled.state).toBe('COMPLETED');
    expect(cancelled.method).toBe('GET');
    expect(cancelled.url).toContain('/userDetails');
    expect(stepCallDetail(step(), result({ state: 'CANCELLED' }), 'request-body').request).toBeTruthy();
  });
});

describe('ReliveStepCallComponent', () => {
  it('editing the step does not look its call up again (the card would be rebuilt and lose focus)', () => {
    const logged = { id: 'recorded-call', method: 'GET', url: recording.url, timestamp: recording.timestamp, source: 'internal' } as unknown as CallRecord;
    const getSummary = jasmine.createSpy('getSummary').and.returnValue(of(logged));
    TestBed.configureTestingModule({ providers: [{ provide: CallsApiService, useValue: { getSummary, getCalls: () => of({ calls: [] }) } }] });
    TestBed.overrideComponent(ReliveStepCallComponent, { set: { template: '' } });
    const fixture = TestBed.createComponent(ReliveStepCallComponent);
    fixture.componentRef.setInput('step', step());
    fixture.detectChanges();
    expect(getSummary).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('step', step({ label: 'renamed', callRule: { ...step().callRule, name: 'edited' } }));
    fixture.detectChanges();

    expect(getSummary).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.record()).toBe(logged);
  });
});
