import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { buildExportMarkdown, exportFilename } from './markdown-builder';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'POST',
    request: { headers: { Accept: 'application/json' }, body: '{"supplier":"FlyNas"}' },
    timestamp: '2026-08-07T13:45:51.965328+00:00',
    duration_ms: 2965.59,
    response: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' },
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

describe('buildExportMarkdown', () => {
  it('includes every metadata field', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    expect(md).toContain('**Supplier Name:** FlyNas');
    expect(md).toContain('**Supplier Credentials Used:** EGY');
    expect(md).toContain('**Environment:** Staging');
    expect(md).toContain('**URL:** https://example.com/api/x');
    expect(md).toContain('**API Key:** secret-key');
  });

  it('shows a placeholder for blank optional fields instead of an empty value', () => {
    const md = buildExportMarkdown(makeCall(), makeForm({ description: '' }));
    expect(md).toContain('**Description:** _(none provided)_');
  });

  it('pretty-prints JSON bodies and headers in fenced code blocks', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    expect(md).toContain('```json\n{\n  "supplier": "FlyNas"\n}\n```');
    expect(md).toContain('```json\n{\n  "ok": true\n}\n```');
    expect(md).toContain('"Accept": "application/json"');
  });

  it('never truncates the body, however large', () => {
    const bigArray = Array.from({ length: 500 }, (_, i) => ({ index: i, value: `item-${i}` }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('"index": 499');
    expect(md).toContain('"value": "item-499"');
    expect(md).not.toContain('...');
  });

  it('embeds non-JSON bodies verbatim instead of dropping them', () => {
    const call = makeCall({ request: { headers: {}, body: 'not json at all' } });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('```\nnot json at all\n```');
  });

  it('shows the error and omits the Response Status/Headers/Body when there is no response', () => {
    const call = makeCall({ response: undefined, error: 'Client disconnected.' });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('⚠️ **Error:** Client disconnected. No response was received for this call.');
    expect(md).not.toContain('**Status:**');
  });

  it('shows both the error and the response when a response did arrive alongside one', () => {
    const call = makeCall({ error: 'timeout warning' });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('⚠️ **Error:** timeout warning');
    expect(md).toContain('**Status:** `200`');
  });

  it('includes duration only when present', () => {
    expect(buildExportMarkdown(makeCall({ duration_ms: 42 }), makeForm())).toContain('**Duration:** 42 ms');
    expect(buildExportMarkdown(makeCall({ duration_ms: undefined }), makeForm())).not.toContain('**Duration:**');
  });

  it('omits the Flagged Issues section entirely when there are no comments', () => {
    const md = buildExportMarkdown(makeCall(), makeForm(), []);
    expect(md).not.toContain('Flagged Issues');
  });

  function makeComment(overrides: Partial<Comment> = {}): Comment {
    return {
      id: 'c1',
      callId: 'call-1',
      block: 'request-body',
      lineIndex: 0,
      lineText: '{',
      comment: 'This looks wrong',
      createdAt: '2026-08-07T00:00:00.000Z',
      ...overrides,
    };
  }

  it('lists flagged lines in a dedicated summary section, grouped by block', () => {
    const comments: Comment[] = [
      makeComment({ id: 'c1', block: 'request-body', lineIndex: 1, lineText: '"supplier": "FlyNas",', comment: 'Should be EGY' }),
      makeComment({ id: 'c2', block: 'response-headers', lineIndex: 0, lineText: '{', comment: 'Missing CORS header' }),
    ];
    const md = buildExportMarkdown(makeCall(), makeForm(), comments);

    expect(md).toContain('## Flagged Issues');
    expect(md).toContain('### Request Body');
    expect(md).toContain('- **Line 2:** `"supplier": "FlyNas",`');
    expect(md).toContain('> Should be EGY');
    expect(md).toContain('### Response Headers');
    expect(md).toContain('> Missing CORS header');
  });

  it('also annotates the flagged line inline within its code block', () => {
    const call = makeCall({ request: { headers: {}, body: '{"supplier":"FlyNas"}' } });
    const comments: Comment[] = [makeComment({ block: 'request-body', lineIndex: 1, comment: 'Should be EGY' })];
    const md = buildExportMarkdown(call, makeForm(), comments);

    // Line 1 (0-indexed) of `{\n  "supplier": "FlyNas"\n}` is the supplier line.
    expect(md).toContain('"supplier": "FlyNas"  // ⚠ FLAGGED: Should be EGY');
  });

  it('joins multiple comments on the same line with a separator instead of dropping any', () => {
    const call = makeCall({ request: { headers: {}, body: '{"a":1}' } });
    const comments: Comment[] = [
      makeComment({ id: 'c1', block: 'request-body', lineIndex: 1, comment: 'First issue' }),
      makeComment({ id: 'c2', block: 'request-body', lineIndex: 1, comment: 'Second issue' }),
    ];
    const md = buildExportMarkdown(call, makeForm(), comments);

    expect(md).toContain('FLAGGED: First issue | FLAGGED: Second issue');
  });
});

describe('exportFilename', () => {
  it('derives a filesystem-safe name from the supplier hostname and call identity', () => {
    const name = exportFilename(makeCall());
    expect(name).toMatch(/^example\.com-c_.*\.md$/);
  });
});
