import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { RuleEditorComponent } from './rule-editor.component';

const BACKEND = 'http://backend.test:5000';

/** T031's frontend row: "request matches a recorded call" (RECORDED_CALL), offered in the
 *  Condition editor like any other subject, with its own recordedStepKey/headers fields instead
 *  of the generic name/value pair. */
describe('RuleEditorComponent: RECORDED_CALL condition row', () => {
  let fixture: ComponentFixture<RuleEditorComponent>;
  let component: RuleEditorComponent;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RuleEditorComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RuleEditorComponent);
    component = fixture.componentInstance;
  });

  function open(): void {
    fixture.detectChanges();
    http.match(`${BACKEND}/interception/rules`).forEach((r) => r.flush([]));
    http.match(`${BACKEND}/interception/paused`).forEach((r) => r.flush([]));
    http.match(`${BACKEND}/interception/enabled`).forEach((r) => r.flush({ enabled: true }));
    http.match(`${BACKEND}/interception/sensitive-headers`).forEach((r) => r.flush({ names: [] }));
    http.match(`${BACKEND}/interception/action-types`).forEach((r) =>
      r.flush([{ type: 'IF_REQUEST', phase: 'request', terminal: false, pause: false, selectable: true }]),
    );
    http.match(`${BACKEND}/internal-calls/services`).forEach((r) => r.flush([]));
  }

  it('is offered as a subject option', () => {
    open();
    const options = component.subjectOptions([]);
    expect(options.some((o) => o.value === 'RECORDED_CALL')).toBeTrue();
  });

  it('needs neither a name nor the generic value field', () => {
    open();
    const condition = { subject: 'RECORDED_CALL' as const, operator: 'MATCHES' as const, recordedStepKey: 's-search' };
    expect(component.needsConditionName(condition)).toBeFalse();
    expect(component.needsConditionValue(condition)).toBeFalse();
    expect(component.isRecordedCallCondition(condition)).toBeTrue();
  });

  it('setRecordedCallStepKey / setRecordedCallCompareHeaders patch the condition in place', () => {
    open();
    component.actions.set([
      { type: 'IF_REQUEST', enabled: true, branches: [{ conditions: [{ subject: 'RECORDED_CALL', operator: 'MATCHES' }], actions: [] }], otherwise: [] },
    ]);

    component.setRecordedCallStepKey([0], 0, 0, 's-search');
    component.setRecordedCallCompareHeaders([0], 0, 0, true);

    const condition = component.actions()[0].branches![0].conditions[0];
    expect(condition.recordedStepKey).toBe('s-search');
    expect(condition.headers).toBeTrue();
  });
});
