import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CallRecord } from '../models/call.model';
import { AppConfigService } from './app-config.service';
import { CallRefDetailService } from './call-ref-detail.service';

const BACKEND = 'http://backend.test:5000';

describe('CallRefDetailService', () => {
  let service: CallRefDetailService;
  let http: HttpTestingController;
  const summary: CallRecord = { id: 'c1', original_url: 'u', url: 'https://a.com/x', method: 'GET', timestamp: 't', duration_ms: 1 };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: BACKEND } }],
    });
    service = TestBed.inject(CallRefDetailService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads a live inbound call from the internal-calls log', () => {
    let result: CallRecord | undefined;
    service.hydrate({ source: 'internal', callId: 'c1', cycleId: null }, summary).subscribe((c) => (result = c));
    http.expectOne(`${BACKEND}/internal-calls/c1/detail`).flush({ request: { body: 'req' }, response: { status: 201 } });
    expect(result?.request?.body).toBe('req');
    expect(result?.response?.status).toBe(201);
    expect(result?.source).toBe('internal');
  });

  it("loads a cycle's captured copy from that cycle, not the live log", () => {
    service.hydrate({ source: 'external', callId: 'c1', cycleId: 'cy1' }, summary).subscribe();
    http.expectOne((r) => r.url.endsWith('/session-cycles/cy1/calls/c1/detail')).flush({});
  });
});
