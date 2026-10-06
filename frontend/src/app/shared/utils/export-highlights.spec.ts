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

  it('writes the .md as a table: steps as band rows, one row per note, then "Needs a look"', () => {
    const md = highlightsMarkdown(h, (t) => t.replace(/\|/g, '\\|')).join('\n');
    expect(md).toContain('**4 calls · 2 steps · 2 notes · 1 failed · 1 error inside a 200 · 1 empty result**');
    expect(md).toContain('| Call | Request | Note |');
    expect(md).toContain('| **0 · login** · call 1 · _no notes_ | | |');
    expect(md).toContain('| **1 · search** · calls 2–4 | | |');
    expect(md).toContain('| [2](#call-2) | `POST` app/search → 200 | Search returns nothing for CAI-DXB |');
    expect(md).toContain('| [3](#call-3) | `POST` app/supplier → 200 | 🤖 Air Arabia answers 322 |');
    expect(md).toContain('### Needs a look');
    expect(md).toContain('| [4](#call-4) | `POST` app/pay → **500** | failed with 500 |');
  });

  it('writes the .html as a story: steps on a rail, each note a card under its call, Claude as a tag', () => {
    const html = highlightsHtml(h, (t) => t);
    expect(html).toContain('<div class="gl-step" data-n="0">login<span class="gl-rg">call 1</span></div><div class="gl-quiet">no notes</div>');
    expect(html).toContain('<span class="gl-by">Claude</span><p>Air Arabia answers 322</p>');
    expect(html).toContain('<a class="gl-cl" href="#call-3">call 3</a>');
    expect(html).toContain('<div class="gl-sec">Needs a look</div>');
  });

  it('lifts the cycle overview note above the steps, whole, paragraphs kept', () => {
    const text = '🤖 Claude: CYCLE OVERVIEW – This cycle shows the flow.\n\nSecond paragraph.';
    const withOverview = buildExportHighlights(calls, new Map([['login', [comment('login', 'call', text)]]]), spacers);
    expect(withOverview.overview?.n).toBe(1);
    expect(withOverview.notes).toEqual([]);
    const html = highlightsHtml(withOverview, (t) => t);
    expect(html).toContain('cycle overview · on <a href="#call-1">call 1</a></div><p>This cycle shows the flow.</p><p>Second paragraph.</p>');
    const md = highlightsMarkdown(withOverview, (t) => t).join('\n');
    expect(md).toContain('> This cycle shows the flow.\n>\n> Second paragraph.');
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
