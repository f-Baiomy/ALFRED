import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import {
  buildBulkExportPayload,
  BulkExportRequestEvent,
  BulkExportResponseEvent,
  BulkExportCallEvent,
} from './bulk-json-builder';

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
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

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
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

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

  it("summary.callCount still counts real calls, not events, even after an internal call is split", () => {
    const internalCall = makeCall({ id: 'call-a', source: 'internal', timestamp: '2026-08-07T10:00:00.000Z' });
    const externalCall = makeCall({ id: 'call-b', source: 'external', timestamp: '2026-08-07T10:00:01.000Z' });
    const payload = buildBulkExportPayload([internalCall, externalCall], makeForm(), new Map(), '2026-08-07T18:00:00Z');

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
    const payload = buildBulkExportPayload([internalCall, externalCall], makeForm(), new Map(), '2026-08-07T18:00:00Z');

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
