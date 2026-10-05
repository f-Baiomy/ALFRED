import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { buildExportHighlights, highlightsHtml, highlightsMarkdown } from './export-highlights';
import { buildBulkExportMarkdown } from './markdown-builder';
import { buildBulkExportHtml } from './html-builder';

const T0 = Date.parse('2026-10-05T16:04:00Z');

function call(id: string, sec: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id, method: 'POST', original_url: `http://localhost:8080/app/${id}`, url: `http://localhost:8080/app/${id}`,
    timestamp: new Date(T0 + sec * 1000).toISOString(), duration_ms: 100, source: 'internal',
    response: { status: 200, headers: {}, body: '{"ok":true}' }, ...overrides,
  };
}

const comment = (callId: string, block: Comment['block'], text: string): Comment =>
  ({ id: `c-${callId}-${text}`, callId, block, lineIndex: 0, lineText: '', comment: text, createdAt: '' });

const login = call('login', 0);
const search = call('search', 10, { response: { status: 200, headers: {}, body: '{"searchOffers":{"offers":{},"journeys":{}}}' } });
const supplier = call('supplier', 11, { source: 'external', response: { status: 200, headers: {}, body: '<RS><Errors><Error Code="322" ShortText="No availability"/></Errors></RS>' } });
const pay = call('pay', 20, { response: { status: 500, headers: {}, body: '{}' } });
const calls = [pay, supplier, login, search];
const comments = new Map<string, readonly Comment[]>([
  ['search', [comment('search', 'call', 'Search returns nothing for CAI-DXB'), comment('search', 'request-body', 'a line note')]],
  ['supplier', [comment('supplier', 'response-body', '🤖 Claude: Air Arabia answers 322')]],
]);
const spacers = [{ label: 'login', afterCallId: null, anchorTimestamp: null }, { label: 'search', afterCallId: 'login', anchorTimestamp: login.timestamp }];

describe('buildExportHighlights', () => {
  const h = buildExportHighlights(calls, comments, spacers);

  it('numbers calls chronologically and splits steps at the spacers', () => {
    expect(h.steps).toEqual([{ label: 'login', from: 1, to: 1 }, { label: 'search', from: 2, to: 4 }]);
  });

  it('lists failures, errors inside 200s and empty inbound results', () => {
    expect(h.failures.map((f) => f.n)).toEqual([4]);
    expect(h.softFailures).toEqual([jasmine.objectContaining({ n: 3, code: '322', message: 'No availability' })]);
    expect(h.emptyResults).toEqual([jasmine.objectContaining({ n: 2, keys: ['searchOffers.offers', 'searchOffers.journeys'] })]);
  });

  it('keeps whole-call notes and Claude\'s comments, not ordinary line comments', () => {
    expect(h.notes.map((n) => n.text)).toEqual(['Search returns nothing for CAI-DXB', '🤖 Claude: Air Arabia answers 322']);
  });

  it('renders nothing when there is nothing to say', () => {
    const none = buildExportHighlights([login], new Map(), []);
    expect(highlightsMarkdown(none, (t) => t)).toEqual([]);
    expect(highlightsHtml(none, (t) => t)).toBe('');
  });

  it('opens both bulk exports, escaping call data in the html', () => {
    const form = { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Local' as const, description: '' };
    const md = buildBulkExportMarkdown(calls, form, comments, 'now', [], 'all', null, spacers);
    expect(md.indexOf('## 🔎 At a Glance')).toBeLessThan(md.indexOf('## 📖 About This Document'));
    expect(md).toContain('✖ 322: No availability');
    const evil = [call('x', 0, { response: { status: 200, headers: {}, body: '{"errors":["<script>alert(1)</script>"]}' } })];
    const html = buildBulkExportHtml(evil, form, new Map(), 'now');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
