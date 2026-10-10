import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { ExportedCycle, ExportFormData } from '../../core/models/export-metadata.model';
import { Redaction } from '../../core/models/redaction.model';
import { buildExportFile, ExportBuildInput } from './export-build';
import { buildBulkExportHtml, exportHtmlFilename } from './html-builder';
import { buildJsonExportV2 } from './json-export-v2';
import { buildBulkExportMarkdown, buildExportMarkdown, bulkExportCycleFilename, exportFilename } from './markdown-builder';
import { redactCalls, setSecretValues } from './redact';

const TOKEN = 'Bearer eyJhbGciOiJIUzI1NiJ9.SUPERSECRET';
const EXPORTED_AT = '2026-10-05T12:00:00.000Z';

function call(id: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    original_url: 'http://localhost:8080/odeysysadmin/Booking2/flight-search/search',
    url: 'http://host.docker.internal:9001/odeysysadmin/Booking2/flight-search/search',
    method: 'POST',
    request: { headers: { Authorization: TOKEN, 'Content-Type': 'application/json' }, body: '{"from":"CAI","to":"DXB"}' },
    timestamp: '2026-10-05T01:34:15.738Z',
    duration_ms: 1200,
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
    source: 'internal',
    ...overrides,
  };
}

const form: ExportFormData = { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging', description: '' };
const authRedaction: Redaction = { id: 'r1', scope: 'all', callId: null, kind: 'request-header', name: 'Authorization', createdAt: EXPORTED_AT };
const cycle: ExportedCycle = { id: 'cy1', name: 'booking fails at payment', assignedTo: null, status: 'PAUSED', createdAt: EXPORTED_AT };

function input(calls: readonly CallRecord[], overrides: Partial<ExportBuildInput> = {}): ExportBuildInput {
  return {
    calls,
    form,
    commentsByCallId: new Map<string, readonly Comment[]>(),
    overlapCandidates: [],
    statusFilter: 'all',
    cycle: null,
    spacers: [],
    listOrder: 'chronological',
    redactions: [],
    rows: 'all',
    exportedAt: EXPORTED_AT,
    fileName: '',
    ...overrides,
  };
}

describe('buildExportFile', () => {
  afterEach(() => setSecretValues([]));

  it('one call outside a cycle takes the single-call markdown builder and its file name', () => {
    const one = call('a');
    const built = buildExportFile('markdown', input([one]));
    expect(built.kind).toBe('text');
    if (built.kind !== 'text') return;
    expect(built.content).toBe(buildExportMarkdown(one, form, [], []));
    expect(built.filename).toBe(exportFilename(one));
    expect(built.mimeType).toBe('text/markdown');
  });

  it('a whole cycle takes the bulk builders even at one call, named after the cycle', () => {
    const one = call('a');
    const md = buildExportFile('markdown', input([one], { cycle }));
    const html = buildExportFile('html', input([one], { cycle }));
    if (md.kind !== 'text' || html.kind !== 'text') return fail('expected text exports');
    expect(md.content).toBe(buildBulkExportMarkdown([one], form, new Map(), EXPORTED_AT, [], 'all', cycle, [], 'chronological'));
    expect(md.filename).toBe(bulkExportCycleFilename(cycle, [one], 'md'));
    expect(html.content).toBe(buildBulkExportHtml([one], form, new Map(), EXPORTED_AT, [], 'all', cycle, [], 'chronological'));
    expect(html.filename).toBe(bulkExportCycleFilename(cycle, [one], 'html'));
  });

  it('single-call html uses the single-call html name', () => {
    const one = call('a');
    const built = buildExportFile('html', input([one]));
    expect(built.filename).toBe(exportHtmlFilename(one));
  });

  it('json is the v2 line format of the masked calls', () => {
    const calls = [call('a'), call('b')];
    const built = buildExportFile('json', input(calls, { redactions: [authRedaction], cycle }));
    expect(built.kind).toBe('lines');
    if (built.kind !== 'lines') return;
    const masked = redactCalls(calls, [authRedaction]);
    expect(built.lines).toEqual(buildJsonExportV2({
      calls: masked.calls, form, commentsByCallId: new Map(), exportedAt: EXPORTED_AT, overlapCandidates: [], statusFilter: 'all',
      redactedValueCount: masked.redactedValueCount, cycle, rows: 'all',
    }));
    expect(built.redactedValueCount).toBe(2);
  });

  it('always masks: a redacted header never reaches any format', () => {
    for (const format of ['markdown', 'html', 'json', 'postman'] as const) {
      const built = buildExportFile(format, input([call('a'), call('b')], { redactions: [authRedaction] }));
      const textOf = built.kind === 'lines' ? built.lines.join('\n') : built.kind === 'payload' ? JSON.stringify(built.payload) : built.content;
      expect(textOf).withContext(format).not.toContain('SUPERSECRET');
      expect(built.redactedValueCount).withContext(format).toBeGreaterThan(0);
    }
  });

  it('masks secret variable values too', () => {
    setSecretValues(['CAI","to']);
    const built = buildExportFile('markdown', input([call('a')]));
    if (built.kind !== 'text') return fail('expected text');
    expect(built.content).not.toContain('CAI","to');
  });

  it('applies a typed file name with the format\'s real extension', () => {
    expect(buildExportFile('json', input([call('a')], { fileName: 'repro' })).filename).toBe('repro.json');
    expect(buildExportFile('markdown', input([call('a')], { fileName: 'repro.md' })).filename).toBe('repro.md');
  });

  describe('the board sections of a cycle export (specs/014-task-board FR-046)', () => {
    const board = {
      title: 'Board - booking fails at payment',
      data: {
        project: 'odeysys',
        cards: [{
          id: 'k1', project: 'odeysys', number: 7, kind: 'BUG' as const, title: 'Discount not saved', description: 'ORDERS.discount is NULL',
          status: 'IN_PROGRESS' as const, resolution: null, reason: null, flags: ['URGENT' as const], scope: 'IN_SCOPE' as const,
          author: 'CLAUDE' as const, cycleId: 'cy1', cycleDeleted: false, signature: null, createdAt: EXPORTED_AT, updatedAt: EXPORTED_AT,
          updatedBy: 'USER' as const, commentCount: 0, similarClosed: null, links: [],
        }],
        activity: {},
        briefs: [{ cycleId: 'cy1', text: 'ODY-482 discount on checkout', updatedAt: EXPORTED_AT }],
        specs: [{ cycleId: 'cy1', name: 'spec.md', content: '## Acceptance\n1. POST /orders returns 201', uploadedAt: EXPORTED_AT }],
        marks: [],
      },
    };

    it('leaves every format exactly as before when both boxes are off', () => {
      for (const format of ['markdown', 'html', 'json'] as const) {
        const without = buildExportFile(format, input([call('a'), call('b')], { cycle }));
        const off = buildExportFile(format, input([call('a'), call('b')], { cycle, board: null }));
        expect(off).toEqual(without);
      }
    });

    it('appends the brief, the spec files in full and the cards to the report when on', () => {
      const md = buildExportFile('markdown', input([call('a'), call('b')], { cycle, board }));
      const html = buildExportFile('html', input([call('a'), call('b')], { cycle, board }));
      if (md.kind !== 'text' || html.kind !== 'text') throw new Error('expected text');
      for (const text of [md.content, html.content]) {
        expect(text).toContain('ODY-482 discount on checkout');
        expect(text).toContain('1. POST /orders returns 201');
        expect(text).toContain('Discount not saved');
      }
      expect(html.content.indexOf('Discount not saved')).toBeLessThan(html.content.lastIndexOf('</body>'));
    });
  });
});
