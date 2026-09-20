import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { InterceptionRule } from '../models/interception.model';
import { AppConfigService } from '../services/app-config.service';
import { InterceptionStateService } from './interception-state.service';

const BACKEND = 'http://backend.test:5000';

function rule(overrides: Partial<InterceptionRule> = {}): InterceptionRule {
  return {
    id: 'r1',
    name: 'Slow Sabre',
    enabled: true,
    priority: 10,
    stopProcessing: false,
    match: { source: 'outbound', host: '*.sabre.com', methods: ['POST'] },
    actions: [{ type: 'DELAY_REQUEST', durationMs: 5000 }],
    ...overrides,
  };
}

describe('InterceptionStateService', () => {
  let service: InterceptionStateService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: BACKEND } },
      ],
    });
    service = TestBed.inject(InterceptionStateService);
    http = TestBed.inject(HttpTestingController);
  });

  /**
   * The constructor fires three independent requests (rules, paused, master switch) plus the
   * action-type list on first read. Flushing them by URL rather than in order keeps these tests
   * from depending on subscription ordering, which is not part of the contract.
   */
  function flush(options: { rules?: InterceptionRule[]; paused?: unknown[]; enabled?: boolean } = {}): void {
    http.expectOne(`${BACKEND}/interception/rules`).flush(options.rules ?? []);
    http.expectOne(`${BACKEND}/interception/paused`).flush(options.paused ?? []);
    http.expectOne(`${BACKEND}/interception/enabled`).flush({ enabled: options.enabled ?? false });
    // Read lazily by the editor's action picker, but subscribed eagerly by toSignal.
    http.match(`${BACKEND}/interception/action-types`).forEach((r) => r.flush([]));
  }

  afterEach(() => {
    http.verify({ ignoreCancelled: true });
  });

  it('loads rules, paused calls and the master switch on construction', () => {
    flush({ rules: [rule()], enabled: true });

    expect(service.rules().length).toBe(1);
    expect(service.masterSwitch()).toBeTrue();
    expect(service.pausedCount()).toBe(0);
  });

  it('defaults the master switch to off when the backend cannot be reached', () => {
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
    http.expectOne(`${BACKEND}/interception/enabled`).error(new ProgressEvent('offline'));
    http.match(`${BACKEND}/interception/action-types`).forEach((r) => r.flush([]));

    // A feature that can change live traffic must never read as ON because a request failed.
    expect(service.masterSwitch()).toBeFalse();
  });

  it('is not active until BOTH the master switch is on and a rule is enabled', () => {
    flush({ rules: [rule({ enabled: false })], enabled: true });

    expect(service.masterSwitch()).toBeTrue();
    expect(service.enabledRuleCount()).toBe(0);
    expect(service.active()).toBeFalse();
  });

  it('counts only enabled rules that can hold a caller open', () => {
    flush({
      rules: [
        rule({ id: 'a', actions: [{ type: 'PAUSE_RESPONSE', timeoutSeconds: 30, onTimeout: 'release' }] }),
        rule({ id: 'b', enabled: false, actions: [{ type: 'PAUSE_REQUEST', timeoutSeconds: 30 }] }),
        rule({ id: 'c' }),
      ],
      enabled: true,
    });

    expect(service.pausingRuleCount()).toBe(1);
  });

  it('turns a rejected rule into the problems signal rather than an error', () => {
    flush();

    let result: InterceptionRule | null | undefined;
    service
      .createRule({ name: '', match: {}, actions: [] })
      .subscribe((value) => (result = value));

    http.expectOne(`${BACKEND}/interception/rules`).flush(
      { error: 'invalid-rule', problems: ['A rule needs a name.', 'A rule needs at least one action.'] },
      { status: 400, statusText: 'Bad Request' }
    );

    expect(result).toBeNull();
    expect(service.problems().length).toBe(2);
    expect(service.saving()).toBeFalse();
  });

  it('clears previous problems when a save is retried', () => {
    flush();

    service.createRule({ name: '', match: {}, actions: [] }).subscribe();
    http.expectOne(`${BACKEND}/interception/rules`).flush(
      { problems: ['A rule needs a name.'] },
      { status: 400, statusText: 'Bad Request' }
    );
    expect(service.problems().length).toBe(1);

    service.createRule({ name: 'Fixed', match: {}, actions: [{ type: 'DELAY_REQUEST', durationMs: 1 }] }).subscribe();
    expect(service.problems().length).toBe(0);

    http.expectOne(`${BACKEND}/interception/rules`).flush(rule());
    http.expectOne(`${BACKEND}/interception/rules`).flush([rule()]);
  });

  it('posts a pause decision to the call it belongs to', () => {
    flush();

    service.decide('call-1', { action: 'release', body: '{"status":"FAILED"}' }).subscribe();

    const request = http.expectOne(`${BACKEND}/interception/paused/call-1/decision`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body.action).toBe('release');
    expect(request.request.body.body).toContain('FAILED');
    request.flush(null);

    http.expectOne(`${BACKEND}/interception/paused`).flush([]);
  });

  describe('duplicating a rule', () => {
    it('copies everything about it under a distinguishable name', () => {
      flush({ rules: [rule()] });

      service.duplicateRule(rule()).subscribe();

      const request = http.expectOne({ method: 'POST', url: `${BACKEND}/interception/rules` });
      expect(request.request.body.name).toBe('Slow Sabre (copy)');
      expect(request.request.body.match).toEqual(rule().match);
      expect(request.request.body.actions).toEqual(rule().actions);
      expect(request.request.body.priority).toBe(10);
      request.flush(rule({ id: 'r2', name: 'Slow Sabre (copy)' }));
      http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    });

    it('keeps the original switched-on state rather than landing inert', () => {
      // You duplicate a rule to change one thing about it, not to get a skeleton you then have
      // to remember to switch on.
      flush({ rules: [rule({ enabled: true })] });

      service.duplicateRule(rule({ enabled: true })).subscribe();

      const request = http.expectOne({ method: 'POST', url: `${BACKEND}/interception/rules` });
      expect(request.request.body.enabled).toBeTrue();
      request.flush(rule({ id: 'r2' }));
      http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    });

    it('copies a disabled rule as disabled', () => {
      flush({ rules: [rule({ enabled: false })] });

      service.duplicateRule(rule({ enabled: false })).subscribe();

      const request = http.expectOne({ method: 'POST', url: `${BACKEND}/interception/rules` });
      expect(request.request.body.enabled).toBeFalse();
      request.flush(rule({ id: 'r2' }));
      http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    });

    it('does not collide with a copy that already exists', () => {
      flush({ rules: [rule(), rule({ id: 'r2', name: 'Slow Sabre (copy)' })] });

      service.duplicateRule(rule()).subscribe();

      const request = http.expectOne({ method: 'POST', url: `${BACKEND}/interception/rules` });
      expect(request.request.body.name).toBe('Slow Sabre (copy 2)');
      request.flush(rule({ id: 'r3' }));
      http.expectOne(`${BACKEND}/interception/rules`).flush([]);
    });
  });

  it('imports a whole file in one request and refetches once', () => {
    flush();

    service.importRules([{ name: 'A', match: {}, actions: [] }], false).subscribe();

    const request = http.expectOne(`${BACKEND}/interception/rules/import`);
    expect(request.request.body).toEqual({ rules: [{ name: 'A', match: {}, actions: [] }], enable: false });
    request.flush({ imported: 1, rejected: 0, results: [] });
    http.expectOne(`${BACKEND}/interception/rules`).flush([]);
  });

  it('sends the master switch and reflects what the backend actually stored', () => {
    flush({ enabled: false });

    service.setMasterSwitch(true);

    const request = http.expectOne(`${BACKEND}/interception/enabled`);
    expect(request.request.body).toEqual({ enabled: true });
    request.flush({ enabled: true });

    expect(service.masterSwitch()).toBeTrue();
  });
});
