import { TestBed } from '@angular/core/testing';
import { CallRecord } from '../models/call.model';
import { RuleDraftService } from './rule-draft.service';

describe('RuleDraftService', () => {
  let service: RuleDraftService;

  const call = (overrides: Partial<CallRecord>): CallRecord => ({
    id: 'c1',
    original_url: 'https://api.supplier.com/v2/fares/quote?from=DXB',
    url: 'https://api.supplier.com/v2/fares/quote?from=DXB',
    method: 'post',
    timestamp: 't',
    duration_ms: 1,
    response: { status: 500 },
    source: 'external',
    ...overrides,
  });

  beforeEach(() => {
    service = TestBed.inject(RuleDraftService);
  });

  it('matches an outbound call by host, path without its query, and method', () => {
    service.start(call({}));
    expect(service.take()).toEqual({
      direction: 'outbound',
      callId: 'c1',
      method: 'POST',
      host: 'api.supplier.com',
      path: '/v2/fares/quote',
      serviceName: null,
    });
  });

  it("scopes an inbound call to its project instead of the reverse proxy's own host", () => {
    service.start(call({ id: 'in-1', url: 'http://localhost:8081/app/api/cart', source: 'internal', service_name: 'shop' }));
    const draft = service.take();
    expect(draft?.direction).toBe('inbound');
    expect(draft?.host).toBe('');
    expect(draft?.serviceName).toBe('shop');
  });

  it('hands a draft over once', () => {
    service.start(call({}));
    service.take();
    expect(service.take()).toBeNull();
  });
});
