import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import {
  buildBulkExportPayload,
  BulkExportRequestEvent,
  BulkExportResponseEvent,
  BulkExportCallEvent,
} from './bulk-json-builder';

/** A candidate genuinely contained in a call's [timestamp, timestamp + duration_ms] window - external by default, so it never trips the same-service exclusion regardless of the target's own service_name (see bulk-json-builder.ts's own isContainedOverlap/eventsForCall). */
function makeCandidate(overrides: Partial<CallOverlapCandidate> = {}): CallOverlapCandidate {
  return {
    id: 'nested-candidate',
    source: 'external',
    serviceName: null,
    // Same start as the default makeCall()'s 100ms duration, covering 80% of it with a 20ms tail.
    timestamp: '2026-08-07T13:45:51.965328+00:00',
    durationMs: 80,
    status: 200,
    error: null,
    ...overrides,
  };
}

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'POST',
    request: { headers: {}, body: '{}' },
    timestamp: '2026-08-07T13:45:51.965328+00:00',
    duration_ms: 100,
    response: { status: 200, headers: {}, body: '{}' },
    ...overrides,
  };
}

function makeForm(overrides: Partial<ExportFormData> = {}): ExportFormData {
  return {
    supplierName: 'FlyNas',
    credentialsUsed: 'EGY',
    apiKey: 'secret-key',
    url: 'https://example.com/api/x',
    environment: 'Staging',
    description: '',
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    callId: 'call-1',
    block: 'request-body',
    lineIndex: 0,
    lineText: '{',
    comment: 'note',
    createdAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildBulkExportPayload', () => {
  // Content is exercised in export-narrative.spec.ts - this pins that `about` reaches the payload,
  // survives JSON.stringify (it is what the file actually gets written as) and stays readable
  // standalone, which is the whole reason an agent is given `description`.
  it('carries the About narrative as the payload’s own first-class section', () => {
    const payload = buildBulkExportPayload([makeCall()], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    expect(payload.about.documentType).toBe('alfred-call-export');
    expect(payload.about.scope).toBe('single');
    expect(payload.about.description).toContain('a single HTTP call');
    expect(payload.about.readingGuide.comments).toContain('lineIndex is 0-based');
    expect(JSON.parse(JSON.stringify(payload)).about.description).toBe(payload.about.description);
  });

  it('describes the topology it emitted events for', () => {
    const parent = makeCall({
      id: 'parent',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-08-07T13:45:51.965328+00:00',
      duration_ms: 100,
    });
    const child = makeCall({ id: 'child', timestamp: '2026-08-07T13:45:51.985328+00:00', duration_ms: 50 });
    const payload = buildBulkExportPayload([parent, child], makeForm(), new Map(), '2026-08-07T18:00:00Z', [makeCandidate({ id: 'child' })]);

    expect(payload.about.scope).toBe('multi');
    expect(payload.about.depth).toBe(2);
    expect(payload.about.shape).toBe('inbound -> outbound');
    expect(payload.about.topology[0].children[0].callId).toBe('child');
  });

  it('carries the metadata form and exportedAt through verbatim', () => {
    const form = makeForm({ supplierName: 'FlyNas' });
    const payload = buildBulkExportPayload([makeCall()], form, new Map(), '2026-08-07T18:00:00Z');

    expect(payload.metadata).toEqual(form);
    expect(payload.exportedAt).toBe('2026-08-07T18:00:00Z');
  });

  it('computes summary counts and total duration across all calls', () => {
    const ok = makeCall({ duration_ms: 100, response: { status: 200, headers: {}, body: '' } });
    const failed = makeCall({ timestamp: 't2', duration_ms: 50, response: undefined, error: 'x' });
    const payload = buildBulkExportPayload([ok, failed], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    expect(payload.summary).toEqual({ callCount: 2, succeeded: 1, failed: 1, totalDurationMs: 150 });
  });

  it('an external call produces exactly one "call" event, never split', () => {
    const call = makeCall({ source: 'external' });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    expect(payload.events.length).toBe(1);
    const event = payload.events[0] as BulkExportCallEvent;
    expect(event.type).toBe('call');
    expect(event.callId).toBe(call.id);
    expect(event.request).toEqual(call.request);
    expect(event.response).toEqual(call.response);
  });

  it('a resolved internal call produces exactly a request+response event pair sharing callId', () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', [makeCandidate()], 'all');

    expect(payload.events.length).toBe(2);
    const [reqEvent, resEvent] = payload.events as [BulkExportRequestEvent, BulkExportResponseEvent];
    expect(reqEvent.type).toBe('request');
    expect(reqEvent.callId).toBe(call.id);
    expect(reqEvent.request).toEqual(call.request);
    expect(resEvent.type).toBe('response');
    expect(resEvent.callId).toBe(call.id);
    expect(resEvent.response).toEqual(call.response);
    expect(resEvent.status).toBe(200);
    // response timestamp = request timestamp + duration_ms
    expect(new Date(resEvent.timestamp).getTime()).toBe(new Date(call.timestamp).getTime() + call.duration_ms);
  });

  it('an internal call resolved via error (no response) still produces a request+response pair', () => {
    const call = makeCall({ source: 'internal', response: undefined, error: 'boom' });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', [makeCandidate()], 'all');

    expect(payload.events.length).toBe(2);
    const resEvent = payload.events[1] as BulkExportResponseEvent;
    expect(resEvent.type).toBe('response');
    expect(resEvent.error).toBe('boom');
    expect(resEvent.status).toBeUndefined();
  });

  it('an internal in-progress call produces only a request event, no fabricated response', () => {
    const call = makeCall({ source: 'internal', response: undefined, error: undefined, state: 'IN_PROGRESS' });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    expect(payload.events.length).toBe(1);
    expect(payload.events[0].type).toBe('request');
  });

  it('a resolved internal call merges into a single "call" event when no overlap candidate is genuinely contained in its window - the default when none is passed', () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    expect(payload.events.length).toBe(1);
    const event = payload.events[0] as BulkExportCallEvent;
    expect(event.type).toBe('call');
    expect(event.callId).toBe(call.id);
    expect(event.response).toEqual(call.response);
  });

  it('a resolved internal call merges into a single "call" event when every contained candidate shares its own service name', () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const sameServiceCandidate = makeCandidate({ source: 'internal', serviceName: 'core-service' });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', [sameServiceCandidate], 'all');

    expect(payload.events.length).toBe(1);
    expect(payload.events[0].type).toBe('call');
  });

  it('a resolved internal call stays split for a fan-out of children', () => {
    // Mirrors call-utils.spec.ts's fan-out case - the parent farmed work out to several suppliers in
    // parallel and then post-processed for longer than any one of them took.
    const call = makeCall({ source: 'internal', service_name: 'odeysys', timestamp: '2026-08-07T10:00:00.000Z', duration_ms: 27000 });
    const suppliers = [1780, 1141, 1683].map((durationMs, i) =>
      makeCandidate({ id: `supplier-${i}`, timestamp: '2026-08-07T10:00:04.000Z', durationMs })
    );

    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', suppliers, 'all');
    expect(payload.events.map((e) => e.type)).toEqual(['request', 'response']);
  });

  it('stays split for a LONE child that accounts for only a fraction of the parent', () => {
    // Reported from a real export: a 24.84s odeysys call whose single child was a 2.86s core-service
    // call came out as one unsplit "call" event while the waterfall bracketed it, because the child
    // covered 11.5% of the parent and a since-removed "blocking signature" check demanded >=30%.
    // That 11.5% is the finding - odeysys spent 80% of itself before calling anything - not grounds
    // for hiding the structure. Split == has children now, exactly as call-tree.ts decides it.
    const call = makeCall({ source: 'internal', service_name: 'odeysys', timestamp: '2026-08-07T10:00:00.000Z', duration_ms: 24841 });
    const child = makeCandidate({
      id: 'core-service',
      source: 'internal',
      serviceName: 'core-service',
      timestamp: '2026-08-07T10:00:19.770Z',
      durationMs: 2856,
    });

    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', [child], 'all');
    expect(payload.events.map((e) => e.type)).toEqual(['request', 'response']);
  });

  it('splits every call of a nested chain, not just the outermost one', () => {
    // Reported from a real export: odeysys came out split, but the core-service call nested inside
    // it - which is what actually made the two supplier calls - came out as one unsplit "call"
    // event, because both owners lost those suppliers to the ambiguity veto.
    const odeysys = makeCall({
      id: 'odeysys',
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 11396,
    });
    const coreService = makeCall({
      id: 'core',
      source: 'internal',
      service_name: 'core-service',
      state: 'COMPLETED',
      timestamp: '2026-01-01T00:00:01.090Z',
      duration_ms: 10246,
    });
    const candidates = [
      makeCandidate({ id: 'core', source: 'internal', serviceName: 'core-service', timestamp: '2026-01-01T00:00:01.090Z', durationMs: 10246 }),
      makeCandidate({ id: 'sabre-token', timestamp: '2026-01-01T00:00:08.700Z', durationMs: 831 }),
      makeCandidate({ id: 'sabre-booking', timestamp: '2026-01-01T00:00:09.860Z', durationMs: 850 }),
    ];

    const payload = buildBulkExportPayload([odeysys, coreService], makeForm(), new Map(), '2026-01-01T18:00:00Z', candidates, 'all');
    const typesFor = (id: string) => payload.events.filter((e) => e.callId === id).map((e) => e.type);

    expect(typesFor('odeysys')).toEqual(['request', 'response']);
    expect(typesFor('core')).toEqual(['request', 'response']);
    // Still one real call per call, however many events they produce.
    expect(payload.summary.callCount).toBe(2);
  });

  it('excludes a candidate that fails the active status-pill filter from counting towards containment', () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const failedCandidate = makeCandidate({ status: 500, error: 'boom' });

    const merged = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', [failedCandidate], 'ok');
    expect(merged.events.length).toBe(1);
    expect(merged.events[0].type).toBe('call');

    const stillSplit = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z', [failedCandidate], 'all');
    expect(stillSplit.events.length).toBe(2);
  });

  it("summary.callCount still counts real calls, not events, even after an internal call is split", () => {
    const internalCall = makeCall({ id: 'call-a', source: 'internal', timestamp: '2026-08-07T10:00:00.000Z' });
    const externalCall = makeCall({ id: 'call-b', source: 'external', timestamp: '2026-08-07T10:00:01.000Z' });
    // 40% coverage / 10ms tail against the internal call's default 100ms duration.
    const nestedInInternalCall = makeCandidate({ timestamp: '2026-08-07T10:00:00.050Z', durationMs: 40 });
    const payload = buildBulkExportPayload([internalCall, externalCall], makeForm(), new Map(), '2026-08-07T18:00:00Z', [nestedInInternalCall], 'all');

    expect(payload.events.length).toBe(3); // request+response for internal, one call event for external
    expect(payload.summary.callCount).toBe(2);
  });

  it("attaches each call's own comments to its request/call event, not another call's", () => {
    const callA = makeCall({ id: 'call-a', timestamp: 't-a' });
    const callB = makeCall({ id: 'call-b', timestamp: 't-b' });
    const commentsByCallId = new Map<string, Comment[]>([[callA.id, [makeComment({ comment: 'on A' })]]]);

    const payload = buildBulkExportPayload([callA, callB], makeForm(), commentsByCallId, '2026-08-07T18:00:00Z');

    const eventA = payload.events[0] as BulkExportCallEvent;
    const eventB = payload.events[1] as BulkExportCallEvent;
    expect(eventA.comments.map((c) => c.comment)).toEqual(['on A']);
    expect(eventB.comments).toEqual([]);
  });

  it('interleaves events across calls in real chronological order, not call-then-call', () => {
    // Mirrors a real trace: core-service's request starts, then an external call starts and
    // finishes entirely *before* core-service's own response arrives - the external call's single
    // event must land between the internal call's request and response events, not after both.
    const internalCall = makeCall({
      id: 'internal-1',
      source: 'internal',
      service_name: 'core-service',
      timestamp: '2026-08-07T10:00:00.000Z',
      duration_ms: 2000,
    });
    const externalCall = makeCall({
      id: 'external-1',
      source: 'external',
      timestamp: '2026-08-07T10:00:00.500Z',
      duration_ms: 300,
    });
    // 85% coverage / 200ms tail against the internal call's 2000ms duration.
    const nestedInInternalCall = makeCandidate({ timestamp: '2026-08-07T10:00:00.100Z', durationMs: 1700 });
    const payload = buildBulkExportPayload([internalCall, externalCall], makeForm(), new Map(), '2026-08-07T18:00:00Z', [nestedInInternalCall], 'all');

    expect(payload.events.map((e) => `${e.type}:${e.callId}`)).toEqual([
      'request:internal-1',
      'call:external-1',
      'response:internal-1',
    ]);
  });

  it('never truncates a call\'s body', () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({ index: i }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    const event = payload.events[0] as BulkExportCallEvent;
    expect(JSON.parse(event.response!.body!).length).toBe(200);
  });
});
