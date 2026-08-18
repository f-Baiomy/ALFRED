import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CallsApiService } from './calls-api.service';
import { AppConfigService } from './app-config.service';
import { CallsQuery } from '../state/call-list-view';

const QUERY: CallsQuery = {
  search: '',
  supplier: '',
  sort: 'newest',
  offset: 0,
  limit: 50,
  sessionId: '',
  operationId: '',
  requestId: '',
};

/**
 * getCalls/getDetail default to the 'external' source, which must keep hitting the exact same
 * GET /calls and GET /calls/{id}/detail URLs as before the source param existed - every existing
 * call site (CallsStateService's original behavior) relies on that default. The 'internal' source
 * is the only other thing CallsApiService itself is responsible for - it just targets
 * GET /internal-calls instead, since backend-internal-calls mirrors the same DTO shapes exactly.
 */
describe('CallsApiService', () => {
  let service: CallsApiService;
  let httpMock: HttpTestingController;
  let backendUrl: string;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CallsApiService);
    httpMock = TestBed.inject(HttpTestingController);
    backendUrl = TestBed.inject(AppConfigService).backendUrl;
  });

  afterEach(() => httpMock.verify());

  it('getCalls defaults to GET /calls (external), unchanged from before the source param existed', () => {
    service.getCalls(QUERY).subscribe();
    const req = httpMock.expectOne((r) => r.url === `${backendUrl}/calls`);
    expect(req.request.method).toBe('GET');
    req.flush({ calls: [], total: 0 });
  });

  it('getCalls with source "external" also hits GET /calls', () => {
    service.getCalls(QUERY, 'external').subscribe();
    const req = httpMock.expectOne((r) => r.url === `${backendUrl}/calls`);
    req.flush({ calls: [], total: 0 });
  });

  it('getCalls with source "internal" hits GET /internal-calls instead', () => {
    service.getCalls(QUERY, 'internal').subscribe();
    const req = httpMock.expectOne((r) => r.url === `${backendUrl}/internal-calls`);
    expect(req.request.method).toBe('GET');
    req.flush({ calls: [], total: 0 });
  });

  it('getDetail defaults to GET /calls/{id}/detail (external)', () => {
    service.getDetail('call-1').subscribe();
    const req = httpMock.expectOne(`${backendUrl}/calls/call-1/detail`);
    req.flush({});
  });

  it('getDetail with source "internal" hits GET /internal-calls/{id}/detail', () => {
    service.getDetail('call-1', 'internal').subscribe();
    const req = httpMock.expectOne(`${backendUrl}/internal-calls/call-1/detail`);
    req.flush({});
  });
});
