import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { buildBulkExportMarkdown, buildExportMarkdown, bulkExportFilename, exportFilename } from './markdown-builder';

/**
 * A candidate genuinely contained in a call's [timestamp, timestamp + duration_ms] window, from a
 * different service, AND with a genuine blocking signature (see markdown-builder.ts's own
 * qualifiesAsEvidence: coverage >= MIN_COVERAGE_RATIO, tail <= MIN_TAIL_MS/TAIL_RATIO) - the minimal
 * fixture that makes buildBulkExportMarkdown keep an internal/resolved call split. Callers whose
 * target call has a different duration/timestamp than the default `makeCall()` must override
 * `timestamp`/`durationMs` themselves so checks 1 and 3 still hold against THEIR target.
 */
function makeCandidate(overrides: Partial<CallOverlapCandidate> = {}): CallOverlapCandidate {
  return {
    id: 'nested-candidate',
    source: 'internal',
    serviceName: 'a-different-service',
    // Same start as the default makeCall() below, covering 91% of its default 2965.59ms duration
    // with a 265.59ms tail - comfortably past both MIN_COVERAGE_RATIO and MIN_TAIL_MS/TAIL_RATIO.
    timestamp: '2026-08-07T13:45:51.965328+00:00',
    durationMs: 2700,
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
  it('includes every metadata field in a table', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    expect(md).toContain('| Supplier Name | FlyNas |');
    expect(md).toContain('| Supplier Credentials Used | EGY |');
    expect(md).toContain('| Environment | Staging |');
    expect(md).toContain('| URL | https://example.com/api/x |');
    expect(md).toContain('| API Key | secret-key |');
  });

  it('shows a placeholder for blank optional fields instead of an empty value', () => {
    const md = buildExportMarkdown(makeCall(), makeForm({ description: '' }));
    expect(md).toContain('| Description | _(none provided)_ |');
  });

  it('pretty-prints JSON bodies and headers in fenced code blocks', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    expect(md).toContain('```json\n{\n  "supplier": "FlyNas"\n}\n```');
    expect(md).toContain('```json\n{\n  "ok": true\n}\n```');
    expect(md).toContain('"Accept": "application/json"');
  });

  it('pretty-prints XML bodies in an "xml" fenced code block', () => {
    const call = makeCall({ request: { headers: {}, body: '<a><b>1</b></a>' } });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('```xml\n<a>\n  <b>1</b>\n</a>\n```');
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

  it('wraps every JSON code block in a collapsible <details> so large payloads can be collapsed', () => {
    const md = buildExportMarkdown(makeCall(), makeForm());
    const detailsCount = md.match(/<details>/g)?.length ?? 0;
    const closeCount = md.match(/<\/details>/g)?.length ?? 0;
    expect(detailsCount).toBe(4); // request headers, request body, response headers, response body
    expect(closeCount).toBe(detailsCount);
    expect(md).toContain('<details>\n<summary>Body</summary>\n\n```json\n{\n  "supplier": "FlyNas"\n}\n```\n\n</details>');
  });

  it('labels each collapsible block "Headers" or "Body" regardless of whether the content is valid JSON', () => {
    const call = makeCall({ request: { headers: {}, body: 'not json at all' } });
    const md = buildExportMarkdown(call, makeForm());
    expect(md).toContain('<summary>Headers</summary>');
    expect(md).toContain('<summary>Body</summary>\n\n```\nnot json at all\n```');
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

  it('includes duration only when present, with thousands separators for large values', () => {
    expect(buildExportMarkdown(makeCall({ duration_ms: 42 }), makeForm())).toContain('**Duration:** 42 ms');
    expect(buildExportMarkdown(makeCall({ duration_ms: 4182.38 }), makeForm())).toContain('**Duration:** 4,182.38 ms');
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

    expect(md).toContain('Flagged Issues');
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

describe('buildBulkExportMarkdown', () => {
  const EXPORTED_AT = '2026-08-07T18:00:00.000Z';

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

  it('includes every call in a numbered summary table with anchors', () => {
    const calls = [
      makeCall({ method: 'POST', response: { status: 200, headers: {}, body: '{}' } }),
      makeCall({ method: 'GET', timestamp: 't2', response: undefined, error: 'boom' }),
    ];
    const md = buildBulkExportMarkdown(calls, makeForm(), new Map(), EXPORTED_AT);

    expect(md).toContain('# 📋 API Calls Export — 2 Calls');
    expect(md).toContain('| [1](#call-1) | `POST` |');
    expect(md).toContain('| [2](#call-2) | `GET` |');
    expect(md).toContain('<a id="call-1"></a>');
    expect(md).toContain('<a id="call-2"></a>');
  });

  it('shows the exported timestamp and overall succeeded/failed/duration in the header line', () => {
    const ok = makeCall({ duration_ms: 100, response: { status: 200, headers: {}, body: '' } });
    const failed = makeCall({ timestamp: 't2', duration_ms: 50, response: undefined, error: 'x' });
    const md = buildBulkExportMarkdown([ok, failed], makeForm(), new Map(), EXPORTED_AT);

    expect(md).toContain(`**Exported:** ${EXPORTED_AT}`);
    expect(md).toContain('**Succeeded:** 1 ✅');
    expect(md).toContain('**Failed:** 1 ❌');
    expect(md).toContain('**Total duration:** 150 ms');
  });

  it('writes the metadata table once, not once per call', () => {
    const calls = [makeCall(), makeCall({ timestamp: 't2' }), makeCall({ timestamp: 't3' })];
    const md = buildBulkExportMarkdown(calls, makeForm({ supplierName: 'FlyNas' }), new Map(), EXPORTED_AT);

    expect(md.match(/Metadata/g)?.length).toBe(1);
    expect(md.match(/\| Supplier Name \| FlyNas \|/g)?.length).toBe(1);
  });

  it('includes each call\'s own flagged issues under its own section, not mixed with another call\'s', () => {
    const callA = makeCall({ id: 'call-a', timestamp: 't-a' });
    const callB = makeCall({ id: 'call-b', timestamp: 't-b' });
    const commentsByCallId = new Map<string, Comment[]>([
      [callA.id, [makeComment({ comment: 'issue on call A' })]],
      [callB.id, [makeComment({ comment: 'issue on call B' })]],
    ]);

    const md = buildBulkExportMarkdown([callA, callB], makeForm(), commentsByCallId, EXPORTED_AT);

    const call1Section = md.slice(md.indexOf('<b>Call 1</b>'), md.indexOf('<b>Call 2</b>'));
    const call2Section = md.slice(md.indexOf('<b>Call 2</b>'));

    expect(call1Section).toContain('issue on call A');
    expect(call1Section).not.toContain('issue on call B');
    expect(call2Section).toContain('issue on call B');
    expect(call2Section).not.toContain('issue on call A');
  });

  it('never truncates any call\'s body, however many calls or however large', () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => ({ index: i }));
    const call = makeCall({ response: { status: 200, headers: {}, body: JSON.stringify(bigArray) } });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    const responseSection = md.slice(md.indexOf('📥 Response'));
    expect(responseSection).toContain('"index": 199');
    expect(responseSection).not.toContain('...');
  });

  it('wraps each call in an open-by-default <details>, with its Headers/Body blocks collapsed inside', () => {
    const calls = [makeCall(), makeCall({ timestamp: 't2' })];
    const md = buildBulkExportMarkdown(calls, makeForm(), new Map(), EXPORTED_AT);

    const anyDetailsCount = md.match(/<details(?: open)?>/g)?.length ?? 0;
    const closeCount = md.match(/<\/details>/g)?.length ?? 0;
    const openDetailsCount = md.match(/<details open>/g)?.length ?? 0;
    expect(openDetailsCount).toBe(2); // one open <details> wrapper per call
    expect(anyDetailsCount).toBe(10); // (4 Headers/Body blocks + 1 call wrapper) x 2 calls
    expect(closeCount).toBe(anyDetailsCount);
  });

  it('shows the call\'s method and its URI - everything after the host, not the full URL - next to its heading', () => {
    const call = makeCall({ method: 'POST', url: 'https://ndc-supplier.example.com/api/V2/FlightSearch/Search' });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    expect(md).toContain('<summary><b>Call 1</b> &nbsp; <code>POST api/V2/FlightSearch/Search</code> &nbsp; ✅ 200</summary>');
    expect(md).not.toContain('<summary><b>Call 1</b> &nbsp; <code>POST https://');
  });

  it('repeats the full URL, method, status, and duration in the call\'s description, not just the heading', () => {
    const call = makeCall({ method: 'POST', url: 'https://example.com/api/V2/FlightSearch/Search', duration_ms: 3381.7 });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    expect(md).toContain('- **Method:** `POST`');
    expect(md).toContain('- **URL:** https://example.com/api/V2/FlightSearch/Search');
    expect(md).toContain('- **Status:** `200`');
    expect(md).toContain('- **Duration:** 3,381.70 ms');
  });

  it('shows the error as the description Status when there is no response', () => {
    const call = makeCall({ response: undefined, error: 'boom' });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    expect(md).toContain('- **Status:** ⚠️ boom');
  });

  it('an external call stays a single unsplit block, exactly as before', () => {
    const call = makeCall({ source: 'external' });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    expect(md).toContain('<b>Call 1</b> &nbsp;');
    expect(md).not.toContain('· request');
    expect(md).not.toContain('· response');
    expect((md.match(/<details open>/g) ?? []).length).toBe(1);
  });

  it('splits a resolved internal call for a fan-out of children that each individually fail the single-child blocking signature', () => {
    // Mirrors call-utils.spec.ts's fan-out case: several suppliers called in parallel, then a long
    // post-processing tail, so no candidate clears MIN_COVERAGE_RATIO or the tail window alone.
    // Keep in step with call-utils.ts's hasBlockingEvidence, re-implemented in this file.
    const call = makeCall({
      source: 'internal',
      service_name: 'odeysys',
      timestamp: '2026-08-07T13:45:51.965328+00:00',
      duration_ms: 27000,
    });
    const suppliers = [1780, 1141, 1683].map((durationMs, i) =>
      makeCandidate({ id: `supplier-${i}`, timestamp: '2026-08-07T13:45:55.965328+00:00', durationMs })
    );

    const mergedAlone = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT, [suppliers[0]], 'all');
    expect(mergedAlone).not.toContain('· request');

    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT, suppliers, 'all');
    expect(md).toContain('<summary><b>Call 1</b> · request');
    expect(md).toContain('<summary><b>Call 1</b> · response');
  });

  it('splits a resolved internal call into a request block and a response block, correlated by the same call number', () => {
    const call = makeCall({
      source: 'internal',
      service_name: 'core-service',
      timestamp: '2026-08-07T13:45:51.965328+00:00',
      duration_ms: 1000,
    });
    // 80% coverage / 200ms tail against this call's own 1000ms duration - the shared default
    // makeCandidate() is sized for makeCall()'s own default 2965.59ms duration instead.
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT, [makeCandidate({ durationMs: 800 })], 'all');

    expect(md).toContain('<a id="call-1"></a>');
    expect(md).toContain('<a id="call-1-response"></a>');
    expect(md).toContain('<summary><b>Call 1</b> · request');
    expect(md).toContain('<summary><b>Call 1</b> · response');
    expect((md.match(/<details open>/g) ?? []).length).toBe(2);

    // Request block has no Status line and no Response section. Its heading/summary settle to a
    // plain "sent" marker, never "pending" - the call has already resolved by the time a request
    // block exists at all (see isSplitInternalCall), so "pending" would misrepresent it.
    const requestBlock = md.slice(md.indexOf('<b>Call 1</b> · request'), md.indexOf('<b>Call 1</b> · response'));
    expect(requestBlock).toContain('#### 📤 Request');
    expect(requestBlock).not.toContain('#### 📥 Response');
    expect(requestBlock).not.toContain('- **Status:**');
    expect(requestBlock).not.toContain('pending');
    expect(requestBlock).toContain('sent');

    // Response block has no Request section, and shows Status/Duration/Received.
    const responseBlock = md.slice(md.indexOf('<b>Call 1</b> · response'));
    expect(responseBlock).toContain('#### 📥 Response');
    expect(responseBlock).not.toContain('#### 📤 Request');
    expect(responseBlock).toContain('- **Status:** `200`');
    expect(responseBlock).toContain('- **Duration:** 1,000 ms');
  });

  it('does not split an internal call that is still in-progress - it stays one block with no fabricated response', () => {
    const call = makeCall({ source: 'internal', response: undefined, error: undefined, state: 'IN_PROGRESS' });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    expect(md).not.toContain('· request');
    expect(md).not.toContain('· response');
    expect((md.match(/<details open>/g) ?? []).length).toBe(1);
  });

  it('merges a resolved internal call into a single block when no overlap candidate is genuinely contained in its window - the default when none is passed', () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT);

    expect(md).not.toContain('· request');
    expect(md).not.toContain('· response');
    expect((md.match(/<details open>/g) ?? []).length).toBe(1);
  });

  it('merges a resolved internal call when every contained candidate shares its own service name', () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const sameServiceCandidate = makeCandidate({ serviceName: 'core-service' });
    const md = buildBulkExportMarkdown([call], makeForm(), new Map(), EXPORTED_AT, [sameServiceCandidate], 'all');

    expect(md).not.toContain('· request');
    expect(md).not.toContain('· response');
  });

  it('forces chronological order regardless of input order, and interleaves a split internal call around calls that fall in between', () => {
    const odeysys = makeCall({
      id: 'odeysys',
      source: 'internal',
      service_name: 'odeysys',
      timestamp: '2026-08-07T10:00:00.000Z',
      duration_ms: 5000, // resolves at 10:00:05
    });
    const external = makeCall({
      id: 'external-call',
      source: 'external',
      timestamp: '2026-08-07T10:00:02.000Z', // starts and finishes before odeysys resolves
      duration_ms: 100,
    });

    const nestedInOdeysys = makeCandidate({
      id: 'nested-in-odeysys',
      serviceName: 'core-service',
      timestamp: '2026-08-07T10:00:01.000Z',
      // 76% coverage / 200ms tail against odeysys's 5000ms duration - well past both thresholds.
      durationMs: 3800,
    });
    // Passed in reverse order on purpose - the builder must sort chronologically itself.
    const md = buildBulkExportMarkdown([external, odeysys], makeForm(), new Map(), EXPORTED_AT, [nestedInOdeysys], 'all');

    const odeysysReqIdx = md.indexOf('<a id="call-1"></a>');
    const externalIdx = md.indexOf('<a id="call-2"></a>');
    const odeysysResIdx = md.indexOf('<a id="call-1-response"></a>');

    expect(odeysysReqIdx).toBeGreaterThan(-1);
    expect(externalIdx).toBeGreaterThan(-1);
    expect(odeysysResIdx).toBeGreaterThan(-1);
    expect(odeysysReqIdx).toBeLessThan(externalIdx);
    expect(externalIdx).toBeLessThan(odeysysResIdx);
  });

  it("a request block only shows its own request-side flagged issues, and a response block only its own response-side ones - both scoped to the call's comments", () => {
    const call = makeCall({ source: 'internal', service_name: 'core-service' });
    const comments: Comment[] = [
      makeComment({ id: 'c1', block: 'request-body', comment: 'request-side issue' }),
      makeComment({ id: 'c2', block: 'response-body', comment: 'response-side issue' }),
    ];
    const commentsByCallId = new Map<string, Comment[]>([[call.id, comments]]);
    const md = buildBulkExportMarkdown([call], makeForm(), commentsByCallId, EXPORTED_AT, [makeCandidate()], 'all');

    const requestBlock = md.slice(md.indexOf('<summary><b>Call 1</b> · request'), md.indexOf('<summary><b>Call 1</b> · response'));
    const responseBlock = md.slice(md.indexOf('<summary><b>Call 1</b> · response'));

    expect(requestBlock).toContain('request-side issue');
    expect(requestBlock).not.toContain('response-side issue');
    expect(responseBlock).toContain('response-side issue');
    expect(responseBlock).not.toContain('request-side issue');
  });
});

describe('bulkExportFilename', () => {
  it('names the file after the call count and extension', () => {
    expect(bulkExportFilename([makeCall(), makeCall()], 'md')).toBe('alfred-export-2-calls.md');
    expect(bulkExportFilename([makeCall()], 'json')).toBe('alfred-export-1-calls.json');
  });
});
