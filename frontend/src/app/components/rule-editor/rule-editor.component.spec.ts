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

  /**
   * Turning one action off without deleting it - the request that started this. Every action
   * defaults to enabled, so nothing here changes what an already-saved rule does until somebody
   * actually clicks the switch.
   */
  describe('enabling and disabling one action', () => {
    it('defaults every action to enabled', () => {
      open();
      component.addAction('DELAY_REQUEST');

      expect(component.isActionEnabled(component.actions()[1])).toBeTrue();
    });

    it('toggles a top-level action off and back on', () => {
      open();
      component.addAction('DELAY_REQUEST');

      component.toggleEnabled([1]);
      expect(component.actions()[1].enabled).toBeFalse();

      component.toggleEnabled([1]);
      expect(component.isActionEnabled(component.actions()[1])).toBeTrue();
    });

    it('toggles a nested action without touching its siblings', () => {
      open();
      component.addAction('IF_REQUEST');
      component.addBranchAction([1], 0, 'DELAY_REQUEST');
      component.addBranchAction([1], 0, 'SEND_TO_HOST');

      component.toggleEnabled([1, 0, 0]);

      const nested = component.actions()[1].branches?.[0].actions ?? [];
      expect(nested[0].enabled).toBeFalse();
      expect(component.isActionEnabled(nested[1])).toBeTrue();
    });

    it('disabling a conditional only sets its OWN flag - the subtree is skipped by the engine, not edited', () => {
      // proxy/interception.py never even parses a disabled action's branches - the UI does not
      // need to (and must not) reach in and flip every nested action too, or a plain action's own
      // switch would stop meaning what it says the moment an ancestor is re-enabled.
      open();
      component.addAction('IF_REQUEST');
      component.addBranchAction([1], 0, 'DELAY_REQUEST');

      component.toggleEnabled([1]);

      expect(component.actions()[1].enabled).toBeFalse();
      expect(component.isActionEnabled(component.actions()[1].branches![0].actions[0])).toBeTrue();
    });
  });

  /**
   * Moving an action between scopes - top-level, a branch, an ELSE IF, the ELSE - by dragging it.
   * onActionDropped/canDropInto are exercised directly with hand-built CDK event shapes rather
   * than a simulated pointer drag: the logic under test is the tree surgery, which does not care
   * how the drop arrived.
   */
  describe('dragging an action between scopes', () => {
    /**
     * Loads a rule with an EXACT action tree, rather than building one up through addAction -
     * the seeded new-rule DELAY_REQUEST (see ngOnInit) is one action these tests do not want to
     * have to account for in every path.
     */
    function openWith(actions: RuleAction[]): void {
      open({
        id: 'r1',
        name: 'Drag test',
        enabled: true,
        priority: 100,
        stopProcessing: false,
        match: {},
        actions,
      });
    }

    /** actionAt is private to the module, not the component - read the tree straight from the signal. */
    function stepAt(path: readonly number[]) {
      let list: readonly RuleAction[] = component.actions();
      let action: RuleAction | undefined;
      let index = 0;
      const rest = [...path];
      while (rest.length > 0) {
        index = rest.shift()!;
        action = list[index];
        const branchIndex = rest.shift();
        if (branchIndex === undefined) break;
        list = branchIndex < 0 ? action!.otherwise ?? [] : action!.branches?.[branchIndex]?.actions ?? [];
      }
      return { action: action!, index, path };
    }

    function drop(draggedPath: readonly number[], toId: string, currentIndex: number): void {
      component.onActionDropped({
        item: { data: stepAt(draggedPath) },
        container: { id: toId },
        currentIndex,
      } as unknown as Parameters<RuleEditorComponent['onActionDropped']>[0]);
    }

    it('reorders within the same top-level lane', () => {
      openWith([{ type: 'DELAY_REQUEST', durationMs: 5000 }, { type: 'SEND_TO_HOST' }]);

      drop([0], component.laneListId('request'), 1);

      expect(component.actions().map((a) => a.type)).toEqual(['SEND_TO_HOST', 'DELAY_REQUEST']);
    });

    it('moves a top-level action into a branch', () => {
      openWith([
        { type: 'DELAY_REQUEST', durationMs: 5000 },
        { type: 'IF_REQUEST', branches: [{ combine: 'ALL', conditions: [], actions: [] }] },
      ]);

      drop([0], component.listId([1, 0]), 0);

      expect(component.actions().map((a) => a.type)).toEqual(['IF_REQUEST']);
      expect(component.actions()[0].branches?.[0].actions.map((a) => a.type)).toEqual(['DELAY_REQUEST']);
    });

    it('moves a nested action back out to the top level, in the right lane', () => {
      openWith([
        {
          type: 'IF_REQUEST',
          branches: [{ combine: 'ALL', conditions: [], actions: [{ type: 'DELAY_REQUEST', durationMs: 5000 }] }],
        },
      ]);

      drop([0, 0, 0], component.laneListId('request'), 0);

      expect(component.actions().map((a) => a.type)).toEqual(['DELAY_REQUEST', 'IF_REQUEST']);
      expect(component.actions()[1].branches?.[0].actions).toEqual([]);
    });

    it('moves an action from one branch straight into another', () => {
      openWith([
        {
          type: 'IF_REQUEST',
          branches: [
            { combine: 'ALL', conditions: [], actions: [{ type: 'DELAY_REQUEST', durationMs: 5000 }] },
            { combine: 'ALL', conditions: [], actions: [] },
          ],
        },
      ]);

      drop([0, 0, 0], component.listId([0, 1]), 0);

      expect(component.actions()[0].branches?.[0].actions).toEqual([]);
      expect(component.actions()[0].branches?.[1].actions.map((a) => a.type)).toEqual(['DELAY_REQUEST']);
    });

    it('moves an action into the ELSE', () => {
      openWith([
        { type: 'IF_REQUEST', branches: [{ combine: 'ALL', conditions: [], actions: [] }] },
        { type: 'DELAY_REQUEST', durationMs: 5000 },
      ]);

      drop([1], component.listId([0, -1]), 0);

      expect(component.actions().map((a) => a.type)).toEqual(['IF_REQUEST']);
      expect(component.actions()[0].otherwise?.map((a) => a.type)).toEqual(['DELAY_REQUEST']);
    });

    it('preserves the action being moved, enabled state and all', () => {
      openWith([
        { type: 'DELAY_REQUEST', durationMs: 5000, enabled: false },
        { type: 'IF_REQUEST', branches: [{ combine: 'ALL', conditions: [], actions: [] }] },
      ]);

      drop([0], component.listId([1, 0]), 0);

      const moved = component.actions()[0].branches?.[0].actions[0];
      expect(moved?.type).toBe('DELAY_REQUEST');
      expect(moved?.durationMs).toBe(5000);
      expect(component.isActionEnabled(moved!)).toBeFalse();
    });

    describe('canDropInto', () => {
      const dragOf = (action: RuleAction) => ({ data: { action, index: 0, path: [0] } } as unknown as Parameters<
        RuleEditorComponent['canDropInto']
      >[0]);
      const dropAt = (id: string) => ({ id } as unknown as Parameters<RuleEditorComponent['canDropInto']>[1]);

      it('accepts a request-phase action into the request lane, refuses it in the response lane', () => {
        openWith([]);
        const action: RuleAction = { type: 'DELAY_REQUEST', durationMs: 1000 };

        expect(component.canDropInto(dragOf(action), dropAt(component.laneListId('request')))).toBeTrue();
        expect(component.canDropInto(dragOf(action), dropAt(component.laneListId('response')))).toBeFalse();
      });

      it('accepts a response-phase action into an IF_RESPONSE branch, refuses it into an IF_REQUEST one', () => {
        openWith([
          { type: 'IF_REQUEST', branches: [{ combine: 'ALL', conditions: [], actions: [] }] },
          { type: 'IF_RESPONSE', branches: [{ combine: 'ALL', conditions: [], actions: [] }] },
        ]);
        const responseAction: RuleAction = { type: 'SET_RESPONSE_STATUS', status: 500 };

        expect(component.canDropInto(dragOf(responseAction), dropAt(component.listId([0, 0])))).toBeFalse();
        expect(component.canDropInto(dragOf(responseAction), dropAt(component.listId([1, 0])))).toBeTrue();
      });

      it('refuses a conditional dropped past the depth the backend allows', () => {
        openWith([
          {
            type: 'IF_REQUEST',
            branches: [
              {
                combine: 'ALL',
                conditions: [],
                actions: [{ type: 'IF_REQUEST', branches: [{ combine: 'ALL', conditions: [], actions: [] }] }],
              },
            ],
          },
        ]);
        const conditional: RuleAction = { type: 'IF_REQUEST', branches: [] };

        // One level in is still fine...
        expect(component.canDropInto(dragOf(conditional), dropAt(component.listId([0, 0])))).toBeTrue();
        // ...two levels in is the depth the backend refuses to save.
        expect(component.canDropInto(dragOf(conditional), dropAt(component.listId([0, 0, 0, 0])))).toBeFalse();
      });
    });

    it('connects every list currently in the tree, and only those', () => {
      openWith([
        {
          type: 'IF_REQUEST',
          branches: [
            { combine: 'ALL', conditions: [], actions: [] },
            { combine: 'ALL', conditions: [], actions: [] },
          ],
          otherwise: [{ type: 'DELAY_REQUEST', durationMs: 5000 }],
        },
      ]);

      const ids = component.dropListIds();

      expect(ids).toContain(component.laneListId('request'));
      expect(ids).toContain(component.laneListId('response'));
      expect(ids).toContain(component.listId([0, 0]));
      expect(ids).toContain(component.listId([0, 1]));
      expect(ids).toContain(component.listId([0, -1]));
      expect(ids.length).toBe(5);
    });
  });
});
