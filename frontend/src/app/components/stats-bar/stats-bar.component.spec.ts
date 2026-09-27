import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StatsBarComponent } from './stats-bar.component';
import { CallListControlsState, CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { CallStats, CallStatusFilter } from '../../core/state/calls-state.service';
import { ALL_INTERCEPTION_FILTER, InterceptionFilter, ResendFilter } from '../../core/state/call-list-view';

const EMPTY_STATS: CallStats = { total: 0, ok: 0, client: 0, failed: 0, inProgress: 0, intercepted: 0, resent: 0 };

describe('StatsBarComponent', () => {
  let setStatusFilterSpy: jasmine.Spy;
  let setInterceptionFilterSpy: jasmine.Spy;
  let setResendFilterSpy: jasmine.Spy;
  let interceptionFilterSignal: ReturnType<typeof signal<InterceptionFilter>>;
  let resendFilterSignal: ReturnType<typeof signal<ResendFilter>>;

  function createComponent(stats: CallStats = EMPTY_STATS) {
    const fixture = TestBed.createComponent(StatsBarComponent);
    fixture.componentRef.setInput('stats', stats);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    setStatusFilterSpy = jasmine.createSpy('setStatusFilter');
    setInterceptionFilterSpy = jasmine.createSpy('setInterceptionFilter');
    setResendFilterSpy = jasmine.createSpy('setResendFilter');
    interceptionFilterSignal = signal<InterceptionFilter>(ALL_INTERCEPTION_FILTER);
    resendFilterSignal = signal<ResendFilter>('all');

    const controlsStateStub: Partial<CallListControlsState> = {
      statusFilter: signal<CallStatusFilter>('all'),
      setStatusFilter: setStatusFilterSpy,
      interceptionFilter: interceptionFilterSignal,
      resendFilter: resendFilterSignal,
      setInterceptionFilter: setInterceptionFilterSpy,
      setResendFilter: setResendFilterSpy,
    };

    TestBed.configureTestingModule({
      imports: [StatsBarComponent],
      providers: [{ provide: CALL_LIST_CONTROLS_STATE, useValue: controlsStateStub }],
    });
  });

  it('showFilter() delegates to CALL_LIST_CONTROLS_STATE.setStatusFilter', () => {
    const fixture = createComponent();
    fixture.componentInstance.showFilter('ok');
    expect(setStatusFilterSpy).toHaveBeenCalledWith('ok');
  });

  it('clicking a pill in the template calls the matching handler', () => {
    const fixture = createComponent();
    spyOn(fixture.componentInstance, 'showFilter');
    const okButton: HTMLButtonElement = fixture.nativeElement.querySelector('.stat-pill.ok');

    okButton.click();

    expect(fixture.componentInstance.showFilter).toHaveBeenCalledWith('ok');
  });

  it('clicking the total pill shows all calls', () => {
    const fixture = createComponent();
    spyOn(fixture.componentInstance, 'showFilter');
    const totalButton: HTMLButtonElement = fixture.nativeElement.querySelector('.stat-pill:not(.ok):not(.warn):not(.err):not(.pending)');

    totalButton.click();

    expect(fixture.componentInstance.showFilter).toHaveBeenCalledWith('all');
  });

  it('hides the intercepted/resent pills when their counts are zero', () => {
    const fixture = createComponent();
    expect(fixture.nativeElement.querySelector('.stat-pill.intercepted')).toBeNull();
    expect(fixture.nativeElement.querySelector('.stat-pill.resent')).toBeNull();
  });

  it('shows and wires the intercepted pill when there are intercepted calls', () => {
    const fixture = createComponent({ ...EMPTY_STATS, total: 5, intercepted: 2 });
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.stat-pill.intercepted');
    expect(button.textContent).toContain('2');

    button.click();

    expect(setInterceptionFilterSpy).toHaveBeenCalledWith({ kind: 'intercepted' });
  });

  it('marks the intercepted pill active for both the intercepted and rule filter kinds', () => {
    const fixture = createComponent({ ...EMPTY_STATS, intercepted: 1 });
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.stat-pill.intercepted');
    expect(button.classList).not.toContain('active');

    interceptionFilterSignal.set({ kind: 'rule', ruleId: 'r-1', ruleName: 'Login token' });
    fixture.detectChanges();

    expect(button.classList).toContain('active');
  });

  it('shows and wires the resent pill when there are resent calls', () => {
    const fixture = createComponent({ ...EMPTY_STATS, resent: 3 });
    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.stat-pill.resent');
    expect(button.textContent).toContain('3');

    button.click();

    expect(setResendFilterSpy).toHaveBeenCalledWith('resent');
  });
});
