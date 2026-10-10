import { DEFAULT_RULES, StorageOverview, StorageStore } from '../../core/models/storage.model';
import { GB, evenRatios, formatBytes, historyKept, overflow, ratiosOf, shareBytes } from './storage-budget';

const NOW = Date.parse('2026-10-10T12:00:00Z');

function store(share: StorageStore['share'], sizeBytes: number, oldest: string | null, freeBytes = 0): StorageStore {
  return {
    id: share, name: share, group: 'traffic', share, files: 'x.db', items: 1, unit: 'calls', sizeBytes, freeBytes,
    walBytes: 0, oldest, limitBytes: null, limitCalls: null, cleanable: true,
  };
}

function overview(stores: StorageStore[]): StorageOverview {
  const shareUsed = { inbound: 0, capture: 0, outbound: 0, logs: 0, reliveRuns: 0, work: 0 };
  for (const s of stores) shareUsed[s.share] += s.sizeBytes - s.freeBytes;
  return {
    usedBytes: 0, freeInsideBytes: 0, disk: { path: '/', freeBytes: 100 * GB, totalBytes: 500 * GB },
    budget: { bytes: null, split: 'recommended', ratios: {}, inboundMaxCalls: 0, outboundMaxCalls: 0, reliveKeepRuns: 0, maxAgeDays: {}, rules: DEFAULT_RULES },
    shareBytes: { inbound: 0, capture: 0, outbound: 0, logs: 0, reliveRuns: 0, work: 0 }, shareUsed,
    maxBudgetBytes: 50 * GB, stores, relive: [], history: [], lowDisk: false,
  };
}

describe('storage-budget', () => {
  it('splits a budget by the recommended ratios, matching the backend', () => {
    const s = shareBytes(10 * GB, { split: 'recommended', ratios: {} });
    expect(s.inbound).toBe(Math.floor(10 * GB * 0.55));
    expect(s.capture).toBe(Math.floor(10 * GB * 0.2));
    expect(s.outbound).toBe(Math.floor(10 * GB * 0.1));
  });

  it('scales every share with the budget: the ratios stay', () => {
    const five = shareBytes(5 * GB, { split: 'inbound', ratios: {} });
    const twenty = shareBytes(20 * GB, { split: 'inbound', ratios: {} });
    for (const k of Object.keys(five) as (keyof typeof five)[]) {
      expect(twenty[k] / five[k]).toBeCloseTo(4, 3);
    }
  });

  it('normalises a custom split that does not add up to 1', () => {
    const r = ratiosOf({ split: 'custom', ratios: { inbound: 2, capture: 1, outbound: 1, logs: 0, reliveRuns: 0, work: 0 } });
    expect(r.inbound).toBeCloseTo(0.5, 5);
    expect(r.capture).toBeCloseTo(0.25, 5);
  });

  it('gives each kind of traffic a share by how fast it grows for "same history for all"', () => {
    const o = overview([
      store('inbound', 9 * GB, '2026-10-01T12:00:00Z'),
      store('outbound', 1 * GB, '2026-10-01T12:00:00Z'),
    ]);
    const r = evenRatios(o, NOW);
    expect(r.inbound / r.outbound).toBeCloseTo(9, 3);
    expect(r.capture).toBe(0);
  });

  it('names the shares a smaller budget would cut now, counting live data only - logs trim as lines load', () => {
    const o = overview([store('inbound', 2 * GB, null), store('logs', 1.5 * GB, null, 0.5 * GB)]);
    const cut = overflow(o, 2 * GB, { split: 'recommended', ratios: {} });
    expect(cut.map((c) => c.share)).toEqual(['inbound']);
    expect(cut[0].bytes).toBe(2 * GB - Math.floor(2 * GB * 0.55));
  });

  it('says how long a share lasts', () => {
    expect(historyKept(14 * GB, GB)).toBe('~14 days');
    expect(historyKept(GB / 4, GB)).toBe('~6 hours');
    expect(historyKept(GB, 0)).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * GB)).toBe('2.00 GB');
  });
});
