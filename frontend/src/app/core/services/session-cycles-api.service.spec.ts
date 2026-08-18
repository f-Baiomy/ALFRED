import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionCyclesApiService } from './session-cycles-api.service';
import { AppConfigService } from './app-config.service';
import { CallRecord } from '../models/call.model';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com/x',
    url: 'https://example.com/x',
    method: 'GET',
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 10,
    ...overrides,
  };
}

/**
 * copyCallsInto must split a mixed-source selection (possible once a 'both'-mode Live Calls
 * selection is duplicated into a cycle) into one request per source, since external and internal
 * calls only exist in their own backend store - see the method's own doc for why.
 */
describe('SessionCyclesApiService.copyCallsInto', () => {
  let service: SessionCyclesApiService;
  let httpMock: HttpTestingController;
  let backendUrl: string;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SessionCyclesApiService);
    httpMock = TestBed.inject(HttpTestingController);
    backendUrl = TestBed.inject(AppConfigService).backendUrl;
  });

  afterEach(() => httpMock.verify());

  it('an all-external selection (including calls with no source stamped) issues a single POST to /calls/copy', () => {
    const calls = [makeCall({ id: 'a' }), makeCall({ id: 'b', source: 'external' })];
    let result: { added: number; skipped: number } | undefined;

    service.copyCallsInto('cycle-1', calls).subscribe((r) => (result = r));

    const req = httpMock.expectOne(`${backendUrl}/session-cycles/cycle-1/calls/copy`);
    expect(req.request.body.calls.length).toBe(2);
    req.flush({ added: 2, skipped: 0 });

    expect(result).toEqual({ added: 2, skipped: 0 });
  });

  it('an all-internal selection issues a single POST to /internal-calls/copy', () => {
    const calls = [makeCall({ id: 'a', source: 'internal' })];

    service.copyCallsInto('cycle-1', calls).subscribe();

    const req = httpMock.expectOne(`${backendUrl}/session-cycles/cycle-1/internal-calls/copy`);
    req.flush({ added: 1, skipped: 0 });
  });

  it('a mixed selection issues one request per source and sums the results', () => {
    const calls = [
      makeCall({ id: 'a', source: 'external' }),
      makeCall({ id: 'b', source: 'internal' }),
      makeCall({ id: 'c', source: 'internal' }),
    ];
    let result: { added: number; skipped: number } | undefined;

    service.copyCallsInto('cycle-1', calls).subscribe((r) => (result = r));

    const externalReq = httpMock.expectOne(`${backendUrl}/session-cycles/cycle-1/calls/copy`);
    expect(externalReq.request.body.calls.length).toBe(1);
    externalReq.flush({ added: 1, skipped: 0 });

    const internalReq = httpMock.expectOne(`${backendUrl}/session-cycles/cycle-1/internal-calls/copy`);
    expect(internalReq.request.body.calls.length).toBe(2);
    internalReq.flush({ added: 1, skipped: 1 });

    expect(result).toEqual({ added: 2, skipped: 1 });
  });
});
