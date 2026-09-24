import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AppConfigService } from '../../core/services/app-config.service';
import { BULK_SELECTION_STATE, BulkSelectionState, CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { BulkActionsBarComponent } from './bulk-actions-bar.component';

const BACKEND = 'http://backend.test:5000';

function call(id: string, source: 'external' | 'internal' = 'external'): CallRecord {
  return { id, original_url: `https://a.com/${id}`, url: `https://a.com/${id}`, method: 'GET', timestamp: 't', duration_ms: 1, source };
}

describe('BulkActionsBarComponent - resend selected', () => {
  let fixture: ComponentFixture<BulkActionsBarComponent>;
  let component: BulkActionsBarComponent;
  let http: HttpTestingController;
  let selected: CallRecord[];

  beforeEach(() => {
    selected = [call('c1'), call('c2', 'internal'), call('c3')];
    const bulkState: BulkSelectionState = {
      selectedCalls: () => selected,
      selectAll: () => {},
      clearSelection: () => {},
    };
    TestBed.configureTestingModule({
      imports: [BulkActionsBarComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
        { provide: BULK_SELECTION_STATE, useValue: bulkState },
        {
          provide: CALL_LIST_CONTROLS_STATE,
          useValue: { getCallDetail: () => of({}), getCallOverlaps: () => of([]) },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(BulkActionsBarComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => http.verify());

  it('sends the calls one at a time, in selection order, and awaits each before the next', () => {
    component.resendSelected();
    expect(component.resendLoading()).toBeTrue();

    const first = http.expectOne(`${BACKEND}/resend`);
    expect(first.request.body.callId).toBe('c1');
    expect(first.request.body.direction).toBe('outbound');
    http.expectNone((r) => r.url === `${BACKEND}/resend` && r.body?.callId === 'c2');
    first.flush({ newCallId: 'n1', status: 200, durationMs: 5, sessionValuesUsed: [] });
    expect(component.resendProgress()).toBe(1);

    const second = http.expectOne(`${BACKEND}/resend`);
    expect(second.request.body.callId).toBe('c2');
    expect(second.request.body.direction).toBe('inbound');
    second.flush({ newCallId: 'n2', status: 200, durationMs: 5, sessionValuesUsed: [] });
    expect(component.resendProgress()).toBe(2);

    const third = http.expectOne(`${BACKEND}/resend`);
    expect(third.request.body.callId).toBe('c3');
    third.flush({ newCallId: 'n3', status: 200, durationMs: 5, sessionValuesUsed: [] });

    expect(component.resendProgress()).toBe(3);
    expect(component.resendLoading()).toBeFalse();
    expect(component.resendStoppedEarly()).toBeFalse();
  });

  it('stops after the first failure and does not send the remaining calls', () => {
    component.resendSelected();

    const first = http.expectOne(`${BACKEND}/resend`);
    first.flush({ error: 'reverse-proxy-not-running' }, { status: 409, statusText: 'Conflict' });

    http.expectNone(`${BACKEND}/resend`);
    expect(component.resendProgress()).toBe(1);
    expect(component.resendStoppedEarly()).toBeTrue();
    expect(component.resendLoading()).toBeFalse();
  });
});
