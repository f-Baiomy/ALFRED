import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { CallDetail } from '../models/call.model';
import { CallsApiService } from '../services/calls-api.service';
import { ReliveApiService } from '../services/relive-api.service';
import { ReliveSocketEvent, ReliveSocketService } from '../services/relive-socket.service';
import { ResendApiService, ResendRequest, ResendResult } from '../services/resend-api.service';
import { defaultCallRule, setCheckpoint } from '../../shared/utils/relive-call-rule';
import { CycleRule, ReliveCycle, ReliveSettings, Run, Step, StepResult } from '../../shared/utils/relive-types';
import { ReliveRunService } from './relive-run.service';

const cycleSettings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

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
  const recording = {
    method: 'GET',
    url: 'https://api.supplier-a.com/fares',
    requestHeaders: {},
    requestBody: null,
    status: 200,
    responseHeaders: {},
    responseBody: '{"flights":12}',
    timestamp: 't',
    durationMs: 10,
    source: 'outbound' as const,
  };
  return {
    key: 'supplier-a',
    parentKey: 'login',
    label: 'Supplier A',
    enabled: true,
    optional: false,
    direction: 'outbound',
    serviceName: null,
    // A child's default rule has a MOCK_RESPONSE action (REPLAY) - modeOf() reads mode off this,
    // not off the run-call event (see relive-run.service.ts).
    callRule: defaultCallRule({ key: 'supplier-a', parentKey: 'login', label: 'Supplier A', recording }, cycleSettings),
    unattributed: 'BLOCK',
    recording,
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

function baseStepResult(stepKey: string, state: StepResult['state']): StepResult {
  return {
    runId: 'run-1',
    stepKey,
    attempt: 1,
    state,
    mode: 'LIVE',
    attribution: 'HEADER',
    differences: [],
    rulesApplied: [],
    variablesUsed: [],
    variablesProduced: [],
    unexpectedCalls: [],
    pauses: [],
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
    reliveApi = jasmine.createSpyObj('ReliveApiService', [
      'startRun',
      'putStepAttempt',
      'setVariable',
      'stopRun',
      'finishRun',
      'setHold',
      'resumeRun',
      'getRun',
      'updateRunDefinition',
    ]);
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
    events$.next({ type: 'run-call', runId: 'run-1', stepKey: 'supplier-a', callId: 'call-a', direction: 'outbound', attribution: 'INFLIGHT', state: 'COMPLETED' });
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

  it('T054: resume re-fetches the run, resets a cancelled step after the resume point to pending, and continues', async () => {
    const steps = [bookStep(), logoutStep()];
    const resumedRun: Run = { ...runOf(steps), status: 'RUNNING' };
    reliveApi.resumeRun.and.returnValue(of(resumedRun));
    reliveApi.getRun.and.returnValue(
      of({
        ...resumedRun,
        stepResults: [baseStepResult('book', 'COMPLETED'), baseStepResult('logout', 'CANCELLED')],
        secrets: [],
      }),
    );
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-logout', status: 200, durationMs: 5, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );
    reliveApi.finishRun.and.returnValue(of({ ...resumedRun, status: 'COMPLETED' }));

    await service.resume('cy-1', 'run-1', 'book');

    expect(reliveApi.resumeRun).toHaveBeenCalledWith('cy-1', 'run-1', 'book');
    expect(service.results()['book'].state).toBe('COMPLETED'); // not re-run - resume starts after it
    expect(service.results()['logout'].state).toBe('COMPLETED'); // was CANCELLED, reset to PENDING, then actually ran
    expect(reliveApi.finishRun).toHaveBeenCalled();
  });

  it('T054: applyDefinitionEdit PUTs the definition and adopts the run it returns', async () => {
    const steps = [bookStep(), logoutStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    resendApi.resend.and.returnValue(new Subject<ResendResult>()); // keep the run mid-flight while we edit
    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();

    const edited = cycleOf([bookStep(), logoutStep()]);
    const updatedRun: Run = { ...runOf(steps), definition: edited };
    reliveApi.updateRunDefinition.and.returnValue(of(updatedRun));

    await service.applyDefinitionEdit(edited, 'edited Logout header');

    expect(reliveApi.updateRunDefinition).toHaveBeenCalledWith('cy-1', 'run-1', edited, 'edited Logout header');
    expect(service.run()).toBe(updatedRun);
    void startPromise;
  });

  it('T056: collects an outbound call the proxy could not attribute to any step as unexpected, deduped by callId', async () => {
    const steps = [inboundStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 5, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    events$.next({ type: 'run-call', runId: 'run-1', stepKey: '', callId: 'call-x', direction: 'outbound', attribution: 'UNEXPECTED', state: 'COMPLETED' });
    events$.next({ type: 'run-call', runId: 'run-1', stepKey: '', callId: 'call-x', direction: 'outbound', attribution: 'UNEXPECTED', state: 'IN_PROGRESS' });
    await startPromise;

    expect(service.unexpectedCalls().length).toBe(1);
    expect(service.unexpectedCalls()[0].callId).toBe('call-x');
  });

  it('T057: pauses before sending an inbound step with a "before" checkpoint, then sends on Continue', async () => {
    const login = inboundStep({ callRule: setCheckpoint(inboundStep().callRule, 'before', true, 30) });
    const steps = [login];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 5, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.pause()).toEqual({ stepKey: 'login', at: 'BEFORE' });
    expect(service.results()['login'].state).toBe('PAUSED');
    expect(resendApi.resend).not.toHaveBeenCalled();

    service.resolveCheckpoint('CONTINUE');
    await startPromise;

    expect(service.pause()).toBeNull();
    expect(resendApi.resend).toHaveBeenCalled();
    expect(service.results()['login'].state).toBe('COMPLETED');
  });

  it('T057: Skip at the "before" checkpoint marks the step SKIPPED without ever sending it', async () => {
    const login = inboundStep({ callRule: setCheckpoint(inboundStep().callRule, 'before', true, 30) });
    const steps = [login];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();

    service.resolveCheckpoint('SKIP');
    await startPromise;

    expect(resendApi.resend).not.toHaveBeenCalled();
    expect(service.results()['login'].state).toBe('SKIPPED');
  });

  it('T057: an "after" checkpoint holds the result; Replay re-sends at attempt 2, Continue then commits it', async () => {
    const login = inboundStep({ callRule: setCheckpoint(inboundStep().callRule, 'after', true, 30) });
    const steps = [login];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 5, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(service.pause()).toEqual({ stepKey: 'login', at: 'AFTER' });
    expect(resendApi.resend).toHaveBeenCalledTimes(1);

    service.resolveCheckpoint('REPLAY');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(resendApi.resend).toHaveBeenCalledTimes(2);
    expect(service.pause()).toEqual({ stepKey: 'login', at: 'AFTER' });

    service.resolveCheckpoint('CONTINUE');
    await startPromise;

    expect(service.pause()).toBeNull();
    expect(service.results()['login'].attempt).toBe(2);
    expect(service.results()['login'].state).toBe('COMPLETED');
  });

  it('T060: computes differences (recorded vs actual) and reflects them in the step outcome', async () => {
    const login = inboundStep({
      recording: {
        ...inboundStep().recording,
        responseBody: '{"total":450,"traceId":"b-7c1e"}',
      },
    });
    const steps = [login];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED_WITH_DIFFERENCES' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({
        newCallId: 'new-login',
        status: 200,
        durationMs: 5,
        sessionValuesUsed: [],
        response: { status: 200, headers: {}, body: '{"total":455,"traceId":"b-99d0"}' },
      }),
    );

    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });

    const differences = service.results()['login'].differences;
    expect(differences.find((d) => d.path === 'body.total')).toEqual(
      jasmine.objectContaining({ kind: 'UNEXPECTED', recorded: '450', actual: '455' }),
    );
    expect(differences.find((d) => d.path === 'body.traceId')?.kind).toBe('NOISE_AUTO');
    expect(service.results()['login'].state).toBe('COMPLETED_WITH_DIFFERENCES');
  });

  it('T066: refuses to send a step with an unresolved {{name}} reference and marks it FAILED', async () => {
    const login = inboundStep({
      recording: { ...inboundStep().recording, requestBody: '{"booking":"{{bookingId}}"}' },
    });
    const steps = [login];
    const cycle = cycleOf(steps);
    const run1 = { ...runOf(steps), definition: { ...cycle, settings: { ...cycle.settings, onFailure: 'CONTINUE' as const } } };
    reliveApi.startRun.and.returnValue(of(run1));
    reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'FAILED' }));

    await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(resendApi.resend).not.toHaveBeenCalled();
    expect(service.results()['login'].state).toBe('FAILED');
    expect(service.results()['login'].error).toBe('unresolved {{bookingId}}');
    expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'FAILED');
  });

  it('T075: "Run from here" carries earlier top-level steps over as NOT_CALLED and starts at fromStepKey', async () => {
    const login = inboundStep();
    const logout = logoutStep();
    const steps = [login, logout];
    const run1 = { ...runOf(steps), fromStepKey: 'logout' };
    reliveApi.startRun.and.returnValue(of(run1));
    reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-logout', status: 200, durationMs: 20, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );

    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', fromStepKey: 'logout', seedFromRunId: 'run-0', unattributedChoices: {} });

    expect(service.results()['login'].state).toBe('NOT_CALLED');
    expect(service.results()['logout'].state).toBe('COMPLETED');
    expect(resendApi.resend).toHaveBeenCalledTimes(1);
  });

  it('T076: an optional step\'s failure is recorded but never holds or fails the run overall', async () => {
    const login = inboundStep({
      optional: true,
      recording: { ...inboundStep().recording, requestBody: '{"booking":"{{bookingId}}"}' },
    });
    const steps = [login];
    const run1 = runOf(steps); // definition.settings.onFailure defaults to 'HOLD'
    reliveApi.startRun.and.returnValue(of(run1));
    reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'COMPLETED' }));

    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(resendApi.resend).not.toHaveBeenCalled();
    expect(service.results()['login'].state).toBe('FAILED');
    expect(reliveApi.setHold).not.toHaveBeenCalled();
    expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'COMPLETED');
  });
});
