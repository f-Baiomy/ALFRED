import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { CallsApiService } from './calls-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';
import { ReliveCallSourceService } from './relive-call-source.service';

function call(id: string, source: 'internal' | 'external', startMs: number, durationMs: number): CallRecord {
  return {
    id, source, original_url: `http://app/${id}`, url: `http://app/${id}`, method: 'POST',
    timestamp: new Date(Date.parse('2026-01-01T00:00:00Z') + startMs).toISOString(), duration_ms: durationMs,
    response: { status: 200 }, state: 'COMPLETED', service_name: 'app',
  };
}

describe('ReliveCallSourceService', () => {
  let service: ReliveCallSourceService;
  let cycles: jasmine.SpyObj<SessionCyclesApiService>;
  let live: jasmine.SpyObj<CallsApiService>;

  beforeEach(() => {
    cycles = jasmine.createSpyObj<SessionCyclesApiService>('SessionCyclesApiService', ['listCalls', 'getDetail']);
    live = jasmine.createSpyObj<CallsApiService>('CallsApiService', ['getDetail', 'getSummary', 'getCallOverlaps']);
    TestBed.configureTestingModule({ providers: [
      ReliveCallSourceService,
      { provide: SessionCyclesApiService, useValue: cycles },
      { provide: CallsApiService, useValue: live },
    ] });
    service = TestBed.inject(ReliveCallSourceService);
  });

  it('loads both directions and every page before building the tree', async () => {
    const inbound = call('in', 'internal', 0, 1000);
    const many = Array.from({ length: 601 }, (_, i) => call(`out-${i}`, 'external', 100 + i, 1));
    cycles.listCalls.and.callFake((_id, query, source) => {
      if (source === 'internal') return of({ calls: [{ id: 'in', call: inbound, capturedAt: inbound.timestamp }], total: 1 });
      const page = many.slice(query.offset, query.offset + 200);
      return of({ calls: page.map((entry) => ({ id: entry.id, call: entry, capturedAt: entry.timestamp })), total: many.length });
    });
    const calls = await service.loadCycle('sc-1');
    expect(calls.length).toBe(602);
    expect(calls[0].id).toBe('in');
    expect(cycles.listCalls).toHaveBeenCalledWith('sc-1', jasmine.objectContaining({ offset: 600 }), 'external', undefined, true);
  });

  it('hydrates a picked session-cycle root and child from their own source', async () => {
    const inbound = call('in', 'internal', 0, 1000);
    const outbound = call('out', 'external', 100, 100);
    spyOn(service, 'loadCycle').and.resolveTo([inbound, outbound]);
    cycles.getDetail.and.callFake((_cycle, id) => of({ request: { headers: {}, body: id }, response: { status: 201, headers: { 'X-Source': id }, body: `reply-${id}` } }));
    const steps = await service.freezePicked([{ ref: { source: 'internal', callId: 'in', cycleId: 'sc-1' }, call: inbound, originLabel: 'cycle' }],
      { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] });
    expect(steps.length).toBe(2);
    expect(steps[1].parentKey).toBe(steps[0].key);
    expect(steps[1].recording.responseBody).toBe('reply-out');
    expect(steps[1].source.cycleId).toBe('sc-1');
    expect(cycles.getDetail).toHaveBeenCalledWith('sc-1', 'in', 'internal');
    expect(cycles.getDetail).toHaveBeenCalledWith('sc-1', 'out', 'external');
  });
});
