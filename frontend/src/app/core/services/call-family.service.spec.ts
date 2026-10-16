import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CallOverlapCandidate, CallRecord } from '../models/call.model';
import { CallFamily, CallFamilyService, familySize } from './call-family.service';
import { CallsApiService } from './calls-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

const T0 = Date.parse('2026-10-15T10:00:00Z');
function call(id: string, source: 'internal' | 'external', service: string | null, startMs: number, durMs: number, parentCallId?: string): CallRecord {
  return { id, source, service_name: service, method: 'GET', url: `http://x/${id}`, timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durMs, response: { status: 200 }, ...(parentCallId ? { parentCallId } : {}) } as unknown as CallRecord;
}
const cand = (c: CallRecord): CallOverlapCandidate => ({ id: c.id, source: c.source as 'internal' | 'external', serviceName: c.service_name ?? null,
  timestamp: c.timestamp, durationMs: c.duration_ms ?? 0, status: 200, error: null });

// odeysys (0-5400) calls core-service (1000-3000), which calls a supplier (1200-1800); odeysys also calls amadeus itself.
const ROOT = call('root', 'internal', 'odeysys', 0, 5400);
const MID = call('mid', 'internal', 'core', 1000, 2000);
const LEAF = call('leaf', 'external', 'core', 1200, 600, 'mid');
const OWN = call('own', 'external', 'odeysys', 300, 400, 'root');
const ELSEWHERE = call('later', 'internal', 'odeysys', 9000, 100);
const ALL = [ROOT, MID, LEAF, OWN, ELSEWHERE];

describe('CallFamilyService (the call popup\'s waterfall, specs/025)', () => {
  let overlaps: jasmine.Spy;
  let summaries: jasmine.Spy;

  function create(): CallFamilyService {
    overlaps = jasmine.createSpy('getCallOverlaps').and.callFake((q: { from: string; to: string }) => {
      const from = Date.parse(q.from);
      const to = Date.parse(q.to);
      return of(ALL.filter((c) => {
        const s = Date.parse(c.timestamp);
        return s <= to && s + (c.duration_ms ?? 0) >= from;
      }).map(cand));
    });
    summaries = jasmine.createSpy('getSummary').and.callFake((id: string) => of(ALL.find((c) => c.id === id)!));
    TestBed.configureTestingModule({
      providers: [
        { provide: CallsApiService, useValue: { getCallOverlaps: overlaps, getSummary: summaries } },
        { provide: SessionCyclesApiService, useValue: {} },
      ],
    });
    return TestBed.inject(CallFamilyService);
  }

  function load(svc: CallFamilyService, c: CallRecord): CallFamily {
    let out: CallFamily | null = null;
    svc.load(c, null).subscribe((f) => (out = f));
    return out!;
  }

  it('from the top call: every level under it, nested as Live Calls nests them', () => {
    const f = load(create(), ROOT);
    expect(f.root.call.id).toBe('root');
    expect(f.root.children.map((n) => n.call.id)).toEqual(['own', 'mid']);
    expect(f.root.children[1].children.map((n) => n.call.id)).toEqual(['leaf']);
    expect(familySize(f.root)).toEqual({ calls: 3, levels: 2 });
    expect(f.calls.map((c) => c.id)).not.toContain('later');
  });

  it('a call deep in the tree opens the whole tree from its top call', () => {
    const f = load(create(), LEAF);
    expect(f.root.call.id).toBe('root');
    expect(f.calls.map((c) => c.id).sort()).toEqual(['leaf', 'mid', 'own', 'root']);
  });

  it('a call alone is its own tree of one line', () => {
    const f = load(create(), ELSEWHERE);
    expect(f.root.call.id).toBe('later');
    expect(familySize(f.root)).toEqual({ calls: 0, levels: 0 });
  });
});
