import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { ScenarioCycleSourceService } from './scenario-cycle-source.service';

describe('ScenarioCycleSourceService', () => {
  let service: ScenarioCycleSourceService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    service = TestBed.inject(ScenarioCycleSourceService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('pages both directions, hydrates every call, and sorts oldest first', (done) => {
    service.loadHydrated('cyc1').subscribe((calls) => {
      expect(calls.map((c) => c.id)).toEqual(['e1', 'i1']);
      expect(calls[0].request?.body).toBe('req-e1');
      done();
    });

    const externalPage = http.expectOne((r) => r.url.includes('/session-cycles/cyc1/calls'));
    externalPage.flush({ calls: [{ id: 'cap-e1', capturedAt: 't', call: { id: 'e1', timestamp: '2026-01-01T00:00:01Z', method: 'GET', url: 'https://a', original_url: 'https://a', duration_ms: 1 } }], total: 1 });

    const internalPage = http.expectOne((r) => r.url.includes('/session-cycles/cyc1/internal-calls'));
    internalPage.flush({ calls: [{ id: 'cap-i1', capturedAt: 't', call: { id: 'i1', timestamp: '2026-01-01T00:00:02Z', method: 'GET', url: 'https://b', original_url: 'https://b', duration_ms: 1 } }], total: 1 });

    const detailE1 = http.expectOne((r) => r.url.includes('/calls/e1/detail'));
    detailE1.flush({ request: { headers: {}, body: 'req-e1' } });

    const detailI1 = http.expectOne((r) => r.url.includes('/internal-calls/i1/detail'));
    detailI1.flush({ request: { headers: {}, body: 'req-i1' } });
  });
});
