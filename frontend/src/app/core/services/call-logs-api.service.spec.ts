import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { CallLogsApiService } from './call-logs-api.service';

const BACKEND = 'http://localhost:1';

describe('CallLogsApiService', () => {
  let api: CallLogsApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: BACKEND } }],
    });
    api = TestBed.inject(CallLogsApiService);
    http = TestBed.inject(HttpTestingController);
  });

  it('pages a call\'s lines, for a cycle copy too', () => {
    api.lines('c 1', { cycleId: 'cy', after: 'c:9', limit: 50 }).subscribe();
    const req = http.expectOne((r) => r.url === `${BACKEND}/call-logs/c%201`);
    expect(req.request.params.get('cycleId')).toBe('cy');
    expect(req.request.params.get('after')).toBe('c:9');
    expect(req.request.params.get('limit')).toBe('50');
  });

  it('asks counts for many calls in one request', () => {
    api.counts(['a', 'b']).subscribe();
    expect(http.expectOne((r) => r.url === `${BACKEND}/call-logs/counts`).request.params.get('callIds')).toBe('a,b');
  });
});
