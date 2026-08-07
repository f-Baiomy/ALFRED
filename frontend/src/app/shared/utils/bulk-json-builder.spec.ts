import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { callKey } from './call-utils';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
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

  it('attaches each call\'s own comments, not another call\'s', () => {
    const callA = makeCall({ timestamp: 't-a' });
    const callB = makeCall({ timestamp: 't-b' });
    const commentsByCallId = new Map<string, Comment[]>([[callKey(callA), [makeComment({ comment: 'on A' })]]]);

    const payload = buildBulkExportPayload([callA, callB], makeForm(), commentsByCallId, '2026-08-07T18:00:00Z');

    expect(payload.calls[0].comments.map((c) => c.comment)).toEqual(['on A']);
    expect(payload.calls[1].comments).toEqual([]);
  });

  it('never truncates a call\'s body', () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({ index: i }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const payload = buildBulkExportPayload([call], makeForm(), new Map(), '2026-08-07T18:00:00Z');

    expect(JSON.parse(payload.calls[0].response!.body).length).toBe(200);
  });
});
