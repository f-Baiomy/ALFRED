import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { CallDetail } from '../models/call.model';
import { CallsApiService } from '../services/calls-api.service';
import { ReliveApiService } from '../services/relive-api.service';
import { ReliveSocketEvent, ReliveSocketService } from '../services/relive-socket.service';
import { ResendApiService, ResendRequest, ResendResult } from '../services/resend-api.service';
import { CycleRule, ReliveCycle, Run, Step } from '../../shared/utils/relive-types';
import { ReliveRunService } from './relive-run.service';

function rule(): CycleRule {
  return { name: 'r', enabled: true, priority: 0, stopProcessing: true, match: {}, actions: [] };
}

function inboundStep(overrides: Partial<Step> = {}): Step {
  return {
    key: 'login',
    parentKey: null,
    label: 'Login',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: null,
    callRule: rule(),
    unattributed: 'BLOCK',
    recording: {
      method: 'POST',
      url: 'https://app.local/login',
      requestHeaders: {},
      requestBody: '{}',
      status: 200,
      responseHeaders: {},
      responseBody: '{}',
      timestamp: 't',
      durationMs: 10,
      source: 'inbound',
    },
    source: { callId: 'orig-login', cycleId: 'cy-1', direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...overrides,
  };
}

function childStep(): Step {
  return {
    key: 'supplier-a',
    parentKey: 'login',
    label: 'Supplier A',
    enabled: true,
    optional: false,
    direction: 'outbound',
    serviceName: null,
    callRule: rule(),
    unattributed: 'BLOCK',
    recording: {
      method: 'GET',
      url: 'https://api.supplier-a.com/fares',
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: '{}',
      timestamp: 't',
      durationMs: 10,
      source: 'outbound',
    },
    source: { callId: 'orig-a', cycleId: 'cy-1', direction: 'outbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function bookStep(): Step {
  return {
    key: 'book',
    parentKey: null,
    label: 'Book',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: null,
    callRule: rule(),
    unattributed: 'BLOCK',
    recording: {
      method: 'POST',
      url: 'https://app.local/book',
      requestHeaders: {},
      requestBody: '{}',
      status: 201,
      responseHeaders: {},
      responseBody: '{}',
      timestamp: 't',
      durationMs: 10,
      source: 'inbound',
    },
    source: { callId: 'orig-book', cycleId: 'cy-1', direction: 'inbound' },
    extract: [{ from: 'JSON', path: 'bookingId', as: 'bookingId', missing: 'SKIP' }],
    assertions: [],
    noise: [],
  };
}

function bookingDetailsStep(): Step {
  return {
    key: 'booking-details',
    parentKey: null,
    label: 'Booking details',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: null,
    callRule: rule(),
    unattributed: 'BLOCK',
    recording: {
      method: 'GET',
      url: 'https://app.local/booking/{{bookingId}}',
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: '{}',
      timestamp: 't',
      durationMs: 10,
      source: 'inbound',
    },
    source: { callId: 'orig-bd', cycleId: 'cy-1', direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function logoutStep(): Step {
  return {
    key: 'logout',
    parentKey: null,
    label: 'Logout',
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: null,
    callRule: rule(),
    unattributed: 'BLOCK',
    recording: {
      method: 'POST',
      url: 'https://app.local/logout',
      requestHeaders: {},
      requestBody: '',
      status: 200,
      responseHeaders: {},
      responseBody: '{}',
      timestamp: 't',
      durationMs: 10,
      source: 'inbound',
    },
    source: { callId: 'orig-logout', cycleId: 'cy-1', direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

function cycleOf(steps: readonly Step[]): ReliveCycle {
  return {
    id: 'cy-1',
    name: 'Cycle',
    steps,
    variables: [],
    cycleRules: [],
    globalRules: { mode: 'NONE', selectedIds: [] },
    settings: { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] },
    noise: [],
    unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' },
    transient: false,
  };
}

function runOf(steps: readonly Step[]): Run {
  return {
    id: 'run-1',
    cycleId: 'cy-1',
    driver: 'AUTOMATIC',
    status: 'RUNNING',
    startedAt: 't',
    definition: cycleOf(steps),
    fromStepKey: null,
    seedVariables: [],
    variableTimeline: [],
    summary: { total: steps.length, completed: 0, different: 0, failed: 0, skipped: 0, notCalled: 0, cancelled: 0, live: 0, replayed: 0, unattributed: 0 },
    hold: null,
    resumed: [],
    log: [],
  };
}

describe('ReliveRunService', () => {
  let reliveApi: jasmine.SpyObj<ReliveApiService>;
  let resendApi: jasmine.SpyObj<ResendApiService>;
  let callsApi: jasmine.SpyObj<CallsApiService>;
  let events$: Subject<ReliveSocketEvent>;
  let service: ReliveRunService;

  beforeEach(() => {
    reliveApi = jasmine.createSpyObj('ReliveApiService', ['startRun', 'putStepAttempt', 'setVariable', 'stopRun', 'finishRun', 'setHold']);
    resendApi = jasmine.createSpyObj('ResendApiService', ['resend']);
    callsApi = jasmine.createSpyObj('CallsApiService', ['getDetail']);
    events$ = new Subject<ReliveSocketEvent>();

    reliveApi.putStepAttempt.and.returnValue(of(undefined));
    reliveApi.setVariable.and.returnValue(of(undefined));

    TestBed.configureTestingModule({
      providers: [
        ReliveRunService,
        { provide: ReliveApiService, useValue: reliveApi },
        { provide: ResendApiService, useValue: resendApi },
        { provide: CallsApiService, useValue: callsApi },
        { provide: ReliveSocketService, useValue: { events$, holdLease: jasmine.createSpy(), releaseLease: jasmine.createSpy() } },
      ],
    });
    service = TestBed.inject(ReliveRunService);
  });

  it('happy path: runs the inbound step, then settles its child from a run-call event', async () => {
    const steps = [inboundStep(), childStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 50, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );
    callsApi.getDetail.and.returnValue(
      of<CallDetail>({ request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '{"flights":12}' } }),
    );

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();
    events$.next({ type: 'run-call', runId: 'run-1', stepKey: 'supplier-a', callId: 'call-a', direction: 'outbound', attribution: 'INFLIGHT', state: 'REPLAYED' });
    await startPromise;

    expect(service.results()['login'].state).toBe('COMPLETED');
    expect(service.results()['supplier-a'].state).toBe('COMPLETED');
    expect(service.results()['supplier-a'].mode).toBe('REPLAY');
    expect(service.results()['supplier-a'].attribution).toBe('INFLIGHT');
    expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'COMPLETED');
  });

  it('settles an enabled child that never receives a run-call event as NOT_CALLED', async () => {
    const steps = [inboundStep(), childStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 50, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );

    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(service.results()['supplier-a'].state).toBe('NOT_CALLED');
    expect(callsApi.getDetail).not.toHaveBeenCalled();
  });

  it('stop cancels the in-flight step and calls the run stop endpoint', async () => {
    const steps = [inboundStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.stopRun.and.returnValue(of({ ...runOf(steps), status: 'STOPPED' }));
    resendApi.resend.and.returnValue(new Subject<ResendResult>()); // never settles - simulates a send still in flight

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();

    await service.stop();

    expect(service.results()['login'].state).toBe('CANCELLED');
    expect(reliveApi.stopRun).toHaveBeenCalledWith('cy-1', 'run-1');
    void startPromise;
  });

  it('T053: Book fails and holds; Continue skips the dependent step, siblings still run, final status FAILED', async () => {
    const steps = [bookStep(), bookingDetailsStep(), logoutStep()];
    const run1 = runOf(steps); // definition.settings.onFailure defaults to 'HOLD'
    reliveApi.startRun.and.returnValue(of(run1));
    reliveApi.setHold.and.returnValue(of({ ...run1, status: 'RUNNING' }));
    reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'FAILED' }));
    resendApi.resend.and.callFake((req: ResendRequest) =>
      of<ResendResult>(
        req.callId === 'orig-book'
          ? { newCallId: 'new-book', status: 500, durationMs: 5, sessionValuesUsed: [], response: { status: 500, headers: {}, body: '{"error":"failed"}' } }
          : { newCallId: `new-${req.callId}`, status: 200, durationMs: 5, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } },
      ),
    );

    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(service.hold()).toEqual(jasmine.objectContaining({ stepKey: 'book', reason: 'FAILED' }));
    expect(service.results()['book'].state).toBe('FAILED');
    expect(service.results()['booking-details'].state).toBe('PENDING');

    await service.continueRun();

    expect(service.hold()).toBeNull();
    expect(service.results()['booking-details'].state).toBe('SKIPPED');
    expect(service.results()['booking-details'].error).toContain('{{bookingId}}');
    expect(service.results()['logout'].state).toBe('COMPLETED');
    expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'FAILED');
  });
});
