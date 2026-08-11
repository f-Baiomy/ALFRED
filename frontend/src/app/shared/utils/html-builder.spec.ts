import { CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { buildBulkExportHtml, buildExportHtml, bulkExportHtmlFilename, exportHtmlFilename } from './html-builder';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
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

describe('buildExportHtml', () => {
  it('produces a self-contained document with a doctype, styles, and closing tags', () => {
    const html = buildExportHtml(makeCall(), makeForm());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<style>');
    expect(html).toContain('</html>');
  });

  it('includes every metadata field', () => {
    const html = buildExportHtml(makeCall(), makeForm());
    expect(html).toContain('<td>FlyNas</td>');
    expect(html).toContain('<td>EGY</td>');
    expect(html).toContain('Staging');
    expect(html).toContain('https://example.com/api/x');
    expect(html).toContain('secret-key');
  });

  it('shows a placeholder for blank optional fields instead of an empty value', () => {
    const html = buildExportHtml(makeCall(), makeForm({ description: '' }));
    expect(html).toContain('<em>(none provided)</em>');
  });

  it('escapes metadata values so a stray HTML character cannot break the layout', () => {
    const html = buildExportHtml(makeCall(), makeForm({ description: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never truncates the body, however large - it rides along in the JSON_BLOCKS config for the client-side renderer', () => {
    const bigArray = Array.from({ length: 500 }, (_, i) => ({ index: i, value: `item-${i}` }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const html = buildExportHtml(call, makeForm());
    // The body text lives inside the JSON_BLOCKS config in the trailing <script>, JSON-encoded for
    // embedding - so quotes appear escaped (\") in the raw document text, not bare (").
    expect(html).toContain('\\"index\\": 499');
    expect(html).toContain('\\"value\\": \\"item-499\\"');
    // Scoped to the JSON_BLOCKS payload rather than the whole document, since the shared script's
    // own "Find in block..." search placeholder legitimately contains "..." unrelated to truncation.
    const blocksJson = html.slice(html.indexOf('var JSON_BLOCKS'), html.indexOf('function makeTokenRegex'));
    expect(blocksJson).not.toContain('...');
  });

  it('embeds non-JSON bodies verbatim instead of dropping them', () => {
    const call = makeCall({ request: { headers: {}, body: 'not json at all' } });
    const html = buildExportHtml(call, makeForm());
    expect(html).toContain('not json at all');
  });

  it('renders every collapsible section closed, so opening the file shows a scannable page instead of everything expanded', () => {
    const html = buildExportHtml(makeCall(), makeForm());
    expect(html).not.toContain('<details open');
    expect(html).not.toContain('<details class="json-block" open');
  });

  it('creates one json-block per Headers/Body section', () => {
    const html = buildExportHtml(makeCall(), makeForm());
    const blockCount = html.match(/data-block-id="call-[a-z-]+"/g)?.length ?? 0;
    expect(blockCount).toBe(4); // request headers, request body, response headers, response body
  });

  it('shows the error and omits the Response Status/Headers/Body when there is no response', () => {
    const call = makeCall({ response: undefined, error: 'Client disconnected.' });
    const html = buildExportHtml(call, makeForm());
    expect(html).toContain('Client disconnected.');
    expect(html).not.toContain('<b>Status:</b>');
  });

  it('includes duration only when present, with thousands separators for large values', () => {
    expect(buildExportHtml(makeCall({ duration_ms: 42 }), makeForm())).toContain('<b>Duration:</b> 42 ms');
    expect(buildExportHtml(makeCall({ duration_ms: 4182.38 }), makeForm())).toContain('<b>Duration:</b> 4,182.38 ms');
    expect(buildExportHtml(makeCall({ duration_ms: undefined }), makeForm())).not.toContain('<b>Duration:</b>');
  });

  it('omits the Flagged Issues section entirely when there are no comments', () => {
    const html = buildExportHtml(makeCall(), makeForm(), []);
    expect(html).not.toContain('Flagged Issues');
  });

  it('lists flagged lines in a dedicated summary section, grouped by block', () => {
    const comments: Comment[] = [
      makeComment({ id: 'c1', block: 'request-body', lineIndex: 1, lineText: '"supplier": "FlyNas",', comment: 'Should be EGY' }),
      makeComment({ id: 'c2', block: 'response-headers', lineIndex: 0, lineText: '{', comment: 'Missing CORS header' }),
    ];
    const html = buildExportHtml(makeCall(), makeForm(), comments);

    expect(html).toContain('Flagged Issues');
    expect(html).toContain('Request Body');
    expect(html).toContain('Line 2');
    expect(html).toContain('Should be EGY');
    expect(html).toContain('Response Headers');
    expect(html).toContain('Missing CORS header');
  });

  it('carries the flagged comment through to the JSON_BLOCKS config keyed by 0-based line index, for the client-side comment card', () => {
    const call = makeCall({ request: { headers: {}, body: '{"supplier":"FlyNas"}' } });
    const comments: Comment[] = [makeComment({ block: 'request-body', lineIndex: 1, comment: 'Should be EGY' })];
    const html = buildExportHtml(call, makeForm(), comments);

    // Line 1 (0-indexed) of `{\n  "supplier": "FlyNas"\n}` is the supplier line.
    expect(html).toContain('"1":"Should be EGY"');
  });

  it('joins multiple comments on the same line with a separator instead of dropping any', () => {
    const call = makeCall({ request: { headers: {}, body: '{"a":1}' } });
    const comments: Comment[] = [
      makeComment({ id: 'c1', block: 'request-body', lineIndex: 1, comment: 'First issue' }),
      makeComment({ id: 'c2', block: 'request-body', lineIndex: 1, comment: 'Second issue' }),
    ];
    const html = buildExportHtml(call, makeForm(), comments);

    expect(html).toContain('First issue | Second issue');
  });

  it('escapes "</script>" sequences inside embedded call data so they cannot prematurely close the script tag', () => {
    const call = makeCall({ response: { status: 200, headers: {}, body: '{"payload":"</script><script>alert(1)</script>"}' } });
    const html = buildExportHtml(call, makeForm());
    expect(html).not.toContain('</script><script>alert(1)</script>');
  });
});

describe('exportHtmlFilename', () => {
  it('derives a filesystem-safe name from the supplier hostname and call identity', () => {
    const name = exportHtmlFilename(makeCall());
    expect(name).toMatch(/^example\.com-c_.*\.html$/);
  });
});

describe('buildBulkExportHtml', () => {
  const EXPORTED_AT = '2026-08-07T18:00:00.000Z';

  it('includes every call in a numbered summary table with anchors', () => {
    const calls = [
      makeCall({ method: 'POST', response: { status: 200, headers: {}, body: '{}' } }),
      makeCall({ method: 'GET', timestamp: 't2', response: undefined, error: 'boom' }),
    ];
    const html = buildBulkExportHtml(calls, makeForm(), new Map(), EXPORTED_AT);

    expect(html).toContain('API Calls Export — 2 Calls');
    expect(html).toContain('href="#call-1"');
    expect(html).toContain('href="#call-2"');
    expect(html).toContain('id="call-1"');
    expect(html).toContain('id="call-2"');
  });

  it('shows the exported timestamp and overall succeeded/failed/duration', () => {
    const ok = makeCall({ duration_ms: 100, response: { status: 200, headers: {}, body: '' } });
    const failed = makeCall({ timestamp: 't2', duration_ms: 50, response: undefined, error: 'x' });
    const html = buildBulkExportHtml([ok, failed], makeForm(), new Map(), EXPORTED_AT);

    expect(html).toContain(EXPORTED_AT);
    expect(html).toContain('Succeeded: 1');
    expect(html).toContain('Failed: 1');
    expect(html).toContain('150 ms');
  });

  it('writes the metadata table once, not once per call', () => {
    const calls = [makeCall(), makeCall({ timestamp: 't2' }), makeCall({ timestamp: 't3' })];
    const html = buildBulkExportHtml(calls, makeForm({ supplierName: 'FlyNas' }), new Map(), EXPORTED_AT);

    expect(html.match(/Metadata/g)?.length).toBe(1);
  });

  it("includes each call's own flagged issues under its own section, not mixed with another call's", () => {
    const callA = makeCall({ id: 'call-a', timestamp: 't-a' });
    const callB = makeCall({ id: 'call-b', timestamp: 't-b' });
    const commentsByCallId = new Map<string, Comment[]>([
      [callA.id, [makeComment({ comment: 'issue on call A' })]],
      [callB.id, [makeComment({ comment: 'issue on call B' })]],
    ]);

    const html = buildBulkExportHtml([callA, callB], makeForm(), commentsByCallId, EXPORTED_AT);

    // Bound each section by the <script> tag, not the end of the document - the trailing shared
    // script legitimately combines every call's JSON_BLOCKS config (including its comments) into
    // one array for the client-side renderer, so it always contains both calls' comment text.
    const scriptStart = html.indexOf('<script>');
    const call1Section = html.slice(html.indexOf('id="call-1"'), html.indexOf('id="call-2"'));
    const call2Section = html.slice(html.indexOf('id="call-2"'), scriptStart);

    expect(call1Section).toContain('issue on call A');
    expect(call1Section).not.toContain('issue on call B');
    expect(call2Section).toContain('issue on call B');
    expect(call2Section).not.toContain('issue on call A');
  });

  it('never truncates any call\'s body, however many calls or however large', () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({ index: i }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const html = buildBulkExportHtml([call], makeForm(), new Map(), EXPORTED_AT);

    // The body text lives inside the JSON_BLOCKS config in the trailing <script>, JSON-encoded for
    // embedding - so quotes appear escaped (\") in the raw document text, not bare (").
    const scriptSection = html.slice(html.indexOf('<script>'));
    expect(scriptSection).toContain('\\"index\\": 199');
  });

  it('shows the call\'s method and status next to its heading', () => {
    const call = makeCall({ method: 'POST', response: { status: 200, headers: {}, body: '{}' } });
    const html = buildBulkExportHtml([call], makeForm(), new Map(), EXPORTED_AT);

    expect(html).toContain('<b>Call 1</b>');
    expect(html).toContain('POST');
    expect(html).toContain('200');
  });

  it("shows the call's URI - everything after the host - next to its heading, not the full URL", () => {
    const call = makeCall({ method: 'POST', url: 'https://ndc-supplier.example.com/api/V2/FlightSearch/Search' });
    const html = buildBulkExportHtml([call], makeForm(), new Map(), EXPORTED_AT);

    expect(html).toContain('<code>POST api/V2/FlightSearch/Search</code>');
    expect(html).not.toContain('<code>POST https://');
  });

  it('renders every call section and every Headers/Body block closed, not just the first call', () => {
    const calls = [makeCall(), makeCall({ id: 'call-2', timestamp: 't2' })];
    const html = buildBulkExportHtml(calls, makeForm(), new Map(), EXPORTED_AT);

    expect(html).not.toContain('<details open');
    expect(html).not.toContain('<details class="json-block" open');
  });

  it('shows the error status when there is no response', () => {
    const call = makeCall({ response: undefined, error: 'boom' });
    const html = buildBulkExportHtml([call], makeForm(), new Map(), EXPORTED_AT);

    expect(html).toContain('⚠️');
    expect(html).toContain('boom');
  });
});

describe('bulkExportHtmlFilename', () => {
  it('names the file after the call count', () => {
    expect(bulkExportHtmlFilename([makeCall(), makeCall()])).toBe('alfred-export-2-calls.html');
    expect(bulkExportHtmlFilename([makeCall()])).toBe('alfred-export-1-calls.html');
  });
});
