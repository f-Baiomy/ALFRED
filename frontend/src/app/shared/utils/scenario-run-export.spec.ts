import { DraftResult } from './scenario-types';
import { buildHtmlReport, buildMarkdownReport, rowsFor } from './scenario-run-export';
import { setSecretValues } from './redact';

describe('scenario-run-export', () => {
  const bigBody = 'x'.repeat(50_000);
  const results: DraftResult[] = [
    { key: 'd1', attempt: 1, status: 200, durationMs: 5, newCallId: 'c1', error: null, response: { status: 200, headers: {}, body: '{"ok":true}' }, extracted: {} },
    { key: 'd2', attempt: 1, status: 500, durationMs: 9, newCallId: 'c2', error: null, response: { status: 500, headers: {}, body: bigBody }, extracted: {} },
  ];
  const assertionResults = {
    d1: [{ assertion: { kind: 'STATUS' as const, operator: 'EQUALS' as const, value: '200' }, passed: true, actual: '200', message: 'Equals 200.' }],
    d2: [{ assertion: { kind: 'STATUS' as const, operator: 'EQUALS' as const, value: '200' }, passed: false, actual: '500', message: 'Was 500, expected 200.' }],
  };

  it('rowsFor marks a row failed when any assertion fails', () => {
    const rows = rowsFor([], results, assertionResults);
    expect(rows.find((r) => r.key === 'd1')!.passed).toBeTrue();
    expect(rows.find((r) => r.key === 'd2')!.passed).toBeFalse();
  });

  it('markdown report never truncates a failed draft\'s full response body', () => {
    const rows = rowsFor([], results, assertionResults);
    const md = buildMarkdownReport(rows, 'Book flow');
    expect(md).toContain(bigBody);
  });

  it('html report never truncates a failed draft\'s full response body', () => {
    const rows = rowsFor([], results, assertionResults);
    const html = buildHtmlReport(rows, 'Book flow');
    expect(html).toContain(bigBody);
  });

  it('a passing draft does not print its response body', () => {
    const rows = rowsFor([], results, assertionResults);
    const md = buildMarkdownReport(rows, 'Book flow');
    expect(md).not.toContain('{"ok":true}');
  });

  describe('readable layout (specs/export-redesign-mock.html)', () => {
    const drafts = [
      { key: 'd1', method: 'POST', url: 'https://api.example/login' },
      { key: 'd2', method: 'POST', url: 'https://api.example/search?currency=EGP' },
    ] as unknown as Parameters<typeof rowsFor>[0];
    const rows = rowsFor(drafts, results, assertionResults);

    it('opens with an answer, the counts and what this document is', () => {
      const md = buildMarkdownReport(rows, 'Book flow');
      expect(md).toContain('> **1 / 2 drafts passed:** 2 · POST /search - 1 of 1 check failed (Was 500, expected 200.).');
      expect(md).toContain('| 2 | 1 | 1 | 1 of 2 |');
      expect(md).toContain('**What this is.** The result of one run of the resend scenario "Book flow"');
      expect(md).toContain('## Glossary');
      const html = buildHtmlReport(rows, 'Book flow');
      expect(html).toContain('<span class="lead">1 / 2 drafts passed:</span>');
      expect(html).toContain('About this document');
    });

    it('every draft is a closed card with its method + path, full URL and every check', () => {
      const html = buildHtmlReport(rows, 'Book flow');
      expect(html).not.toContain('<details open');
      expect(html).toContain('<details class="step-fold" id="draft-2" data-outcome="failed">');
      expect(html).toContain('<div class="url-line">POST https://api.example/search?currency=EGP</div>');
      expect(html).toContain('STATUS EQUALS &quot;200&quot;');
      expect(html).toContain('Was 500, expected 200.');
      const md = buildMarkdownReport(rows, 'Book flow');
      expect(md).toContain('| 2 | POST /search<br>POST https://api.example/search?currency=EGP | ❌ failed |');
      expect(md).not.toContain('<details open');
    });

    it('masks a secret value in a failed draft\'s body, headers and error', () => {
      setSecretValues(['S3CRET-TOKEN-VALUE']);
      try {
        const secret: DraftResult[] = [{ key: 'd9', attempt: 1, status: 401, durationMs: 3, newCallId: null, error: 'S3CRET-TOKEN-VALUE rejected', response: { status: 401, headers: { 'x-token': 'S3CRET-TOKEN-VALUE' }, body: '{"t":"S3CRET-TOKEN-VALUE"}' }, extracted: {} }];
        const reportRows = rowsFor([], secret, {});
        expect(buildMarkdownReport(reportRows, 'X')).not.toContain('S3CRET-TOKEN-VALUE');
        expect(buildHtmlReport(reportRows, 'X')).not.toContain('S3CRET-TOKEN-VALUE');
      } finally {
        setSecretValues([]);
      }
    });
  });

  it('html-escapes error text and labels', () => {
    const withError: DraftResult[] = [{ key: 'd3', attempt: 1, status: null, durationMs: null, newCallId: null, error: '<script>bad</script>', response: null, extracted: {} }];
    const rows = rowsFor([], withError, {});
    const html = buildHtmlReport(rows, 'X');
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
