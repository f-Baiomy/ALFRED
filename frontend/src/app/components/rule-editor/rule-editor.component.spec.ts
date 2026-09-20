import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { InterceptionRule, RuleAction } from '../../core/models/interception.model';
import { RuleEditorComponent } from './rule-editor.component';

const BACKEND = 'http://backend.test:5000';

/**
 * The editor's tree surgery, which is where conditionals get interesting: an action inside a
 * branch inside an action is addressed by a path, and every edit, move and delete has to land on
 * exactly the slot that path names.
 */
describe('RuleEditorComponent', () => {
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

  /** Everything the editor fetches on open, so each test can get on with the part it cares about. */
  function open(rule: InterceptionRule | null = null): void {
    component.rule = rule;
    fixture.detectChanges();
    http.match(`${BACKEND}/interception/rules`).forEach((r) => r.flush([]));
    http.match(`${BACKEND}/interception/paused`).forEach((r) => r.flush([]));
    http.match(`${BACKEND}/interception/enabled`).forEach((r) => r.flush({ enabled: true }));
    // The picker is built from what the backend reports, so the fixture has to report something:
    // an empty list would make every "what can go here" assertion vacuously pass.
    http.match(`${BACKEND}/interception/action-types`).forEach((r) =>
      r.flush([
        { type: 'DELAY_REQUEST', phase: 'request', terminal: false, pause: false, selectable: true },
        { type: 'MOCK_RESPONSE', phase: 'request', terminal: true, pause: false, selectable: true },
        { type: 'SEND_TO_HOST', phase: 'request', terminal: false, pause: false, selectable: true },
        { type: 'ABORT_REQUEST', phase: 'request', terminal: true, pause: false, selectable: false },
        { type: 'IF_REQUEST', phase: 'request', terminal: false, pause: false, selectable: true },
        { type: 'SET_RESPONSE_STATUS', phase: 'response', terminal: false, pause: false, selectable: true },
        { type: 'IF_RESPONSE', phase: 'response', terminal: false, pause: false, selectable: true },
      ])
    );
    http.match(`${BACKEND}/internal-calls/services`).forEach((r) =>
      r.flush([
        { name: 'odeysys', listenPort: 8081, upstreamPort: 8080, enabled: true },
        { name: 'core-service', listenPort: 8083, upstreamPort: 8082, enabled: true },
        { name: 'unknown', listenPort: null, upstreamPort: null, enabled: true },
      ])
    );
    fixture.detectChanges();
  }

  afterEach(() => http.verify({ ignoreCancelled: true }));

  const first = (): RuleAction => component.actions()[0];

  it('offers only configured projects, not the catch-all bucket', () => {
    // "unknown" is where traffic that arrived on no configured listener lands - not a project
    // anybody would scope a rule to.
    open();

    expect(component.projectOptions().map((o) => o.value)).toEqual(['odeysys', 'core-service']);
  });

  it('starts a new conditional with one branch and one working condition', () => {
    // A conditional with no branches is the one shape the backend always rejects, and an empty
    // IF explains nothing about what it is for.
    open();
    component.addAction('IF_REQUEST');

    const action = component.actions()[1];
    expect(action.branches?.length).toBe(1);
    expect(action.branches?.[0].conditions.length).toBe(1);
    expect(action.branches?.[0].conditions[0].subject).toBe('REQUEST_HEADER');
  });

  it('defaults a response conditional to a condition about the response', () => {
    open();
    component.addAction('IF_RESPONSE');

    expect(component.actions()[1].branches?.[0].conditions[0].subject).toBe('RESPONSE_STATUS');
  });

  it('hides response subjects from a request-phase condition', () => {
    // There is no response yet, so a condition on one could only ever be false.
    open();
    component.addAction('IF_REQUEST');

    const subjects = component.subjectOptions([1]).map((o) => o.value);
    expect(subjects).toContain('REQUEST_HEADER');
    expect(subjects).not.toContain('RESPONSE_STATUS');
  });

  it('offers response subjects in the response half, including request ones', () => {
    open();
    component.addAction('IF_RESPONSE');

    const subjects = component.subjectOptions([1]).map((o) => o.value);
    expect(subjects).toContain('RESPONSE_STATUS');
    expect(subjects).toContain('REQUEST_HEADER');
  });

  it('drops a stale name when the subject stops needing one', () => {
    // A leftover header name on a METHOD condition would be saved, ignored, and look like it was
    // doing something.
    open();
    component.addAction('IF_REQUEST');
    component.onSubjectChange([1], 0, 0, 'METHOD');

    expect(component.actions()[1].branches?.[0].conditions[0].name).toBeNull();
  });

  it('clears the value when the operator stops comparing one', () => {
    open();
    component.addAction('IF_REQUEST');
    component.onOperatorChange([1], 0, 0, 'EQUALS');
    component.onConditionText([1], 0, 0, 'value', { target: { value: 'abc' } } as unknown as Event);
    expect(component.actions()[1].branches?.[0].conditions[0].value).toBe('abc');

    component.onOperatorChange([1], 0, 0, 'EXISTS');
    expect(component.actions()[1].branches?.[0].conditions[0].value).toBeNull();
  });

  it('adds an action into the branch it was asked for, not the top level', () => {
    open();
    component.addAction('IF_REQUEST');
    component.addBranchAction([1], 0, 'DELAY_REQUEST');

    expect(component.actions().length).toBe(2);
    expect(component.actions()[1].branches?.[0].actions[0].type).toBe('DELAY_REQUEST');
  });

  it('adds to the ELSE when the branch index is -1', () => {
    open();
    component.addAction('IF_REQUEST');
    component.addBranchAction([1], -1, 'SEND_TO_HOST');

    expect(component.actions()[1].otherwise?.[0].type).toBe('SEND_TO_HOST');
  });

  it('edits a nested action through its path and leaves its siblings alone', () => {
    open();
    component.addAction('IF_REQUEST');
    component.addBranchAction([1], 0, 'DELAY_REQUEST');
    component.addBranchAction([1], 0, 'DELAY_REQUEST');

    component.patchAt([1, 0, 1], { durationMs: 9999 });

    const nested = component.actions()[1].branches?.[0].actions ?? [];
    expect(nested[0].durationMs).toBe(5000);
    expect(nested[1].durationMs).toBe(9999);
  });

  it('removes and reorders a nested action without touching the top level', () => {
    open();
    component.addAction('IF_REQUEST');
    component.addBranchAction([1], 0, 'DELAY_REQUEST');
    component.addBranchAction([1], 0, 'SEND_TO_HOST');

    component.moveAt([1, 0, 1], -1);
    expect(component.actions()[1].branches?.[0].actions.map((a) => a.type))
      .toEqual(['SEND_TO_HOST', 'DELAY_REQUEST']);

    component.removeAt([1, 0, 0]);
    expect(component.actions()[1].branches?.[0].actions.map((a) => a.type)).toEqual(['DELAY_REQUEST']);
    expect(component.actions().length).toBe(2);
  });

  it('stops offering a nested condition at the depth the backend refuses', () => {
    open();
    component.addAction('IF_REQUEST');

    expect(component.nestableTypes([1])).toContain('IF_REQUEST');
    // One level in, another condition would be the third level - which cannot be saved.
    expect(component.nestableTypes([1, 0, 0])).not.toContain('IF_REQUEST');
  });

  it('still says the host is reached when only a BRANCH would short-circuit', () => {
    // The branch may not be taken, so the response half is perfectly live - greying it out would
    // be a lie about what the rule does.
    open();
    component.addAction('IF_REQUEST');
    component.addBranchAction([1], 0, 'MOCK_RESPONSE');

    expect(component.reachesHost()).toBeTrue();

    component.addAction('MOCK_RESPONSE');
    expect(component.reachesHost()).toBeFalse();
  });

  it('loads an existing conditional rule back into the form it is edited with', () => {
    const rule: InterceptionRule = {
      id: 'r1',
      name: 'Key check',
      enabled: true,
      priority: 100,
      stopProcessing: false,
      match: { source: 'outbound', serviceNames: ['odeysys'] },
      actions: [
        {
          type: 'IF_REQUEST',
          branches: [
            {
              combine: 'ANY',
              conditions: [{ subject: 'REQUEST_HEADER', name: 'x-api-key', operator: 'NOT_EXISTS' }],
              actions: [{ type: 'MOCK_RESPONSE', status: 401, body: '{}' }],
            },
          ],
          otherwise: [{ type: 'SEND_TO_HOST' }],
        },
      ],
    };
    open(rule);

    expect(component.serviceNames()).toEqual(['odeysys']);
    expect(first().branches?.[0].combine).toBe('ANY');
    expect(first().branches?.[0].actions[0].status).toBe(401);
    expect(first().otherwise?.[0].type).toBe('SEND_TO_HOST');
  });

  it('saves the project list rather than the single name it replaced', () => {
    open();
    component.name.set('A rule');
    component.serviceNames.set(['odeysys', 'core-service']);
    component.save();

    const request = http.expectOne(`${BACKEND}/interception/rules`);
    expect(request.request.body.match.serviceNames).toEqual(['odeysys', 'core-service']);
    expect(request.request.body.match.serviceName).toBeUndefined();
    request.flush({ ...request.request.body, id: 'new' });
    http.match(`${BACKEND}/interception/rules`).forEach((r) => r.flush([]));
  });
});
