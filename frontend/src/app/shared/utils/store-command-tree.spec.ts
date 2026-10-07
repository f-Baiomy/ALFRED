import { StoreCommandSummary } from '../../core/models/store-command.model';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { buildStoreItems, keyPattern, keyPatterns, shortCode, storeCommandsOf } from './store-command-tree';
import { storeFindings } from './store-findings';

/** The Redis view's list and the Redis findings (specs/011-redis-capture R14, FR-027). */
let id = 0;
export function redisCmd(seq: number, over: Partial<StoreCommandSummary> = {}): StoreCommandSummary {
  return {
    id: ++id, store: 'redis', seq, at: '2026-10-05T01:00:00.000Z', micros: 400, command: 'GET', keys: [`fare:rule:${seq}`], keysTotal: 1,
    rw: 'r', outcome: 'HIT', replyType: 'BULK', bytes: 20, replyBytes: 40, hasBefore: false,
    code: 'com.tt.ts.cache.FareRuleService.load(FareRuleService.java:57)', ...over,
  };
}

describe('store-command-tree', () => {
  it('turns variable key segments into * and folds 3+ siblings', () => {
    expect(keyPattern('fare:rule:948')).toBe('fare:rule:*');
    expect(keyPattern('upsell:a5b4f2f0')).toBe('upsell:*');
    expect(keyPattern('config:flags')).toBe('config:flags');
    const p = keyPatterns(['airport:DXB', 'airport:LHR', 'airport:JFK', 'config:flags']);
    expect(p.get('airport:DXB')).toBe('airport:*');
    expect(p.get('config:flags')).toBe('config:flags');
    expect(shortCode('com.tt.ts.cache.FareRuleService.load(FareRuleService.java:57)')).toBe('FareRuleService.load');
  });

  it('folds a run of single reads from one code line, and a MULTI … EXEC into one row', () => {
    const cmds = [
      redisCmd(1), redisCmd(2, { outcome: 'MISS' }), redisCmd(3), redisCmd(4, { origin: { cache: 'fareRules' } }),
      redisCmd(5, { command: 'MULTI', keys: [], rw: 'w', group: { kind: 'tx', id: 'g', index: 0, size: 3 } }),
      redisCmd(6, { command: 'SET', rw: 'w', outcome: 'OK', group: { kind: 'tx', id: 'g', index: 1, size: 3 } }),
      redisCmd(7, { command: 'EXEC', keys: [], rw: 'w', outcome: 'OK', group: { kind: 'tx', id: 'g', index: 2, size: 3 } }),
      redisCmd(8, { command: 'SET', rw: 'w', outcome: 'OK' }),
    ];
    const items = buildStoreItems(cmds);
    expect(items.map((i) => i.kind)).toEqual(['group', 'group', 'cmd']);
    const reads = items[0];
    if (reads.kind !== 'group') throw new Error('expected a group');
    expect(reads.verb).toBe('GET ×4');
    expect(reads.meta).toContain('3 hit · 1 miss');
    expect(reads.warn).toBe('⚠ 4 GETs one by one - one MGET would do');
    const tx = items[1];
    if (tx.kind !== 'group') throw new Error('expected a group');
    expect(tx.verb).toBe('MULTI ×3');
    expect(tx.meta).toContain('EXEC OK');
    expect(storeCommandsOf(items).map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(buildStoreItems(cmds, false).length).toBe(8);
  });
});

describe('store-findings', () => {
  const stmt = (seq: number, ms: number) => ({ seq, durationMicros: ms * 1000 }) as unknown as CapturedStatement;

  it('says nothing for a call without commands', () => {
    expect(storeFindings([], [], [], [], 10)).toEqual([]);
  });

  it('a failed command first, then a miss filled from the database, a big value, cold keys and slow commands', () => {
    const cmds = [
      redisCmd(1, { command: 'EVALSHA', outcome: 'FAILED', error: 'NOSCRIPT No matching script', keys: ['lock:1'] }),
      redisCmd(2, { outcome: 'MISS', keys: ['upsell:a5b4f2f0'] }),
      redisCmd(4, { command: 'SET', rw: 'w', outcome: 'OK', keys: ['upsell:a5b4f2f0'], bytes: 2 * 1024 * 1024, micros: 14_200 }),
      redisCmd(5, { outcome: 'MISS', keys: ['airport:DXB'] }),
    ];
    const f = storeFindings(cmds, [5], [stmt(3, 40)], [], 10);
    const ids = f.map((x) => x.id);
    expect(ids[0]).toBe('redis:failed');
    expect(f[0].why).toContain('script cache');
    expect(ids).toContain('redis:miss-db');
    expect(f.find((x) => x.id === 'redis:miss-db')!.impactMs).toBeCloseTo(40);
    expect(ids).toContain('redis:big');
    expect(ids).toContain('redis:cold');
    expect(ids).toContain('redis:slow');
    expect(ids[ids.length - 1]).toBe('redis:safe');
    expect(f.every((x) => x.source === 'REDIS')).toBeTrue();
  });

  it('flags KEYS / FLUSH* in the request path', () => {
    const f = storeFindings([redisCmd(1, { command: 'KEYS', keys: ['fare:*'] })], [], [], [], 10);
    expect(f.find((x) => x.id === 'redis:dangerous')?.severity).toBe('bad');
    expect(f.some((x) => x.id === 'redis:safe')).toBeFalse();
  });
});
