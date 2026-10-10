import { StorageBudget, StorageOverview, StorageShare, StorageSplit, StorageStore } from '../../core/models/storage.model';

/** Settings → Storage's arithmetic - kept out of the component so the ratios and wording are tested on their own. */

export const GB = 1024 ** 3;
export const SHARES: readonly StorageShare[] = ['inbound', 'capture', 'outbound', 'logs', 'reliveRuns', 'work'];

export const SHARE_LABEL: Record<StorageShare, string> = {
  inbound: 'Inbound calls',
  capture: 'DB statements, Redis & logs of calls',
  outbound: 'Outbound calls',
  logs: 'Logs',
  reliveRuns: 'Relive runs',
  work: 'Your work & setup',
};

/** A CSS variable per share - the same colours on the bar, its legend and the store list. */
export const SHARE_COLOR: Record<StorageShare, string> = {
  inbound: 'var(--purple)',
  capture: 'var(--tok-number)',
  outbound: 'var(--cyan)',
  logs: 'var(--tok-bool)',
  reliveRuns: 'var(--purple-light)',
  work: 'var(--green)',
};

/** Must match backend StorageBudget's presets. */
export const PRESETS: Record<Exclude<StorageSplit, 'custom' | 'even'>, Record<StorageShare, number>> = {
  recommended: { inbound: 0.55, capture: 0.2, outbound: 0.1, logs: 0.08, reliveRuns: 0.02, work: 0.05 },
  inbound: { inbound: 0.6, capture: 0.17, outbound: 0.06, logs: 0.1, reliveRuns: 0.02, work: 0.05 },
  outbound: { inbound: 0.38, capture: 0.12, outbound: 0.33, logs: 0.1, reliveRuns: 0.02, work: 0.05 },
};

export const BUDGET_CHOICES_GB: readonly number[] = [1, 2, 5, 10, 20];
export const RECOMMENDED_GB = 5;
export const MIN_GB = 1;

/** The ratios a budget uses, scaled to add up to 1 (a custom split may not). */
export function ratiosOf(budget: Pick<StorageBudget, 'split' | 'ratios'>): Record<StorageShare, number> {
  const chosen: Partial<Record<StorageShare, number>> =
    budget.split === 'custom' || budget.split === 'even' ? budget.ratios : PRESETS[budget.split] ?? PRESETS.recommended;
  const sum = SHARES.reduce((a, k) => a + Math.max(0, chosen[k] ?? 0), 0);
  const out = {} as Record<StorageShare, number>;
  for (const k of SHARES) out[k] = sum <= 0 ? PRESETS.recommended[k] : Math.max(0, chosen[k] ?? 0) / sum;
  return out;
}

/** Bytes of every share - a ratio of the one budget, so changing the budget scales all of them. */
export function shareBytes(bytes: number, budget: Pick<StorageBudget, 'split' | 'ratios'>): Record<StorageShare, number> {
  const r = ratiosOf(budget);
  const out = {} as Record<StorageShare, number>;
  for (const k of SHARES) out[k] = Math.floor(bytes * r[k]);
  return out;
}

/**
 * "Same history for all": ratios from how fast each kind of traffic grows, so each keeps about as many days. Logs,
 * Relive runs and your work keep their recommended ratios.
 */
export function evenRatios(overview: StorageOverview, now = Date.now()): Record<StorageShare, number> {
  const fixed = PRESETS.recommended.logs + PRESETS.recommended.reliveRuns + PRESETS.recommended.work;
  const rates = { inbound: 0, capture: 0, outbound: 0 } as Record<'inbound' | 'capture' | 'outbound', number>;
  for (const k of ['inbound', 'capture', 'outbound'] as const) {
    rates[k] = growthPerDay(overview, k, now);
  }
  const sum = rates.inbound + rates.capture + rates.outbound;
  if (sum <= 0) return { ...PRESETS.recommended };
  return {
    inbound: ((1 - fixed) * rates.inbound) / sum,
    capture: ((1 - fixed) * rates.capture) / sum,
    outbound: ((1 - fixed) * rates.outbound) / sum,
    logs: PRESETS.recommended.logs,
    reliveRuns: PRESETS.recommended.reliveRuns,
    work: PRESETS.recommended.work,
  };
}

/** Live data of a store - the empty space inside its file and its write log are given back first, never forcing a delete. */
export function liveBytes(store: StorageStore): number {
  return Math.max(0, store.sizeBytes - store.freeBytes - store.walBytes);
}

/** Bytes a share grows by per day, from what it holds and how old its oldest item is (0 when unknown). */
export function growthPerDay(overview: StorageOverview, share: StorageShare, now = Date.now()): number {
  const stores = overview.stores.filter((s) => s.share === share);
  const used = stores.reduce((a, s) => a + liveBytes(s), 0);
  const oldest = stores
    .map((s) => (s.oldest ? Date.parse(s.oldest) : NaN))
    .filter((t) => !Number.isNaN(t))
    .reduce((a, t) => Math.min(a, t), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(oldest) || used <= 0) return 0;
  const days = Math.max(1 / 24, (now - oldest) / 86_400_000);
  return used / days;
}

/** "~14 days", "~6 hours" - how long a share of this size lasts at the recent rate; null when unknown. */
export function historyKept(bytes: number, perDay: number): string | null {
  if (perDay <= 0) return null;
  const days = bytes / perDay;
  if (days >= 365) return 'over a year';
  if (days >= 2) return `~${Math.round(days)} days`;
  return `~${Math.max(1, Math.round(days * 24))} hours`;
}

/**
 * Shares that would delete their oldest data the moment this budget is set, with how much. Not logs (a source drops
 * its oldest lines as new ones load) and never your work.
 */
export function overflow(overview: StorageOverview, bytes: number, budget: Pick<StorageBudget, 'split' | 'ratios'>):
  { share: StorageShare; bytes: number }[] {
  const shares = shareBytes(bytes, budget);
  return SHARES.filter((k) => k !== 'work' && k !== 'logs')
    .map((k) => ({ share: k, bytes: Math.max(0, (overview.shareUsed[k] ?? 0) - shares[k]) }))
    .filter((o) => o.bytes > 0);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const e = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** e;
  return `${e === 0 ? v : v.toFixed(e >= 3 ? 2 : 1)} ${units[e]}`;
}

/** "3 days ago" style age of an ISO time; '' when absent. */
export function ageOf(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const h = (now - t) / 3_600_000;
  if (h < 1) return 'under an hour';
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}
