import {
  buildHtmlCompareReport,
  buildHtmlRunReport,
  buildJsonCompareReport,
  buildJsonRunReport,
  buildMarkdownCompareReport,
  buildMarkdownRunReport,
  prettyBody,
} from './relive-run-export';
import { buildCompareReport, buildRunReport } from './relive-run-report';
import { compareRuns, latestByStepKey, runSide } from './relive-run-compare';
import { cmpResult, cmpRun, cmpStep } from './relive-run-compare.testing';

const NOW = '2026-10-03T07:12:00Z';

describe('relive-run-export', () => {
  // Exports never truncate call data: these bodies are far past any preview limit.
  const big = 'x'.repeat(60_000);
  const recordedBig = 'r'.repeat(50_000);
  const steps = [
    cmpStep('login', { label: 'POST /login' }),
    cmpStep('pax', { label: 'GET /pax', recording: { ...cmpStep('pax').recording, responseBody: `{"note":"${recordedBig}"}` } }),
  ];
  const run = cmpRun('r1', '2026-10-02T16:33:11Z', steps, [
    cmpResult('login', 'COMPLETED', { status: 200 }, { variablesProduced: [{ name: 'token', value: 'S3CRET' }] }),
    cmpResult('pax', 'FAILED', { status: 500, body: `{"message":"S3CRET rejected","blob":"${big}"}` }, { variablesUsed: [{ name: 'token', value: 'S3CRET' }], assertions: [{ kept: true }] }),
  ], {
    finishedAt: '2026-10-02T16:33:18Z',
    variableTimeline: [{ name: 'token', value: 'S3CRET', stepKey: 'login', at: 't' }],
    secrets: ['token'],
    log: [{ at: '2026-10-02T16:33:12Z', stepKey: 'pax', kind: 'ERROR', message: 'pax failed with S3CRET' }],
  });
  const report = buildRunReport(run, NOW);

  describe('run report', () => {
    it('.html is one self-contained page: answer, About this document, steps, glossary, bodies in full, secrets masked', () => {
      const html = buildHtmlRunReport(report);
      expect(html.startsWith('<!DOCTYPE html>')).toBeTrue();
      expect(html).toContain('<title>Relive run report: Booking</title>');
      expect(html).toContain('Failed at step 2, GET /pax:');
      expect(html).toContain('About this document');
      expect(html).toContain('Needs attention');
      expect(html).toContain('id="step-2"');
      expect(html).toContain('Glossary');
      expect(html).toContain(big);
      expect(html).toContain(recordedBig);
      expect(html).not.toContain('S3CRET');
    });

    it('.md reads top-down with tables and folded, full bodies; secrets masked', () => {
      const md = buildMarkdownRunReport(report);
      expect(md.startsWith('# Relive run report: Booking')).toBeTrue();
      expect(md).toContain('> **Failed at step 2, GET /pax:**');
      expect(md).toContain('## About this document');
      expect(md).toContain('**What this is.**');
      expect(md).toContain('| # | Step | Mode | Outcome |');
      expect(md).toContain('### 2 · GET /pax - ✗ failed');
      expect(md).toContain('<details><summary>Response received');
      expect(md).toContain('```json');
      expect(md).toContain(big);
      expect(md).toContain(recordedBig);
      expect(md).toContain('## Glossary');
      expect(md).not.toContain('S3CRET');
    });

    it('.json starts with what it is, keeps every value unmasked and the stored checks', () => {
      const text = buildJsonRunReport(report, { results: latestByStepKey(run.stepResults) });
      const json = JSON.parse(text);
      expect(Object.keys(json).slice(0, 2)).toEqual(['format', 'about']);
      expect(json.format).toBe('alfred.relive.run-report/v1');
      expect(json.about.description).toContain('Relive run');
      expect(json.about.glossary.LIVE).toBeDefined();
      const pax = json.steps[1];
      expect(pax).toEqual(jasmine.objectContaining({ step: '2', label: 'GET /pax', outcome: 'failed', mode: 'LIVE' }));
      expect(pax.response.body.blob).toBe(big);
      expect(pax.response.body.message).toContain('S3CRET');
      expect(pax.recorded.response.body.note).toBe(recordedBig);
      expect(pax.checks).toEqual([{ kept: true }]);
      expect(json.variables[0].value).toBe('S3CRET');
    });
  });

  describe('comparison report', () => {
    const other = cmpRun('r0', '2026-10-02T13:49:19Z', steps, [
      cmpResult('login', 'COMPLETED', { status: 200 }),
      cmpResult('pax', 'COMPLETED', { status: 200, body: '{"paxCount":2}' }),
    ]);
    const a = runSide(other);
    const b = runSide(run);
    const cmpReport = buildCompareReport(compareRuns(a, b, () => []), a, b, 'Booking', NOW);

    it('.html and .md answer first, explain themselves, keep both responses in full and mask secrets', () => {
      for (const doc of [buildHtmlCompareReport(cmpReport), buildMarkdownCompareReport(cmpReport)]) {
        expect(doc).toContain('Relive run comparison: Booking');
        expect(doc).toContain('B is worse:');
        expect(doc).toContain('About this document');
        expect(doc).toContain(big);
        expect(doc).not.toContain('S3CRET');
      }
      expect(buildMarkdownCompareReport(cmpReport)).toContain('{\n  "paxCount": 2\n}');
      expect(buildHtmlCompareReport(cmpReport)).toContain('<span class="tk">&quot;paxCount&quot;</span>: <span class="tn">2</span>');
    });

    it('.json starts with what it is and keeps both sides unmasked', () => {
      const json = JSON.parse(buildJsonCompareReport(cmpReport));
      expect(Object.keys(json).slice(0, 2)).toEqual(['format', 'about']);
      expect(json.format).toBe('alfred.relive.run-comparison/v1');
      expect(json.counts.newFailures).toBe(1);
      const pax = json.steps.find((s: { key: string }) => s.key === 'pax');
      expect(pax.verdict).toBe('new failure');
      expect(pax.a.response.body).toEqual({ paxCount: 2 });
      expect(pax.b.response.body.blob).toBe(big);
      expect(pax.b.response.body.message).toContain('S3CRET');
    });
  });

  describe('readability', () => {
    // pax's answer lost a long "note" field: one long value in its differences.
    const html = buildHtmlRunReport(report);
    const md = buildMarkdownRunReport(report);

    it('every fold starts closed: differences, requests and responses', () => {
      expect(html).not.toContain('<details open');
      expect(md).not.toContain('<details open');
      expect(html).toContain('<details class="fold"><summary><b>Differences from the recording</b>');
      expect(md).toContain('<details><summary>Differences from the recording (');
    });

    it('a long value is folded in .html and written out in full under the table in .md', () => {
      // The cell holds a preview; the whole value opens full width in the row below, never in the cell.
      expect(html).toContain(`${recordedBig.length.toLocaleString('en-US')} characters - full value below`);
      expect(html).toContain('<tr class="long"><td colspan="4"><details class="long-fold"><summary>Show the full values of <b>body.note</b>');
      // Both one under the other by default; one side only, or a line diff, on request.
      expect(html).toContain('<div class="long-box" data-view="both">');
      for (const view of ['both', 'a', 'b', 'diff']) expect(html).toContain(`data-view-btn="${view}"`);
      expect(html).toContain('<pre class="code diff"><span class="dl removed">');
      expect(md).toContain('*long value - see "body.note - Recorded" below*');
      expect(md).toContain(`<details><summary>body.note - Recorded (${recordedBig.length.toLocaleString('en-US')} characters)</summary>`);
      expect(md).toContain(recordedBig);
    });

    it('field names keep their own column and every step shows its full URL', () => {
      expect(html).toContain('<td class="field">body.<wbr>note</td>');
      expect(html).toContain('<col class="c-field">');
      expect(html).toContain('<span class="url-sm">POST https://app.local/api/pax</span>');
      expect(html).toContain('<div class="url-line">POST https://app.local/api/pax</div>');
      expect(md).toContain('GET /pax<br>POST https://app.local/api/pax');
    });
  });

  it('pretty-prints JSON bodies and leaves anything else as it came', () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('<x/>')).toBe('<x/>');
    expect(prettyBody('{broken')).toBe('{broken');
  });
});
