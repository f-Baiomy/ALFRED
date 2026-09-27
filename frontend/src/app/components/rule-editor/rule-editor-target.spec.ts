import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AppConfigService } from '../../core/services/app-config.service';
import { ActionType, InterceptionRuleDraft } from '../../core/models/interception.model';
import { RuleEditorComponent } from './rule-editor.component';
import { RULE_EDITOR_TARGET, RuleEditorTarget } from './rule-editor-target';

const BACKEND = 'http://backend.test:5000';

/**
 * D14's guard test: the action catalog comes from the server (`GET /interception/action-types`),
 * never from a list Relive keeps of its own - so a type ALFRED adds tomorrow is offered and saved
 * in a Relive scope with no change here. Also proves `RULE_EDITOR_TARGET` fully replaces
 * `InterceptionStateService` as the save path for a non-GLOBAL scope.
 */
describe('RuleEditorComponent: RULE_EDITOR_TARGET (research D14)', () => {
  let fixture: ComponentFixture<RuleEditorComponent>;
  let component: RuleEditorComponent;
  let http: HttpTestingController;
  let target: jasmine.SpyObj<RuleEditorTarget>;

  beforeEach(() => {
    target = jasmine.createSpyObj<RuleEditorTarget>('RuleEditorTarget', ['save']);
    TestBed.configureTestingModule({
      imports: [RuleEditorComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
        { provide: RULE_EDITOR_TARGET, useValue: target },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(RuleEditorComponent);
    component = fixture.componentInstance;
  });

  function open(): void {
    component.scope = 'CALL';
    fixture.detectChanges();
    http.match(`${BACKEND}/interception/rules`).forEach((r) => r.flush([]));
    http.match(`${BACKEND}/interception/paused`).forEach((r) => r.flush([]));
    http.match(`${BACKEND}/interception/enabled`).forEach((r) => r.flush({ enabled: true }));
    http.match(`${BACKEND}/interception/sensitive-headers`).forEach((r) => r.flush({ names: [] }));
    // A type this frontend's own ActionType union has never heard of - stands in for "ALFRED added
    // an action after this build shipped". Cast through `unknown` since it is, by definition, not
    // yet a member of the union.
    http.match(`${BACKEND}/interception/action-types`).forEach((r) =>
      r.flush([{ type: 'FUTURE_ACTION_TYPE', phase: 'request', terminal: false, pause: false, selectable: true }]),
    );
    http.match(`${BACKEND}/internal-calls/services`).forEach((r) => r.flush([]));
    fixture.detectChanges();
  }

  it('offers a server-reported action type this build has never heard of', () => {
    open();
    expect(component.requestActionTypes()).toContain('FUTURE_ACTION_TYPE' as unknown as ActionType);
  });

  it('saves a rule using that type through RULE_EDITOR_TARGET, in CALL scope', () => {
    target.save.and.returnValue(of({ id: 'r-1' } as unknown as InterceptionRuleDraft));
    open();

    component.addAction('FUTURE_ACTION_TYPE' as unknown as ActionType);
    component.save();

    expect(target.save).toHaveBeenCalledTimes(1);
    const [draft, ruleId] = target.save.calls.mostRecent().args;
    expect(ruleId).toBeNull();
    expect((draft as InterceptionRuleDraft).actions.some((a) => (a.type as unknown as string) === 'FUTURE_ACTION_TYPE')).toBeTrue();
  });

  it('never calls InterceptionStateService directly when a target is provided', () => {
    const httpTestingController = http; // still the only HTTP surface touched by open()'s flushes
    target.save.and.returnValue(of(null));
    open();
    component.save();
    httpTestingController.verify();
    expect().nothing();
  });
});
