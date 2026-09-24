import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AppConfigService } from '../../core/services/app-config.service';
import { BULK_SELECTION_STATE, BulkSelectionState, CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
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

  it('opens the resend editor on the selection, in order, hydrated - and sends nothing yet', () => {
    component.resendSelected();

    const bulk = TestBed.inject(BulkResendDialogService);
    expect(bulk.visible()).toBeTrue();
    expect(bulk.drafts().map((d) => d.ref.callId)).toEqual(['c1', 'c2', 'c3']);
    expect(bulk.drafts()[1].ref.source).toBe('internal');
    expect(bulk.drafts().every((d) => d.ref.cycleId === null)).toBeTrue();
    expect(component.resendLoading()).toBeFalse();
    http.expectNone(`${BACKEND}/resend`);
  });
});
