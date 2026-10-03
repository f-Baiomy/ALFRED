import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject, of } from 'rxjs';
import { CallDetail, CallRecord } from '../models/call.model';
import { CallsQuery } from '../state/call-list-view';
import { CallsApiService } from '../services/calls-api.service';
import { GlobalVariablesService } from '../services/global-variables.service';
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
      url: 'https://app.local/booking/{{$.bookingId}}',
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
  const globalState = signal({ variables: {} as Record<string, string>, fallbacks: {} as Record<string, string> });

  beforeEach(() => {
    globalState.set({ variables: {}, fallbacks: {} });
    reliveApi = jasmine.createSpyObj('ReliveApiService', [
      'startRun',
      'putStepAttempt',
      'setVariable',
      'setVariables',
      'saveStepEdits',
      'stopRun',
      'finishRun',
      'setHold',
      'resumeRun',
      'getRun',
      'getRunVariables',
      'updateRunDefinition',
      'evaluateChecks',
    ]);
    resendApi = jasmine.createSpyObj('ResendApiService', ['resend']);
    callsApi = jasmine.createSpyObj('CallsApiService', ['getDetail', 'getCalls']);
    callsApi.getCalls.and.returnValue(of({ calls: [], total: 0 }));
    events$ = new Subject<ReliveSocketEvent>();

    reliveApi.putStepAttempt.and.returnValue(of(undefined));
    reliveApi.setVariable.and.returnValue(of(undefined));
    reliveApi.setVariables.and.returnValue(of(undefined));

    TestBed.configureTestingModule({
      providers: [
        ReliveRunService,
        { provide: ReliveApiService, useValue: reliveApi },
        { provide: ResendApiService, useValue: resendApi },
        { provide: CallsApiService, useValue: callsApi },
        { provide: GlobalVariablesService, useValue: { state: globalState } },
        { provide: ReliveSocketService, useValue: { events$, holdLease: jasmine.createSpy(), releaseLease: jasmine.createSpy() } },
      ],
    });
    service = TestBed.inject(ReliveRunService);
    reliveApi.getRunVariables.and.callFake(() => of({ ...service.variables() }));
  });

  function loggedCall(id: string, state: 'IN_PROGRESS' | 'COMPLETED', stepKey: string, source: 'internal' | 'external'): CallRecord {
    return {
      id,
      original_url: 'https://app.local/search',
      url: 'https://app.local/search',
      method: 'POST',
      timestamp: '2026-09-29T14:00:00.000Z',
      duration_ms: 20,
      state,
      response: state === 'COMPLETED' ? { status: 200 } : undefined,
      operation_id: `relive-run-1-${stepKey}`,
      relive: { runId: 'run-1', stepKey, attribution: 'INFLIGHT' } as CallRecord['relive'],
      source,
    };
  }

  it('reattaches a running cycle, settles the step already sent, and continues with the next one', async () => {
    const supplier = { ...childStep(), parentKey: 'search' };
    const search = inboundStep({ key: 'search', label: 'Search', source: { callId: 'orig-search', cycleId: 'cy-1', direction: 'inbound' } });
    const steps = [inboundStep(), search, supplier, logoutStep()];
    const full = {
      ...runOf(steps),
      stepResults: [baseStepResult('login', 'COMPLETED')],
    };
    callsApi.getCalls.and.callFake((query: CallsQuery, source?: string) => {
      if (query.operationId === 'relive-run-1-search') return of({ calls: [loggedCall('replay-search', 'COMPLETED', 'search', 'internal')], total: 1 });
      if (!query.operationId && source === 'external') return of({ calls: [loggedCall('replay-supplier', 'COMPLETED', 'supplier-a', 'external')], total: 1 });
      return of({ calls: [], total: 0 });
    });
    callsApi.getDetail.and.callFake((id: string) => of<CallDetail>({
      request: { headers: {}, body: '' },
      response: { status: 200, headers: {}, body: id === 'replay-supplier' ? '{"flights":12}' : '{}' },
    }));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(of<ResendResult>({ newCallId: 'replay-logout', status: 200, durationMs: 1, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }));

    service.adopt(full);
    expect(resendApi.resend).not.toHaveBeenCalled();
    await service.continueAdopted();

    expect(resendApi.resend).toHaveBeenCalledTimes(1);
    expect(resendApi.resend).toHaveBeenCalledWith(jasmine.objectContaining({ callId: 'orig-logout' }));
    expect(resendApi.resend).not.toHaveBeenCalledWith(jasmine.objectContaining({ callId: 'orig-search' }));
    expect(service.results()['search'].state).toBe('COMPLETED');
    expect(service.results()['search'].actualResponse).toEqual(jasmine.objectContaining({ status: 200 }));
    expect(service.results()['supplier-a'].state).toBe('COMPLETED');
    expect(service.results()['logout'].state).toBe('COMPLETED');
    expect(reliveApi.putStepAttempt).toHaveBeenCalledWith('cy-1', 'run-1', 'logout', 1, jasmine.objectContaining({ state: 'RUNNING' }));
  });

  it('waits for an in-progress logged call instead of sending the step again', async () => {
    const search = inboundStep({ key: 'search', label: 'Search', source: { callId: 'orig-search', cycleId: 'cy-1', direction: 'inbound' } });
    const steps = [inboundStep(), search];
    const full = { ...runOf(steps), stepResults: [baseStepResult('login', 'COMPLETED'), { ...baseStepResult('search', 'RUNNING'), startedAt: '2026-09-29T14:00:00.000Z' }] };
    let polls = 0;
    callsApi.getCalls.and.callFake((query: CallsQuery) => {
      if (query.operationId !== 'relive-run-1-search') return of({ calls: [], total: 0 });
      polls++;
      return of({ calls: [loggedCall('replay-search', polls < 2 ? 'IN_PROGRESS' : 'COMPLETED', 'search', 'internal')], total: 1 });
    });
    callsApi.getDetail.and.returnValue(of<CallDetail>({ request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '{}' } }));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));

    service.adopt(full);
    const following = service.continueAdopted();
    // Re-checked when the run signals a change, not on a timer (review B14).
    for (let i = 0; i < 20; i++) await Promise.resolve();
    events$.next({ type: 'run-call', runId: 'run-1', stepKey: 'search', callId: 'replay-search', direction: 'inbound', attribution: 'HEADER', state: 'COMPLETED' });
    await following;

    expect(resendApi.resend).not.toHaveBeenCalled();
    expect(polls).toBeGreaterThan(1);
    expect(service.results()['search'].state).toBe('COMPLETED');
    expect(service.results()['login'].state).toBe('COMPLETED');
  });

  it('adopts a running hold without sending the next call, then Continue starts at the following step', async () => {
    const steps = [inboundStep(), inboundStep({ key: 'search', label: 'Search', source: { callId: 'orig-search', cycleId: 'cy-1', direction: 'inbound' } }), logoutStep()];
    const held = {
      ...runOf(steps),
      hold: { stepKey: 'search', reason: 'FAILED' as const, since: 't' },
      stepResults: [baseStepResult('login', 'COMPLETED'), baseStepResult('search', 'FAILED')],
    };
    service.adopt(held);
    expect(service.hold()?.stepKey).toBe('search');
    expect(service.results()['login'].state).toBe('COMPLETED');
    expect(service.results()['search'].state).toBe('FAILED');
    expect(service.results()['logout'].state).toBe('PENDING');
    expect(resendApi.resend).not.toHaveBeenCalled();

    service.adopt(held);
    expect(resendApi.resend).not.toHaveBeenCalled();

    reliveApi.setHold.and.returnValue(of({ ...runOf(steps), hold: null }));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(of<ResendResult>({ newCallId: 'replay-logout', status: 200, durationMs: 1, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }));
    await service.continueRun();
    expect(resendApi.resend).toHaveBeenCalledWith(jasmine.objectContaining({ callId: 'orig-logout' }));
    expect(resendApi.resend).not.toHaveBeenCalledWith(jasmine.objectContaining({ callId: 'orig-search' }));
  });

  it('resends a standalone outbound root through the outbound proxy', async () => {
    const supplier = { ...childStep(), parentKey: null, callRule: defaultCallRule({ ...childStep(), parentKey: null }, cycleSettings) };
    const steps = [supplier];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(of<ResendResult>({ newCallId: 'replay-out', status: 200, durationMs: 1, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{"flights":12}' } }));
    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    expect(resendApi.resend).toHaveBeenCalledWith(jasmine.objectContaining({ direction: 'outbound', callId: 'orig-a', cycleId: 'cy-1' }));
  });

  it('happy path: runs the inbound step, then settles its child from a run-call event', async () => {
    const steps = [inboundStep(), childStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 50, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );
    callsApi.getDetail.and.returnValue(
      of<CallDetail>({
        request: { headers: {}, body: '' },
        response: { status: 200, headers: {}, body: '{"flights":12}' },
        relive: { runId: 'run-1', stepKey: 'supplier-a', ruleIds: [{ tier: 'STEP', ruleId: 'r-1', ruleName: 'Mock supplier A' }] },
      }),
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

  it('shows a step not called yet in its own mode: a LIVE child is not labelled REPLAY', async () => {
    const live = { ...childStep(), callRule: { ...childStep().callRule, actions: [] } };
    const steps = [inboundStep(), live];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(new Subject<ResendResult>());

    void service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();

    expect(service.results()['supplier-a'].state).toBe('WAITING');
    expect(service.results()['supplier-a'].mode).toBe('LIVE');
  });

  it('T068: maps the logged call\'s relive.ruleIds into the step result\'s rulesApplied', async () => {
    const steps = [inboundStep(), childStep()];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(
      of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 50, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
    );
    callsApi.getDetail.and.returnValue(
      of<CallDetail>({
        request: { headers: {}, body: '' },
        response: { status: 200, headers: {}, body: '{"flights":12}' },
        relive: { runId: 'run-1', stepKey: 'supplier-a', ruleIds: [{ tier: 'CYCLE', ruleId: 'r-2', ruleName: 'Cycle-scoped delay' }] },
      }),
    );

    const startPromise = service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });
    await Promise.resolve();
    await Promise.resolve();
    events$.next({ type: 'run-call', runId: 'run-1', stepKey: 'supplier-a', callId: 'call-a', direction: 'outbound', attribution: 'INFLIGHT', state: 'COMPLETED' });
    await startPromise;

    expect(service.results()['supplier-a'].rulesApplied).toEqual([{ ruleId: 'r-2', name: 'Cycle-scoped delay', tier: 'CYCLE' }]);
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
    expect(service.results()['booking-details'].error).toContain('{{$.bookingId}}');
    expect(service.results()['logout'].state).toBe('COMPLETED');
    expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'FAILED');
    // T082: stored, or the run's end marks it CANCELLED in History.
    expect(reliveApi.putStepAttempt).toHaveBeenCalledWith('cy-1', 'run-1', 'booking-details', 1, jasmine.objectContaining({ state: 'SKIPPED' }));
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
    expect(reliveApi.putStepAttempt).toHaveBeenCalledWith('cy-1', 'run-1', 'login', 1, jasmine.objectContaining({ state: 'SKIPPED' }));
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
    await Promise.resolve();

    expect(service.pause()).toEqual({ stepKey: 'login', at: 'AFTER' });
    expect(resendApi.resend).toHaveBeenCalledTimes(1);

    service.resolveCheckpoint('REPLAY');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(resendApi.resend).toHaveBeenCalledTimes(2);
    // FR-035b: attempt 1 was stored before attempt 2 was sent.
    const stored = reliveApi.putStepAttempt.calls.allArgs().map((args: unknown[]) => args[3]);
    expect(stored).toContain(1);
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
    // One row per field (FR-039/040): the real change counts, the trace id is noise.
    expect(differences).toEqual([
      jasmine.objectContaining({ path: 'body.total', kind: 'UNEXPECTED', recorded: '450', actual: '455' }),
      jasmine.objectContaining({ path: 'body.traceId', kind: 'NOISE_AUTO', cause: 'trace id' }),
    ]);
    expect(service.results()['login'].state).toBe('COMPLETED_WITH_DIFFERENCES');
  });

  it('T106: a value the edited answer in the call rule gives is an expected difference', async () => {
    const supplier = inboundStep({
      recording: { ...inboundStep().recording, responseBody: '{"total":450}' },
    });
    const edited = { ...supplier, callRule: { ...supplier.callRule, actions: [
      { type: 'REPLACE_RESPONSE', enabled: true, status: 200, headers: {}, body: '{"total":999}' },
    ] } } as Step;
    const steps = [edited];
    reliveApi.startRun.and.returnValue(of(runOf(steps)));
    reliveApi.finishRun.and.returnValue(of({ ...runOf(steps), status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(of<ResendResult>({
      newCallId: 'n', status: 200, durationMs: 5, sessionValuesUsed: [],
      response: { status: 200, headers: {}, body: '{"total":999}' },
    }));

    await service.start(cycleOf(steps), { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(service.results()[edited.key].differences).toEqual([
      jasmine.objectContaining({ path: 'body.total', kind: 'EXPECTED', cause: 'answer edited in the call rule' }),
    ]);
    expect(service.results()[edited.key].state).toBe('COMPLETED');
  });

  it('T066: refuses to send a step with an unresolved {{$.name}} reference and marks it FAILED', async () => {
    const login = inboundStep({
      recording: { ...inboundStep().recording, requestBody: '{"booking":"{{$.bookingId}}"}' },
    });
    const steps = [login];
    const cycle = cycleOf(steps);
    const run1 = { ...runOf(steps), definition: { ...cycle, settings: { ...cycle.settings, onFailure: 'CONTINUE' as const } } };
    reliveApi.startRun.and.returnValue(of(run1));
    reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'FAILED' }));

    await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(resendApi.resend).not.toHaveBeenCalled();
    expect(service.results()['login'].state).toBe('FAILED');
    expect(service.results()['login'].error).toBe('unresolved {{$.bookingId}}');
    expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'FAILED');
  });

  describe('step checks (rule conditions, evaluated by the proxy)', () => {
    const checks = (onMiss: 'FAIL' | 'WARN') => ({ version: 2 as const, onMiss, groups: [
      { combine: 'ALL' as const, onMiss: 'DEFAULT' as const, conditions: [{ subject: 'RESPONSE_STATUS' as const, operator: 'EQUALS' as const, value: '201' }] },
    ] });

    function runWith(onMiss: 'FAIL' | 'WARN', onFailure: 'HOLD' | 'CONTINUE') {
      const login = inboundStep({ assertions: checks(onMiss) });
      const cycle = cycleOf([login, logoutStep()]);
      const run1 = { ...runOf([login, logoutStep()]), definition: { ...cycle, settings: { ...cycle.settings, onFailure } } };
      reliveApi.startRun.and.returnValue(of(run1));
      reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'COMPLETED' }));
      reliveApi.setHold.and.returnValue(of(run1));
      resendApi.resend.and.returnValue(of<ResendResult>({ newCallId: 'n', status: 200, durationMs: 40, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }));
      reliveApi.evaluateChecks.and.returnValue(of({ groups: [{ passed: false, rows: [{ holds: false, found: { values: ['200'] } }] }] }));
      return { cycle, login };
    }

    it('asks the proxy with the answer the step got, and a missed FAIL check fails the step and holds the run', async () => {
      const { cycle } = runWith('FAIL', 'CONTINUE');
      await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

      const request = reliveApi.evaluateChecks.calls.mostRecent().args[0] as { answer: { status: number }; responseTimeMs: number; groups: unknown[] };
      expect(request.answer.status).toBe(200);
      expect(request.responseTimeMs).toBe(40);
      expect(service.results()['login'].state).toBe('FAILED');
      // Held even though the cycle says "continue on failure": a FAIL check stops the run.
      expect(reliveApi.setHold).toHaveBeenCalledWith('cy-1', 'run-1', { stepKey: 'login', reason: 'FAILED' });
      expect(resendApi.resend).toHaveBeenCalledTimes(1);
    });

    it('a missed WARN check leaves the step passing and the run going on', async () => {
      const { cycle } = runWith('WARN', 'HOLD');
      await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

      expect(service.results()['login'].state).toBe('COMPLETED');
      expect(reliveApi.setHold).not.toHaveBeenCalled();
      expect(resendApi.resend).toHaveBeenCalledTimes(2);
      expect((service.results()['login'].assertions as { groups: { onMiss: string; passed: boolean }[] }).groups[0]).toEqual(jasmine.objectContaining({ onMiss: 'WARN', passed: false }));
    });
  });

  describe('keeping the run logged in', () => {
    function loginAndNext(settings?: Partial<ReliveCycle['settings']>) {
      const login = inboundStep({
        recording: { ...inboundStep().recording, responseHeaders: { 'Set-Cookie': 'JSESSIONID=OLD-SESSION-1; Path=/' }, responseBody: '{"token":"OLD-TOKEN-0001"}' },
        extract: [{ from: 'JSON', path: 'token', as: 'token', missing: 'SKIP', recordedValue: 'OLD-TOKEN-0001' }],
      });
      const next = { ...logoutStep(), recording: { ...logoutStep().recording,
        requestHeaders: { Cookie: 'lang=en; JSESSIONID=OLD-SESSION-1', Authorization: 'Bearer OLD-TOKEN-0001' },
        requestBody: '{"token":"OLD-TOKEN-0001"}' } };
      const cycle = { ...cycleOf([login, next]), settings: { ...cycleOf([]).settings, ...settings } };
      const run = { ...runOf([login, next]), definition: cycle };
      reliveApi.startRun.and.returnValue(of(run));
      reliveApi.finishRun.and.returnValue(of({ ...run, status: 'COMPLETED' }));
      resendApi.resend.and.returnValues(
        of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 1, sessionValuesUsed: [],
          response: { status: 200, headers: { 'Set-Cookie': 'JSESSIONID=NEW-SESSION-9; Path=/; HttpOnly' }, body: '{"token":"NEW-TOKEN-7777"}' } }),
        of<ResendResult>({ newCallId: 'new-next', status: 200, durationMs: 1, sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }),
      );
      return cycle;
    }

    it('sends the session cookie and token the earlier step got, not the recorded ones', async () => {
      const cycle = loginAndNext();

      await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

      const sent = resendApi.resend.calls.argsFor(1)[0].edits!;
      expect(sent.headers!['Cookie']).toBe('lang=en; JSESSIONID=NEW-SESSION-9');
      expect(sent.headers!['Authorization']).toBe('Bearer NEW-TOKEN-7777');
      expect(sent.body).toBe('{"token":"NEW-TOKEN-7777"}');
      const result = service.results()['logout'];
      expect(result.variablesUsed).toContain({ name: 'token', value: 'NEW-TOKEN-7777' });
      expect(result.editsApplied).toEqual({ session: { swapped: ['token'], cookies: ['JSESSIONID'] } });
    });

    it('sends the recorded cookie when the cycle turns carrying cookies off', async () => {
      const cycle = loginAndNext({ carryCookies: false });

      await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

      expect(resendApi.resend.calls.argsFor(1)[0].edits!.headers!['Cookie']).toBe('lang=en; JSESSIONID=OLD-SESSION-1');
    });
  });

  it('resolves global and Relive variables from separate scopes before resending', async () => {
    globalState.set({ variables: { globalId: 'G-1' }, fallbacks: {} });
    const login = inboundStep({ recording: { ...inboundStep().recording,
      requestBody: '{"global":"{{globalId}}","relive":"{{$.bookingId}}"}' } });
    const cycle = { ...cycleOf([login]), variables: [{ name: 'bookingId', value: 'B-2', secret: false }] };
    const run = { ...runOf([login]), definition: cycle };
    reliveApi.startRun.and.returnValue(of(run));
    reliveApi.finishRun.and.returnValue(of({ ...run, status: 'COMPLETED' }));
    resendApi.resend.and.returnValue(of<ResendResult>({ newCallId: 'new-login', status: 200, durationMs: 1,
      sessionValuesUsed: [], response: { status: 200, headers: {}, body: '{}' } }));

    await service.start(cycle, { driver: 'AUTOMATIC', unattributedChoices: {} });

    expect(resendApi.resend.calls.mostRecent().args[0].edits?.body).toBe('{"global":"G-1","relive":"B-2"}');
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
      recording: { ...inboundStep().recording, requestBody: '{"booking":"{{$.bookingId}}"}' },
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

  describe('T077: Guided driver', () => {
    it('never sends anything itself - it only subscribes and waits', async () => {
      const steps = [inboundStep(), logoutStep()];
      const run1 = { ...runOf(steps), driver: 'GUIDED' as const };
      reliveApi.startRun.and.returnValue(of(run1));

      await service.start(cycleOf(steps), { driver: 'GUIDED', unattributedChoices: {} });

      expect(resendApi.resend).not.toHaveBeenCalled();
      expect(service.results()['login'].state).toBe('PENDING');
    });

    it('matches an inbound call to the next expected step, in order, and settles it', async () => {
      const steps = [inboundStep(), logoutStep()];
      const run1 = { ...runOf(steps), driver: 'GUIDED' as const };
      reliveApi.startRun.and.returnValue(of(run1));
      callsApi.getDetail.and.returnValue(
        of<CallDetail>({ request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '{}' } }),
      );

      await service.start(cycleOf(steps), { driver: 'GUIDED', unattributedChoices: {} });
      events$.next({
        type: 'run-call', runId: 'run-1', stepKey: '', callId: 'call-1',
        direction: 'inbound', attribution: 'GUIDED', state: 'COMPLETED', method: 'POST', url: 'https://app.local/login',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(service.results()['login'].state).toBe('COMPLETED');
      expect(service.results()['login'].attribution).toBe('GUIDED');
      expect(service.results()['logout'].state).toBe('PENDING');
      expect(reliveApi.putStepAttempt).toHaveBeenCalled();
    });

    it('out of order: a call matching a later step marks the ones in between SKIPPED', async () => {
      const steps = [inboundStep(), logoutStep()];
      const run1 = { ...runOf(steps), driver: 'GUIDED' as const };
      reliveApi.startRun.and.returnValue(of(run1));
      callsApi.getDetail.and.returnValue(
        of<CallDetail>({ request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '{}' } }),
      );

      await service.start(cycleOf(steps), { driver: 'GUIDED', unattributedChoices: {} });
      events$.next({
        type: 'run-call', runId: 'run-1', stepKey: '', callId: 'call-2',
        direction: 'inbound', attribution: 'GUIDED', state: 'COMPLETED', method: 'POST', url: 'https://app.local/logout',
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(service.results()['login'].state).toBe('SKIPPED');
      expect(service.results()['logout'].state).toBe('COMPLETED');
    });

    it('no match: the call is recorded as unexpected', async () => {
      const steps = [inboundStep()];
      const run1 = { ...runOf(steps), driver: 'GUIDED' as const };
      reliveApi.startRun.and.returnValue(of(run1));

      await service.start(cycleOf(steps), { driver: 'GUIDED', unattributedChoices: {} });
      events$.next({
        type: 'run-call', runId: 'run-1', stepKey: '', callId: 'call-x',
        direction: 'inbound', attribution: 'GUIDED', state: 'COMPLETED', method: 'GET', url: 'https://app.local/never-seen',
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(service.unexpectedCalls().map((u) => u.callId)).toEqual(['call-x']);
      expect(callsApi.getDetail).not.toHaveBeenCalled();
    });

    it('endGuidedRun() marks whatever never matched as NOT_CALLED and finishes the run', async () => {
      const steps = [inboundStep(), logoutStep()];
      const run1 = { ...runOf(steps), driver: 'GUIDED' as const };
      reliveApi.startRun.and.returnValue(of(run1));
      reliveApi.finishRun.and.returnValue(of({ ...run1, status: 'COMPLETED' }));

      await service.start(cycleOf(steps), { driver: 'GUIDED', unattributedChoices: {} });
      await service.endGuidedRun();

      expect(service.results()['login'].state).toBe('NOT_CALLED');
      expect(service.results()['logout'].state).toBe('NOT_CALLED');
      expect(reliveApi.finishRun).toHaveBeenCalledWith('cy-1', 'run-1', 'COMPLETED');
    });
  });

  it('T080: SC-005 - a run-call event updates results() well within 1s, with no timer/polling involved', fakeAsync(() => {
    const steps = [inboundStep(), logoutStep()];
    const run1 = { ...runOf(steps), driver: 'GUIDED' as const };
    reliveApi.startRun.and.returnValue(of(run1));
    callsApi.getDetail.and.returnValue(
      of<CallDetail>({ request: { headers: {}, body: '' }, response: { status: 200, headers: {}, body: '{}' } }),
    );

    service.start(cycleOf(steps), { driver: 'GUIDED', unattributedChoices: {} });
    tick();
    expect(service.results()['login'].state).toBe('PENDING');

    const before = Date.now();
    events$.next({
      type: 'run-call', runId: 'run-1', stepKey: '', callId: 'call-1',
      direction: 'inbound', attribution: 'GUIDED', state: 'COMPLETED', method: 'POST', url: 'https://app.local/login',
    });
    tick();
    const elapsedMs = Date.now() - before;

    expect(service.results()['login'].state).toBe('COMPLETED');
    expect(elapsedMs).toBeLessThan(1000);
  }));
});
