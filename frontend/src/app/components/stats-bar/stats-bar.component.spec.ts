import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { StatsBarComponent } from './stats-bar.component';
import { CallRecord } from '../../core/models/call.model';
import { CallListControlsState, BulkSelectionState, CALL_LIST_CONTROLS_STATE, BULK_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { CallStats } from '../../core/state/calls-state.service';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'GET',
    timestamp: '2026-01-01T00:00:00.000000+00:00',
    duration_ms: 100,
    response: { status: 200 },
    ...overrides,
  };
}

const EMPTY_STATS: CallStats = { total: 0, ok: 0, client: 0, failed: 0, inProgress: 0 };

describe('StatsBarComponent', () => {
  let selectOnlySpy: jasmine.Spy;
  let calls: CallRecord[];

  function createComponent() {
    const fixture = TestBed.createComponent(StatsBarComponent);
    fixture.componentRef.setInput('stats', EMPTY_STATS);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    calls = [
      makeCall({ id: 'ok-1', response: { status: 200 } }),
      makeCall({ id: 'client-1', response: { status: 404 } }),
      makeCall({ id: 'server-1', response: { status: 500 } }),
      makeCall({ id: 'error-1', response: undefined, error: 'boom' }),
      makeCall({ id: 'pending-1', response: undefined, state: 'IN_PROGRESS' }),
    ];
    selectOnlySpy = jasmine.createSpy('selectOnly');

    const controlsStateStub: Partial<CallListControlsState> = {
      matchingCalls: signal(calls),
    };
    const bulkSelectionStub: Partial<BulkSelectionState> = {
      selectOnly: selectOnlySpy,
    };

    TestBed.configureTestingModule({
      imports: [StatsBarComponent],
      providers: [
        { provide: CALL_LIST_CONTROLS_STATE, useValue: controlsStateStub },
        { provide: BULK_SELECTION_STATE, useValue: bulkSelectionStub },
      ],
    });
  });

  it('selectTotal() selects every currently-loaded call', () => {
    const fixture = createComponent();
    fixture.componentInstance.selectTotal();
    expect(selectOnlySpy).toHaveBeenCalledWith(calls);
  });

  it('selectOk() selects only 2xx/3xx calls', () => {
    const fixture = createComponent();
    fixture.componentInstance.selectOk();
    expect(selectOnlySpy).toHaveBeenCalledWith([calls[0]]);
  });

  it('selectClientError() selects only 4xx calls', () => {
    const fixture = createComponent();
    fixture.componentInstance.selectClientError();
    expect(selectOnlySpy).toHaveBeenCalledWith([calls[1]]);
  });

  it('selectFailed() selects 5xx and errored calls', () => {
    const fixture = createComponent();
    fixture.componentInstance.selectFailed();
    expect(selectOnlySpy).toHaveBeenCalledWith([calls[2], calls[3]]);
  });

  it('selectInProgress() selects only in-progress calls', () => {
    const fixture = createComponent();
    fixture.componentInstance.selectInProgress();
    expect(selectOnlySpy).toHaveBeenCalledWith([calls[4]]);
  });

  it('clicking a pill in the template calls the matching handler', () => {
    const fixture = createComponent();
    spyOn(fixture.componentInstance, 'selectOk');
    const okButton: HTMLButtonElement = fixture.nativeElement.querySelector('.stat-pill.ok');

    okButton.click();

    expect(fixture.componentInstance.selectOk).toHaveBeenCalled();
  });
});
