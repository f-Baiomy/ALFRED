import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { ReliveApiService, ReliveWriteRequest } from './relive-api.service';
import { GlobalRulesSelection, ReliveSettings, UnexpectedCallsPolicy } from '../../shared/utils/relive-types';

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
