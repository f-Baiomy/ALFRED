import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { CallPickerService, PickResult } from '../../core/services/call-picker.service';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
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

  beforeEach(() => {
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
    run = { start: jasmine.createSpy('start').and.resolveTo(undefined), run: signal(null) };
    TestBed.configureTestingModule({
      imports: [ReliveCycleComponent],
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'c-1' } } } },
        { provide: CallPickerService, useValue: picker },
        { provide: ReliveCallSourceService, useValue: source },
        { provide: ConfirmDialogService, useValue: {} },
        { provide: ReliveApiService, useValue: {} },
        { provide: InterceptionStateService, useValue: { pausedCalls: signal([]) } },
        { provide: ReliveRuleDialogService, useValue: { request: signal(null) } },
      ],
    });
    TestBed.overrideComponent(ReliveCycleComponent, { set: {
      template: '', imports: [], providers: [
        { provide: ReliveCycleEditorState, useValue: state },
        { provide: ReliveRunService, useValue: run },
      ],
    } });
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
