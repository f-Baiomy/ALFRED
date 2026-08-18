import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StatsBarComponent } from './stats-bar.component';
import { CallListControlsState, CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { CallStats, CallStatusFilter } from '../../core/state/calls-state.service';

const EMPTY_STATS: CallStats = { total: 0, ok: 0, client: 0, failed: 0, inProgress: 0 };

describe('StatsBarComponent', () => {
  let setStatusFilterSpy: jasmine.Spy;

  function createComponent() {
    const fixture = TestBed.createComponent(StatsBarComponent);
    fixture.componentRef.setInput('stats', EMPTY_STATS);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    setStatusFilterSpy = jasmine.createSpy('setStatusFilter');

    const controlsStateStub: Partial<CallListControlsState> = {
      statusFilter: signal<CallStatusFilter>('all'),
      setStatusFilter: setStatusFilterSpy,
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
});
