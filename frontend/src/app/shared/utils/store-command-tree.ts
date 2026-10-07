import { StoreCommandSummary } from '../../core/models/store-command.model';

/**
 * The Redis view's list (specs/011-redis-capture R14, mock section 3): a call's commands in order, with
 *  - a transaction (MULTI … EXEC) or pipeline as one row ("MULTI ×2 · 1 round trip · EXEC OK"), its commands under it;
 *  - a run of 3+ single reads of one key pattern from one code line folded into one row ("GET ×9 · 6 hit · 3 miss")
 *    with the batching warning - the N+1 of Redis.
 * Pure: re-run whenever the page of commands changes. Key patterns follow the backend's KeyPattern exactly.
 */

export type StoreItem = StoreCommandItem | StoreGroupItem;

export interface StoreCommandItem {
  readonly kind: 'cmd';
  readonly seq: number;
  readonly cmd: StoreCommandSummary;
}

export interface StoreGroupItem {
  readonly kind: 'group';
  readonly groupKind: 'reads' | 'tx' | 'pipeline';
  readonly key: string;
  readonly seq: number;
  readonly lastSeq: number;
  readonly commands: readonly StoreCommandSummary[];
  /** "GET ×9", "MULTI ×2", "PIPELINE ×3". */
  readonly verb: string;
  readonly verbClass: 'v-rr' | 'v-rw' | 'v-rx';
  /** The key or pattern the row names. */
  readonly pattern: string;
  /** "· cache fareRules · 9 round trips from FareRuleService.load · 6 hit · 3 miss". */
  readonly meta: string;
  /** "⚠ 9 GETs one by one - one MGET would do" (reads runs only). */
  readonly warn: string | null;
  readonly micros: number;
}

/** A run of single reads this long is folded and flagged. */
export const READ_RUN = 3;
const SIBLINGS = 3;

/** Commands that read one key each and have a batched form. */
const BATCHED: Readonly<Record<string, string>> = { GET: 'MGET', HGETALL: 'pipeline', HGET: 'HMGET', EXISTS: 'EXISTS with several keys', TTL: 'pipeline', SISMEMBER: 'SMISMEMBER' };

function variable(s: string): boolean {
  if (!s) return false;
  return /^\d+$/.test(s) || (s.length >= 8 && /^[0-9a-fA-F-]+$/.test(s));
}

/** A key with its variable segments as `*` (digits, hex/uuid of 8+) - the backend's KeyPattern.of. */
export function keyPattern(key: string): string {
  return key.split(':').map((p) => (variable(p) ? '*' : p)).join(':');
}

/** Each key's pattern, siblings folded: 3+ keys sharing everything before their last segment → `prefix:*`. */
export function keyPatterns(keys: Iterable<string>): Map<string, string> {
  const base = new Map<string, string>();
  for (const k of keys) base.set(k, keyPattern(k));
  const lastByPrefix = new Map<string, Set<string>>();
  for (const p of new Set(base.values())) {
    const cut = p.lastIndexOf(':');
    if (cut > 0) {
      const prefix = p.slice(0, cut);
      if (!lastByPrefix.has(prefix)) lastByPrefix.set(prefix, new Set());
      lastByPrefix.get(prefix)!.add(p.slice(cut + 1));
    }
  }
  const out = new Map<string, string>();
  for (const [k, p] of base) {
    const cut = p.lastIndexOf(':');
    out.set(k, cut > 0 && (lastByPrefix.get(p.slice(0, cut))?.size ?? 0) >= SIBLINGS ? `${p.slice(0, cut)}:*` : p);
  }
  return out;
}

/** "FareRuleService.load" from a code line "com.tt.ts.cache.FareRuleService.load(FareRuleService.java:57)". */
export function shortCode(code: string | null | undefined): string {
  if (!code) return '';
  const head = code.split('(')[0];
  const parts = head.split('.');
  return parts.length >= 2 ? `${parts[parts.length - 2]}.${parts[parts.length - 1]}` : head;
}

export function buildStoreItems(commands: readonly StoreCommandSummary[], grouped = true): StoreItem[] {
  const ordered = [...commands].sort((a, b) => a.seq - b.seq);
  if (!grouped) return ordered.map((cmd) => ({ kind: 'cmd' as const, seq: cmd.seq, cmd }));
  const patterns = keyPatterns(ordered.flatMap((c) => c.keys));
  const out: StoreItem[] = [];
  let i = 0;
  while (i < ordered.length) {
    const c = ordered[i];
    if (c.group) {
      let j = i;
      while (j < ordered.length && ordered[j].group?.id === c.group.id) j++;
      const members = ordered.slice(i, j);
      if (members.length > 1) {
        out.push(groupOf(c.group.kind === 'tx' ? 'tx' : 'pipeline', members, patterns));
        i = j;
        continue;
      }
    }
    if (c.rw === 'r' && c.keys.length === 1 && !c.group) {
      const pattern = patterns.get(c.keys[0]) ?? c.keys[0];
      let j = i;
      while (j < ordered.length && sameRead(ordered[j], c, pattern, patterns)) j++;
      if (j - i >= READ_RUN) {
        out.push(groupOf('reads', ordered.slice(i, j), patterns));
        i = j;
        continue;
      }
    }
    out.push({ kind: 'cmd', seq: c.seq, cmd: c });
    i++;
  }
  return out;
}

function sameRead(x: StoreCommandSummary, first: StoreCommandSummary, pattern: string, patterns: Map<string, string>): boolean {
  return x.rw === 'r' && !x.group && x.keys.length === 1 && x.command === first.command && (x.code ?? '') === (first.code ?? '')
    && (patterns.get(x.keys[0]) ?? x.keys[0]) === pattern;
}

function groupOf(kind: StoreGroupItem['groupKind'], members: readonly StoreCommandSummary[], patterns: Map<string, string>): StoreGroupItem {
  const first = members[0];
  const last = members[members.length - 1];
  const micros = members.reduce((n, m) => n + m.micros, 0);
  const failed = members.some((m) => m.outcome === 'FAILED');
  const key = `rg:${kind}:${first.seq}`;
  const keyOf = (m: StoreCommandSummary) => (m.keys[0] ? patterns.get(m.keys[0]) ?? m.keys[0] : '');
  if (kind === 'reads') {
    const hits = members.filter((m) => m.outcome === 'HIT').length;
    const misses = members.filter((m) => m.outcome === 'MISS').length;
    const caches = new Set(members.map((m) => m.origin?.cache).filter((x): x is string => !!x));
    const cache = caches.size === 1 ? ` · cache ${[...caches][0]}` : '';
    const from = shortCode(first.code);
    const batched = BATCHED[first.command] ?? 'pipeline';
    const word = batched === 'pipeline' ? 'one pipeline' : `one ${batched}`;
    return {
      kind: 'group', groupKind: kind, key, seq: first.seq, lastSeq: last.seq, commands: members,
      verb: `${first.command} ×${members.length}`, verbClass: failed ? 'v-rx' : 'v-rr', pattern: keyOf(first),
      meta: `${cache} · ${members.length} round trips${from ? ` from ${from}` : ''} · ${hits} hit · ${misses} miss`,
      warn: `⚠ ${members.length} ${first.command}s one by one - ${word} would do`, micros,
    };
  }
  const keys = new Set(members.map(keyOf).filter((k) => !!k));
  const pattern = keys.size === 1 ? [...keys][0] : keys.size ? `${[...keys][0]} +${keys.size - 1}` : '';
  if (kind === 'tx') {
    const exec = members.find((m) => m.command === 'EXEC' || m.command === 'DISCARD');
    const end = exec ? ` · ${exec.command} ${exec.outcome === 'FAILED' ? 'failed' : 'OK'}` : ' · no EXEC seen';
    return {
      kind: 'group', groupKind: kind, key, seq: first.seq, lastSeq: last.seq, commands: members,
      verb: `MULTI ×${members.length}`, verbClass: failed ? 'v-rx' : 'v-rw', pattern,
      meta: `· transaction MULTI … EXEC · 1 round trip${end}`, warn: null, micros,
    };
  }
  return {
    kind: 'group', groupKind: kind, key, seq: first.seq, lastSeq: last.seq, commands: members,
    verb: `PIPELINE ×${members.length}`, verbClass: failed ? 'v-rx' : members.every((m) => m.rw === 'r') ? 'v-rr' : 'v-rw', pattern,
    meta: `· pipeline · 1 round trip for ${members.length} commands`, warn: null, micros,
  };
}

/** Every command of the items (a group's members included), in order. */
export function storeCommandsOf(items: readonly StoreItem[]): StoreCommandSummary[] {
  return items.flatMap((i) => (i.kind === 'cmd' ? [i.cmd] : [...i.commands]));
}
