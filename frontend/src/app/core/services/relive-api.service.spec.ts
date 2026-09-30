import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { ReliveApiService, ReliveWriteRequest } from './relive-api.service';
import { CycleRule, GlobalRulesSelection, ReliveSettings, Step, UnexpectedCallsPolicy } from '../../shared/utils/relive-types';

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const globalRules: GlobalRulesSelection = { mode: 'NONE', selectedIds: [] };
const unexpectedCalls: UnexpectedCallsPolicy = { policy: 'BLOCK', rules: [], fallback: 'BLOCK' };

const cycle: ReliveWriteRequest = {
  name: 'Book flow',
  description: null,
  steps: [],
  variables: [],
  cycleRules: [],
  globalRules,
  settings,
  noise: [],
  unexpectedCalls,
};

describe('ReliveApiService', () => {
  let service: ReliveApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    service = TestBed.inject(ReliveApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('list() GETs /relive-cycles', () => {
    service.list().subscribe();
    const req = http.expectOne('http://backend/relive-cycles');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('create() with asTransient=true adds ?transient=true', () => {
    service.create(cycle, true).subscribe();
    const req = http.expectOne('http://backend/relive-cycles?transient=true');
    expect(req.request.method).toBe('POST');
    req.flush({});
  });

  it('create() can defer fingerprinting, and fingerprint() posts the cycle id', () => {
    service.create(cycle, true, true).subscribe();
    const created = http.expectOne('http://backend/relive-cycles?transient=true&deferFingerprint=true');
    expect(created.request.method).toBe('POST');
    created.flush({});
    service.fingerprint('c-1').subscribe();
    const stamped = http.expectOne('http://backend/relive-cycles/c-1/fingerprints');
    expect(stamped.request.method).toBe('POST');
    stamped.flush({});
    service.fingerprint('c-1', true).subscribe();
    const rebuilt = http.expectOne('http://backend/relive-cycles/c-1/fingerprints?rebuild=true');
    expect(rebuilt.request.method).toBe('POST');
    rebuilt.flush({});
  });

  it('wraps rules for the backend and unwraps them for the editor', () => {
    const rule: CycleRule = { name: 'replay', match: {}, actions: [], copiedFrom: { ruleId: 'r-1', name: 'source', copiedAt: '2026-01-01' } };
    const step: Step = {
      key: 's-1', parentKey: null, label: 'POST /search', enabled: true, optional: false, direction: 'inbound',
      callRule: rule, unattributed: 'BLOCK',
      recording: { method: 'POST', url: 'http://app/search', requestHeaders: {}, status: 200, responseHeaders: {}, timestamp: '2026-01-01', durationMs: 1, source: 'inbound' },
      source: { callId: 'call-1', cycleId: 'sc-1', direction: 'inbound' }, extract: [], assertions: [], noise: [],
    };
    let createdRule: CycleRule | undefined;
    service.create({ ...cycle, steps: [step], cycleRules: [rule], unexpectedCalls: { ...unexpectedCalls, rules: [rule] } })
      .subscribe((created) => createdRule = created.steps[0].callRule);
    const req = http.expectOne('http://backend/relive-cycles');
    expect(req.request.body.steps[0].callRule).toEqual({ rule: { name: 'replay', match: {}, actions: [] }, copiedFrom: rule.copiedFrom });
    expect(req.request.body.cycleRules[0].rule.name).toBe('replay');
    expect(req.request.body.unexpectedCalls.rules[0].rule.name).toBe('replay');
    req.flush({ ...cycle, id: 'c-1', steps: [{ ...step, callRule: req.request.body.steps[0].callRule }], cycleRules: req.request.body.cycleRules,
      unexpectedCalls: req.request.body.unexpectedCalls });
    expect(createdRule).toEqual(rule);
  });

  it('update() sets If-Match and, with a reason, appends ?reason=', () => {
    service.update('c-1', cycle, '2026-09-27T10:00:00Z', 'REBUILD_REFRESH').subscribe();
    const req = http.expectOne('http://backend/relive-cycles/c-1?reason=REBUILD_REFRESH');
    expect(req.request.method).toBe('PUT');
    expect(req.request.headers.get('If-Match')).toBe('2026-09-27T10:00:00Z');
    req.flush({});
  });

  it('update() without a reason omits the query param but keeps If-Match', () => {
    service.update('c-1', cycle, '2026-09-27T10:00:00Z').subscribe();
    const req = http.expectOne('http://backend/relive-cycles/c-1');
    expect(req.request.headers.get('If-Match')).toBe('2026-09-27T10:00:00Z');
    req.flush({});
  });

  it('resumeRun() POSTs afterStepKey to the run resume endpoint', () => {
    service.resumeRun('c-1', 'r-1', 's-search').subscribe();
    const req = http.expectOne('http://backend/relive-cycles/c-1/runs/r-1/resume');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ afterStepKey: 's-search' });
    req.flush({});
  });

  it('listLiveCalls() GETs the live-calls sub-resource with a limit, and reads the size header', () => {
    let result: { calls: readonly unknown[]; totalBytes: number } | undefined;
    service.listLiveCalls('c-1', 50).subscribe((r) => (result = r));
    const req = http.expectOne('http://backend/relive-cycles/c-1/live-calls?limit=50');
    expect(req.request.method).toBe('GET');
    req.flush([{ id: 'l-1' }], { headers: { 'X-Live-Calls-Bytes': '12345' } });
    expect(result!.calls.length).toBe(1);
    expect(result!.totalBytes).toBe(12345);
  });

  it('useAsRecording() POSTs the target stepKey', () => {
    service.useAsRecording('c-1', 'lv-1', 's-search').subscribe();
    const req = http.expectOne('http://backend/relive-cycles/c-1/live-calls/lv-1/use-as-recording');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ stepKey: 's-search' });
    req.flush({});
  });

  it('deleteLiveCall() DELETEs the live call id', () => {
    service.deleteLiveCall('c-1', 'lv-1').subscribe();
    const req = http.expectOne('http://backend/relive-cycles/c-1/live-calls/lv-1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });
});
