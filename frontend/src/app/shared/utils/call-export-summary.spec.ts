import { CallRecord } from '../../core/models/call.model';
import { callExportOverview, framedSplitParents, glossaryFor, orderBlocksAsShown } from './call-export-summary';

type Block = { readonly variant: 'request' | 'response' | 'full'; readonly call: { readonly id: string } };
const block = (id: string, variant: Block['variant'] = 'full'): Block => ({ variant, call: { id } });
const ids = (blocks: readonly Block[]) => blocks.map((b) => (b.variant === 'full' ? b.call.id : `${b.call.id}:${b.variant}`));

describe('call-export-summary', () => {
  describe('orderBlocksAsShown', () => {
    // In time order: search is sent, calls its supplier, answers; then up-selling, then by-branch.
    const chrono = [block('search', 'request'), block('supplier'), block('search', 'response'), block('upsell'), block('branch')];
    const depth = (id: string) => (id === 'supplier' ? 1 : 0);

    it('lists the units the way the screen did (newest first) and keeps a split call with what it caused, in time order', () => {
      const shown = [{ id: 'branch' }, { id: 'upsell' }, { id: 'search' }, { id: 'supplier' }];
      expect(ids(orderBlocksAsShown(chrono, shown, depth))).toEqual(['branch', 'upsell', 'search:request', 'supplier', 'search:response']);
    });

    it('a call nested under an unsplit parent travels with it', () => {
      const blocks = [block('parent'), block('child'), block('other')];
      const shown = [{ id: 'other' }, { id: 'child' }, { id: 'parent' }];
      expect(ids(orderBlocksAsShown(blocks, shown, (id) => (id === 'child' ? 1 : 0)))).toEqual(['other', 'parent', 'child']);
    });

    it('a call the screen did not list keeps its place after the listed ones', () => {
      expect(ids(orderBlocksAsShown([block('a'), block('b')], [{ id: 'b' }], () => 0))).toEqual(['b', 'a']);
    });
  });

  it('frames only split parents whose halves nest', () => {
    const nested = [block('a', 'request'), block('b', 'request'), block('b', 'response'), block('a', 'response')];
    expect([...framedSplitParents(nested)].sort()).toEqual(['a', 'b']);
    const interleaved = [block('a', 'request'), block('b', 'request'), block('a', 'response'), block('b', 'response')];
    expect([...framedSplitParents(interleaved)]).toEqual(['b']);
  });

  it('names the failure and the call that caused it', () => {
    const call = (id: string, status: number, url: string): CallRecord =>
      ({ id, url, original_url: url, method: 'POST', timestamp: 't', duration_ms: 1, request: { headers: {}, body: '' }, response: { status, headers: {}, body: '' } }) as CallRecord;
    const parent = call('p', 502, 'https://app/price');
    const child = call('c', 500, 'https://supplier/price');
    const topology = [{ callId: 'p', number: 1, children: [{ callId: 'c', number: 2, children: [] }] }] as never;
    const overview = callExportOverview([parent, child], new Map(), topology);
    expect(overview.verdict.lead).toBe('2 of 2 calls failed:');
    expect(overview.verdict.text).toBe('1 · POST /price answered 502 because its call 2 · POST /price answered 500.');
  });

  it('a glossary holds only the terms the export uses', () => {
    expect(glossaryFor({}).map((g) => g.term)).toEqual(['Inbound · outbound']);
    expect(glossaryFor({ split: true, spacers: true }).map((g) => g.term)).toContain('Spacer (🏷️)');
  });
});
