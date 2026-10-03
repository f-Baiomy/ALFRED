import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { ReliveSocketService } from '../../core/services/relive-socket.service';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { CallPickerService, PickResult } from '../../core/services/call-picker.service';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionApiService } from '../../core/services/interception-api.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { ReliveRunService } from '../../core/state/relive-run.service';
import { ReliveCycle, Step } from '../../shared/utils/relive-types';
import { ReliveCycleComponent } from './relive-cycle.component';
import { ReliveCycleEditorState } from './relive-cycle-editor.state';
import { ReliveRuleDialogService } from './relive-rule-dialog.service';

describe('ReliveCycleComponent picker and run', () => {
  const oldCycle = { id: 'c-1', steps: [], settings: { inboundMode: 'LIVE' } } as unknown as ReliveCycle;
  const step = { key: 'step-1', enabled: true } as Step;
  const savedCycle = { ...oldCycle, steps: [step] } as ReliveCycle;
  let draft: ReturnType<typeof signal<ReliveCycle | null>>;
  let saved: ReturnType<typeof signal<ReliveCycle | null>>;
  let dirty: ReturnType<typeof signal<boolean>>;
  let result: ReturnType<typeof signal<PickResult | null>>;
  let state: any;
  let picker: any;
  let source: jasmine.SpyObj<ReliveCallSourceService>;
  let run: any;
  let api: { listRuns: jasmine.Spy; getRun: jasmine.Spy; fingerprint: jasmine.Spy };
  let holdingCalls: ReturnType<typeof signal<unknown[]>>;
  let sessionCyclesApi: { openReliveRun: jasmine.Spy };

  beforeEach(() => {
    holdingCalls = signal<unknown[]>([]);
    draft = signal<ReliveCycle | null>(null);
    saved = signal<ReliveCycle | null>(oldCycle);
    dirty = signal(false);
    result = signal<PickResult | null>(null);
    state = {
      draft, saved, dirty, saveError: signal<string | null>(null), selectedStepKey: signal<string | null>(null),
      load: jasmine.createSpy('load'),
      update: jasmine.createSpy('update').and.callFake((mutator: (cycle: ReliveCycle) => ReliveCycle) => draft.set(mutator(draft()!))),
      saveAsync: jasmine.createSpy('saveAsync').and.resolveTo(savedCycle),
    };
    picker = {
      hasResult: () => result() !== null,
      peekResult: () => result(),
      takeResult: jasmine.createSpy('takeResult').and.callFake(() => { const value = result(); result.set(null); return value; }),
    };
    source = jasmine.createSpyObj<ReliveCallSourceService>('ReliveCallSourceService', ['freezePicked']);
    source.freezePicked.and.resolveTo([step]);
    run = {
      start: jasmine.createSpy('start').and.resolveTo(undefined),
      adopt: jasmine.createSpy('adopt'),
      continueAdopted: jasmine.createSpy('continueAdopted'),
      retain: jasmine.createSpy('retain'),
      release: jasmine.createSpy('release'),
      run: signal<unknown>(null),
    };
    api = {
      listRuns: jasmine.createSpy('listRuns').and.returnValue(of([])),
      getRun: jasmine.createSpy('getRun').and.returnValue(of(null)),
      fingerprint: jasmine.createSpy('fingerprint').and.returnValue(of({})),
    };
    sessionCyclesApi = {
      openReliveRun: jasmine.createSpy('openReliveRun').and.returnValue(of({ cycle: { id: 'run-cycle-9' }, created: false })),
    };
    TestBed.configureTestingModule({
      imports: [ReliveCycleComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'c-1' } } } },
        { provide: CallPickerService, useValue: picker },
        { provide: ReliveCallSourceService, useValue: source },
        { provide: ConfirmDialogService, useValue: {} },
        { provide: ReliveApiService, useValue: api },
        { provide: InterceptionStateService, useValue: { pausedCalls: signal([]), holdingCalls } },
        { provide: ReliveSocketService, useValue: { events$: new Subject() } },
        { provide: InterceptionApiService, useValue: { decide: jasmine.createSpy('decide').and.returnValue(of(undefined)) } },
        { provide: ReliveRuleDialogService, useValue: { request: signal(null) } },
        { provide: SessionCyclesApiService, useValue: sessionCyclesApi },
      ],
    });
    TestBed.overrideComponent(ReliveCycleComponent, { set: {
      template: '', imports: [], providers: [
        { provide: ReliveCycleEditorState, useValue: state },
        { provide: ReliveRunService, useValue: run },
      ],
    } });
  });

  it('opens the calls of a run in place from History, named after the cycle and the run', () => {
    saved.set({ ...oldCycle, id: 'c-1', name: 'Login flow' } as ReliveCycle);
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    const page = fixture.componentInstance;

    page.openRunCalls({ id: 'run-9', startedAt: '2026-10-03T15:36:00Z', driver: 'GUIDED', status: 'COMPLETED' } as any);

    const [runId, name, cycleId] = sessionCyclesApi.openReliveRun.calls.mostRecent().args;
    expect([runId, cycleId]).toEqual(['run-9', 'c-1']);
    expect(name).toMatch(/^Run calls · Login flow · /);
    expect(page.runCalls()?.cycleId).toBe('run-cycle-9');

    page.setTab('steps');
    expect(page.runCalls()).toBeNull();
  });

  it('lists only the calls of this run still holding: a decided call leaves the run view', () => {
    run.run.set({ id: 'run-1' } as any);
    holdingCalls.set([
      { callId: 'held', stage: 'holding', relive: { runId: 'run-1' } },
      { callId: 'other-run', stage: 'holding', relive: { runId: 'run-2' } },
    ] as any);
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    expect(fixture.componentInstance.changedPauses().map((c) => c.callId)).toEqual(['held']);
  });

  it('waits for the async cycle load before consuming a picker result', async () => {
    result.set({ picked: [{ ref: { source: 'internal', callId: 'in', cycleId: 'sc-1' }, call: { id: 'in' } as any, originLabel: 'cycle' }], resume: { cycleId: 'c-1' } });
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    expect(state.load).toHaveBeenCalledWith('c-1');
    expect(picker.takeResult).not.toHaveBeenCalled();
    draft.set(oldCycle);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(source.freezePicked).toHaveBeenCalled();
    expect(draft()!.steps).toEqual([step]);
    expect(picker.takeResult).toHaveBeenCalledTimes(1);
  });

  it('keeps a picker result for retry when hydration fails', async () => {
    source.freezePicked.and.rejectWith(new Error('network'));
    result.set({ picked: [{ ref: { source: 'external', callId: 'out', cycleId: null }, call: { id: 'out' } as any, originLabel: 'live' }], resume: { cycleId: 'c-1' } });
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    draft.set(oldCycle);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(picker.takeResult).not.toHaveBeenCalled();
    expect(result()).not.toBeNull();
    expect(fixture.componentInstance.actionError()).toContain('Could not load');
    fixture.destroy();
    draft.set(null);
    source.freezePicked.and.resolveTo([step]);
    const reopened = TestBed.createComponent(ReliveCycleComponent);
    reopened.detectChanges();
    draft.set(oldCycle);
    reopened.detectChanges();
    await reopened.whenStable();
    expect(draft()!.steps).toEqual([step]);
    expect(picker.takeResult).toHaveBeenCalledTimes(1);
  });

  it('saves the draft before starting the matching definition', async () => {
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    draft.set(savedCycle);
    dirty.set(true);
    fixture.detectChanges();
    await fixture.componentInstance.startRun({ driver: 'AUTOMATIC' });
    expect(state.saveAsync).toHaveBeenCalled();
    expect(run.start).toHaveBeenCalledWith(savedCycle, jasmine.objectContaining({ driver: 'AUTOMATIC' }));
  });

  it('FR-044a: a save during a run of this cycle asks, and applies to that run on yes', async () => {
    run.run.set({ id: 'r-live', status: 'RUNNING', cycleId: 'c-1' });
    run.applyDefinitionEdit = jasmine.createSpy('applyDefinitionEdit').and.resolveTo(undefined);
    const confirm = TestBed.inject(ConfirmDialogService) as unknown as { confirm: jasmine.Spy };
    confirm.confirm = jasmine.createSpy('confirm').and.resolveTo(true);
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();

    await fixture.componentInstance.save();

    expect(confirm.confirm).toHaveBeenCalledWith(jasmine.any(String), 'Apply to this run too', 'Only next runs');
    expect(run.applyDefinitionEdit).toHaveBeenCalledWith(savedCycle, jasmine.any(String));
  });

  it('FR-044a: "Only next runs" leaves the running run alone', async () => {
    run.run.set({ id: 'r-live', status: 'RUNNING', cycleId: 'c-1' });
    run.applyDefinitionEdit = jasmine.createSpy('applyDefinitionEdit');
    const confirm = TestBed.inject(ConfirmDialogService) as unknown as { confirm: jasmine.Spy };
    confirm.confirm = jasmine.createSpy('confirm').and.resolveTo(false);
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();

    await fixture.componentInstance.save();

    expect(run.applyDefinitionEdit).not.toHaveBeenCalled();
  });

  function runningRun(id: string) {
    return {
      id,
      status: 'RUNNING' as const,
      definition: { variables: [] },
      seedVariables: [],
      variableTimeline: [],
      stepResults: [],
      hold: { stepKey: 'search', reason: 'FAILED' as const, since: 't' },
    };
  }

  it('opens the run this page is driving instead of a frozen history snapshot', () => {
    run.run.set({ id: 'r-live', status: 'RUNNING' });
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    fixture.componentInstance.openHistoryRun('r-live');
    expect(api.getRun).not.toHaveBeenCalled();
    expect(run.adopt).not.toHaveBeenCalled();
    expect(run.continueAdopted).toHaveBeenCalled();
    expect(fixture.componentInstance.historyRun()).toBeNull();
    expect(fixture.componentInstance.tab()).toBe('run');
  });

  it('reattaches a running run opened from history when this page is not driving it', () => {
    const full = runningRun('r-1');
    api.getRun.and.returnValue(of(full));
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    fixture.componentInstance.openHistoryRun('r-1');
    expect(run.adopt).toHaveBeenCalledWith(full);
    expect(run.continueAdopted).toHaveBeenCalled();
    expect(fixture.componentInstance.historyRun()).toBeNull();
    expect(fixture.componentInstance.tab()).toBe('run');
  });

  it('stays on the live driver when history resolves after this page already reattached that run', () => {
    const full = runningRun('r-1');
    api.getRun.and.callFake(() => {
      run.run.set({ id: 'r-1', status: 'RUNNING' });
      return of(full);
    });
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    fixture.componentInstance.openHistoryRun('r-1');
    expect(run.adopt).not.toHaveBeenCalled();
    expect(run.continueAdopted).toHaveBeenCalled();
    expect(fixture.componentInstance.historyRun()).toBeNull();
    expect(fixture.componentInstance.tab()).toBe('run');
  });

  it('reattaches a running run opened from history over an older interrupted run', () => {
    run.run.set({ id: 'r-old', status: 'INTERRUPTED' });
    const full = runningRun('r-1');
    api.getRun.and.returnValue(of(full));
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    fixture.componentInstance.openHistoryRun('r-1');
    expect(run.adopt).toHaveBeenCalledWith(full);
    expect(run.continueAdopted).toHaveBeenCalled();
    expect(fixture.componentInstance.historyRun()).toBeNull();
  });

  it('does not steal a different run this page is already driving', () => {
    run.run.set({ id: 'r-other', status: 'RUNNING' });
    const full = runningRun('r-1');
    api.getRun.and.returnValue(of(full));
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    fixture.componentInstance.openHistoryRun('r-1');
    expect(run.adopt).not.toHaveBeenCalled();
    expect(run.continueAdopted).not.toHaveBeenCalled();
    expect(fixture.componentInstance.historyRun()?.run.id).toBe('r-1');
    expect(fixture.componentInstance.tab()).toBe('run');
  });

  it('keeps a finished run opened from history as a snapshot', () => {
    const full = { ...runningRun('r-old'), status: 'INTERRUPTED' as const, hold: null };
    api.getRun.and.returnValue(of(full));
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    fixture.componentInstance.openHistoryRun('r-old');
    expect(run.adopt).not.toHaveBeenCalled();
    expect(run.continueAdopted).not.toHaveBeenCalled();
    expect(fixture.componentInstance.historyRun()?.run.id).toBe('r-old');
  });

  it('comes back to a running cycle and keeps following it', () => {
    const full = runningRun('r-1');
    api.listRuns.and.returnValue(of([{ id: 'r-1', status: 'RUNNING' }]));
    api.getRun.and.returnValue(of(full));
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    expect(run.retain).toHaveBeenCalledWith('r-1');
    expect(run.adopt).toHaveBeenCalledWith(full);
    expect(run.continueAdopted).toHaveBeenCalled();
    expect(fixture.componentInstance.tab()).toBe('run');
  });

  it('still opens an interrupted run on the step where it stopped', () => {
    const full = { ...runningRun('r-1'), status: 'INTERRUPTED' as const, hold: null };
    api.listRuns.and.returnValue(of([{ id: 'r-1', status: 'INTERRUPTED' }]));
    api.getRun.and.returnValue(of(full));
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    fixture.detectChanges();
    expect(run.adopt).toHaveBeenCalledWith(full);
    expect(run.continueAdopted).not.toHaveBeenCalled();
    expect(fixture.componentInstance.tab()).toBe('run');
  });

  it('rebuilds fingerprints only when a stored version is not current', () => {
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    const stale = {
      ...savedCycle,
      steps: [{ key: 'c-1', direction: 'outbound', recording: { url: 'https://supplier/search' }, fingerprintVersion: 'SEMANTIC_V0' }],
    } as unknown as ReliveCycle;
    draft.set(stale);
    saved.set(stale);
    dirty.set(false);
    fixture.detectChanges();
    expect(fixture.componentInstance.oldFingerprints()).toBe(1);
    fixture.componentInstance.rebuildFingerprints();
    expect(api.fingerprint).toHaveBeenCalledWith('c-1', true);
    expect(state.load).toHaveBeenCalledWith('c-1');

    api.fingerprint.calls.reset();
    dirty.set(true);
    fixture.componentInstance.rebuildFingerprints();
    expect(api.fingerprint).not.toHaveBeenCalled();

    draft.set({ ...stale, steps: [{ key: 'c-1', direction: 'outbound', recording: {}, fingerprintVersion: null }] } as unknown as ReliveCycle);
    expect(fixture.componentInstance.oldFingerprints()).toBe(0);
    expect(fixture.componentInstance.missingFingerprints()).toBe(1);
  });

  it('fingerprints supplier steps that have no hash, and not while the draft is dirty', () => {
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    const missing = {
      ...savedCycle,
      steps: [{ key: 'c-1', direction: 'outbound', recording: { url: 'https://supplier/search' }, fingerprintVersion: null }],
    } as unknown as ReliveCycle;
    draft.set(missing);
    saved.set(missing);
    dirty.set(false);
    fixture.detectChanges();
    expect(fixture.componentInstance.missingFingerprints()).toBe(1);
    fixture.componentInstance.stampFingerprints();
    expect(api.fingerprint).toHaveBeenCalledWith('c-1');
    expect(state.load).toHaveBeenCalledWith('c-1');

    api.fingerprint.calls.reset();
    dirty.set(true);
    fixture.componentInstance.stampFingerprints();
    expect(api.fingerprint).not.toHaveBeenCalled();
  });

  it('shows a failed start and keeps the run idle', async () => {
    const fixture = TestBed.createComponent(ReliveCycleComponent);
    draft.set(savedCycle);
    saved.set(savedCycle);
    fixture.detectChanges();
    run.start.and.rejectWith(new Error('upstream unavailable'));
    await fixture.componentInstance.startRun({ driver: 'AUTOMATIC' });
    expect(fixture.componentInstance.actionError()).toContain('upstream unavailable');
  });
});
