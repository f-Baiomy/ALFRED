import { clearHighlights, paintHighlights, quoteRanges } from './brief-highlights';

describe('brief-highlights (specs/024)', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    host.innerHTML = '<p>Goal</p><ul><li>Branch is <b>no longer</b>\n required (defaults to All Branches)</li><li>Export</li></ul>';
    document.body.appendChild(host);
  });

  afterEach(() => {
    host.remove();
    clearHighlights();
  });

  it('finds each quote across elements and line breaks, and leaves the DOM as it was', () => {
    const before = host.innerHTML;
    const ranges = quoteRanges(host, [{ id: 1, quote: 'Branch is no longer required' }, { id: 2, quote: 'All Branches' }, { id: 3, quote: 'not there' }]);
    expect(ranges.map((r) => [r.id, r.range.toString().replace(/\s+/g, ' ')])).toEqual([[1, 'Branch is no longer required'], [2, 'All Branches']]);
    expect(host.innerHTML).toBe(before);
  });

  it('paints and clears without touching the DOM, and is a no-op where the API is missing', () => {
    const ranges = quoteRanges(host, [{ id: 1, quote: 'Export' }]);
    expect(() => paintHighlights({ user: ranges.map((r) => r.range), claude: [], lit: [] })).not.toThrow();
    const registry = typeof CSS !== 'undefined' ? CSS.highlights as unknown as Map<string, unknown> | undefined : undefined;
    if (registry) expect(registry.has('brief-c')).toBeTrue();
    clearHighlights();
    if (registry) expect(registry.has('brief-c')).toBeFalse();
  });
});
