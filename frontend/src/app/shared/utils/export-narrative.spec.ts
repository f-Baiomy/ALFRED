import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { buildExportNarrative, depthSentence } from './export-narrative';

/**
 * The topology fixture these tests mostly work against, modelled on a real capture:
 *
 *   odeysys (inbound, 0 -> 22000)
 *     └─ core-service (inbound, 4000 -> 21000)
 *          ├─ sabre getBooking (external, 4100 -> 13400)
 *          └─ sabre checkFlightTickets (external, 13500 -> 21000)
 *
 * Times are relative to BASE so containment is readable at a glance rather than being buried in
 * ISO strings.
 */
const BASE = Date.parse('2026-09-13T17:59:06.000Z');

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString();
}

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'POST',
    timestamp: at(0),
    duration_ms: 100,
    response: { status: 200, headers: {}, body: '{}' },
    source: 'external',
    ...overrides,
  };
}

function odeysys(): CallRecord {
  return makeCall({
    id: 'odeysys',
    url: 'http://host.docker.internal:8080/odeysysadmin/v2/import-booked-pnr/read-pnr',
    source: 'internal',
    service_name: 'odeysys',
    state: 'COMPLETED',
    timestamp: at(0),
    duration_ms: 22000,
  });
}

function coreService(): CallRecord {
  return makeCall({
    id: 'core-service',
    method: 'GET',
    url: 'http://host.docker.internal:8083/api/v1/bookings/SYEADR',
    source: 'internal',
    service_name: 'core-service',
    state: 'COMPLETED',
    timestamp: at(4000),
    duration_ms: 17000,
  });
}

function getBooking(): CallRecord {
  return makeCall({
    id: 'get-booking',
    url: 'https://api.cert.platform.sabre.com/v1/trip/orders/getBooking',
    timestamp: at(4100),
    duration_ms: 9300,
  });
}

function checkTickets(): CallRecord {
  return makeCall({
    id: 'check-tickets',
    url: 'https://api.cert.platform.sabre.com/v1/trip/orders/checkFlightTickets',
    timestamp: at(13500),
    duration_ms: 7500,
  });
}

function nested(): CallRecord[] {
  return [odeysys(), coreService(), getBooking(), checkTickets()];
}

function narrativeOf(calls: readonly CallRecord[], commentsByCallId = new Map<string, readonly Comment[]>()) {
  return buildExportNarrative({ calls, commentsByCallId });
}

describe('buildExportNarrative', () => {
  describe('single-call exports', () => {
    it('names the direction, the counterparty and the outcome', () => {
      const narrative = narrativeOf([makeCall()]);

      expect(narrative.scope).toBe('single');
      expect(narrative.shape).toBe('outbound');
      expect(narrative.depth).toBe(1);
      expect(narrative.description).toContain('a single HTTP call');
      expect(narrative.description).toContain('an outbound call to the external host example.com');
      expect(narrative.description).toContain('It returned 200');
    });

    it('describes an inbound call by the service it arrived at, not by its host', () => {
      const narrative = narrativeOf([coreService()]);

      expect(narrative.shape).toBe('inbound');
      expect(narrative.description).toContain('an inbound call arriving at your service Core-service');
    });

    it('reports an error rather than a status when the call failed', () => {
      const narrative = narrativeOf([makeCall({ response: undefined, error: 'PKIX path building failed' })]);
      expect(narrative.description).toContain('It failed: PKIX path building failed');
    });

    it('says a call was still in flight rather than inventing an outcome for it', () => {
      const narrative = narrativeOf([makeCall({ response: undefined, state: 'IN_PROGRESS' })]);
      expect(narrative.description).toContain('still in progress when this export was taken');
    });

    // The whole reason a single-call export takes overlapCandidates - see NarrativeNotIncluded.
    it('describes the parent and nested calls the file itself does not contain', () => {
      const candidates: CallOverlapCandidate[] = [
        { id: 'odeysys', source: 'internal', serviceName: 'odeysys', timestamp: at(0), durationMs: 22000, status: 200, error: null },
        { id: 'get-booking', source: 'external', serviceName: null, timestamp: at(4100), durationMs: 9300, status: 200, error: null },
        { id: 'check-tickets', source: 'external', serviceName: null, timestamp: at(13500), durationMs: 7500, status: 200, error: null },
      ];

      const narrative = buildExportNarrative({
        calls: [coreService()],
        commentsByCallId: new Map(),
        overlapCandidates: candidates,
      });

      expect(narrative.notIncluded?.parent).toEqual({ service: 'odeysys', durationMs: 22000 });
      expect(narrative.notIncluded?.descendantCount).toBe(2);
      expect(narrative.notIncluded?.descendantOutbound).toBe(2);
      expect(narrative.description).toContain('inside a 22,000 ms inbound call to Odeysys');
      expect(narrative.description).toContain('2 calls nested inside this one');
    });

    it('leaves notIncluded null when there is no surrounding context to describe', () => {
      expect(narrativeOf([makeCall()]).notIncluded).toBeNull();
    });

    it('draws no tree and no timing table for one call', () => {
      const narrative = narrativeOf([makeCall()]);
      expect(narrative.treeLines).toEqual([]);
      expect(narrative.timingRows).toEqual([]);
      expect(depthSentence(narrative)).toBeNull();
    });
  });

  describe('multi-call exports', () => {
    it('reports depth and shape for a nested capture', () => {
      const narrative = narrativeOf(nested());

      expect(narrative.scope).toBe('multi');
      expect(narrative.depth).toBe(3);
      expect(narrative.shape).toBe('inbound -> inbound -> outbound');
      expect(depthSentence(narrative)).toBe('This capture is 3 levels deep: inbound → inbound → outbound.');
    });

    it('numbers topology nodes to match the export’s chronological summary table', () => {
      const narrative = narrativeOf(nested());
      const root = narrative.topology[0];

      expect(root.number).toBe(1);
      expect(root.children[0].number).toBe(2);
      expect(root.children[0].children.map((child) => child.number)).toEqual([3, 4]);
    });

    it('counts time spent waiting on downstream calls once, even when they overlap', () => {
      // Two children covering 4100-13400 and 13000-21000: overlapping, so the union is 16,900ms and
      // NOT the 17,200ms their durations sum to.
      const overlapping = [
        coreService(),
        getBooking(),
        makeCall({ id: 'check-tickets', url: 'https://api.cert.platform.sabre.com/v1/x', timestamp: at(13000), duration_ms: 8000 }),
      ];
      const core = narrativeOf(overlapping).topology[0];

      expect(core.downstreamMs).toBe(16900);
      expect(core.selfMs).toBe(100);
    });

    it('treats a leaf as having no downstream work rather than zero', () => {
      const leaf = narrativeOf(nested()).topology[0].children[0].children[0];
      expect(leaf.downstreamMs).toBeNull();
      expect(leaf.selfMs).toBeNull();
    });

    it('draws the topology with nesting and the export’s own call numbers', () => {
      const lines = narrativeOf(nested()).treeLines;

      expect(lines.length).toBe(4);
      expect(lines[0]).toContain('1. ▼ POST Odeysys · /odeysysadmin/v2/import-booked-pnr/read-pnr');
      expect(lines[1]).toContain('└─ 2. ▼ GET Core-service · /api/v1/bookings/SYEADR');
      expect(lines[2]).toContain('├─ 3. POST api.cert.platform.sabre.com · /v1/trip/orders/getBooking');
      expect(lines[3]).toContain('└─ 4. POST api.cert.platform.sabre.com · /v1/trip/orders/checkFlightTickets');
      expect(lines.every((line) => line.includes('200 ✅'))).toBeTrue();
    });

    it('falls back to a flat statement when nothing nests', () => {
      const flat = [makeCall({ id: 'a', timestamp: at(0) }), makeCall({ id: 'b', timestamp: at(5000) })];
      const narrative = narrativeOf(flat);

      expect(narrative.depth).toBe(1);
      expect(narrative.shape).toBe('outbound');
      expect(narrative.treeLines).toEqual([]);
      expect(narrative.timingRows).toEqual([]);
      expect(narrative.flowSummary).toContain('Depth 1 — flat');
      expect(narrative.timingNote).toContain('slowest');
    });

    it('says so plainly when only one side of the traffic was captured', () => {
      const narrative = narrativeOf([makeCall({ id: 'a' }), makeCall({ id: 'b', timestamp: at(5000) })]);
      expect(narrative.description).toContain('no inbound entry point was captured');
    });

    it('breaks down both directions when the capture has them', () => {
      const narrative = narrativeOf(nested());
      expect(narrative.description).toContain('2 inbound across 2 services');
      expect(narrative.description).toContain('2 outbound to 1 external host');
      expect(narrative.counts.services).toEqual(['Core-service', 'Odeysys']);
      expect(narrative.counts.externalHosts).toEqual(['api.cert.platform.sabre.com']);
    });

    it('reports mixed when one level holds both directions and no single chain describes it', () => {
      // A second child of odeysys that is external, alongside the inbound core-service.
      const calls = [
        ...nested(),
        makeCall({ id: 'token', url: 'https://auth.pp.travelport.net/oauth/token', timestamp: at(21500), duration_ms: 400 }),
      ];
      expect(narrativeOf(calls).shape).toBe('mixed');
    });
  });

  describe('caveats', () => {
    it('names failures rather than only counting them', () => {
      const calls = [...nested(), makeCall({ id: 'boom', response: { status: 502, headers: {}, body: '' }, timestamp: at(21500), duration_ms: 100 })];
      const caveats = narrativeOf(calls).caveats;

      expect(caveats.length).toBe(1);
      expect(caveats[0]).toContain('1 of 5 calls did not succeed');
      expect(caveats[0]).toContain('HTTP 502');
    });

    it('flags in-progress calls as absent by design', () => {
      const calls = [...nested(), makeCall({ id: 'pending', response: undefined, state: 'IN_PROGRESS', timestamp: at(21500) })];
      expect(narrativeOf(calls).caveats.join(' ')).toContain('still in progress');
    });

    it('is empty for a clean capture', () => {
      expect(narrativeOf(nested()).caveats).toEqual([]);
    });
  });

  describe('ordering note', () => {
    it('explains the request/response split only for calls the caller actually split', () => {
      const narrative = buildExportNarrative({
        calls: nested(),
        commentsByCallId: new Map(),
        splitCallIds: new Set(['odeysys', 'core-service']),
      });

      expect(narrative.orderingNote).toContain('2 calls in this export have downstream work');
      expect(narrative.orderingNote).toContain('· request');
    });

    it('says nothing about splitting when nothing was split', () => {
      expect(narrativeOf(nested()).orderingNote).toBeNull();
    });
  });

  describe('comments note', () => {
    it('always explains what a comment is', () => {
      expect(narrativeOf(nested()).commentsNote).toContain('human annotations added after the fact');
    });

    it('states there are none rather than staying silent', () => {
      expect(narrativeOf(nested()).commentsNote).toContain('no flagged lines');
    });

    it('counts flagged lines and the calls they sit on', () => {
      const comment: Comment = {
        id: 'c1',
        callId: 'odeysys',
        block: 'request-body',
        lineIndex: 0,
        lineText: '{',
        comment: 'wrong pcc',
        createdAt: at(0),
      };
      const narrative = narrativeOf(nested(), new Map([['odeysys', [comment, { ...comment, id: 'c2' }]]]));

      expect(narrative.commentsNote).toContain('2 flagged lines across 1 call');
      expect(narrative.counts.flaggedLines).toBe(2);
    });
  });

  describe('degenerate input', () => {
    it('survives an export with no calls', () => {
      const narrative = narrativeOf([]);
      expect(narrative.shape).toBe('empty');
      expect(narrative.description).toContain('no calls');
    });

    // One malformed timestamp must not cost the reader the whole section.
    it('omits the captured range rather than emitting an invalid date', () => {
      const narrative = narrativeOf([makeCall({ id: 'a', timestamp: 'not-a-date' }), makeCall({ id: 'b', timestamp: 'also-not' })]);

      expect(narrative.capturedFrom).toBeNull();
      expect(narrative.wallClockMs).toBeNull();
      expect(narrative.description).toContain('An Alfred export of 2 HTTP calls.');
    });
  });
});
