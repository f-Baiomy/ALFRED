import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';
import { AppConfigService } from '../../core/services/app-config.service';
import { BULK_SELECTION_STATE, BulkSelectionState, CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
import { ReliveSelectionDialogService } from '../../core/services/relive-selection-dialog.service';
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
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
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

  it('T071: reliveAddToCycle() hydrates the selection and opens the Relive cycle picker in ADD mode', () => {
    component.reliveAddToCycle();

    const picker = TestBed.inject(ReliveSelectionDialogService);
    expect(picker.state()?.mode).toBe('ADD');
    expect(picker.state()?.calls.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(component.reliveLoading()).toBeFalse();
  });

  it('creates a Relive cycle from selected calls and navigates to it', () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.reliveNewCycle();
    const req = http.expectOne(`${BACKEND}/relive-cycles`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body.steps.length).toBe(3);
    expect(req.request.body.steps[0].callRule.rule.actions).toEqual(jasmine.any(Array));
    req.flush({ id: 'relive-1', steps: [], cycleRules: [], unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' } });
    expect(navigate).toHaveBeenCalledWith(['/relive', 'relive-1']);
  });

  it('shows a recoverable error when cycle creation fails', () => {
    component.reliveNewCycle();
    http.expectOne(`${BACKEND}/relive-cycles`).flush({ message: 'invalid' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain('Could not create a Relive cycle');
  });
});
