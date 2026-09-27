import { DraftResult } from './scenario-types';
import { buildHtmlReport, buildMarkdownReport, rowsFor } from './scenario-run-export';

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

  it('html-escapes error text and labels', () => {
    const withError: DraftResult[] = [{ key: 'd3', attempt: 1, status: null, durationMs: null, newCallId: null, error: '<script>bad</script>', response: null, extracted: {} }];
    const rows = rowsFor([], withError, {});
    const html = buildHtmlReport(rows, 'X');
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
