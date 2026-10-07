import { CapturedStatement } from '../../core/models/db-capture.model';
import { LinkedLogLine } from '../../core/models/call-logs.model';
import { StoreCommandSummary } from '../../core/models/store-command.model';
import { CHIP_LIMIT, DbFinding, FindingChip, ItemKind, fmtMs } from './db-findings';
import { StoreGroupItem, buildStoreItems, keyPatterns } from './store-command-tree';

/**
 * The Redis checks of the Findings pane (specs/011-redis-capture FR-027, mock section 4): a failed command, single
 * reads one by one, a miss followed by the database query that fills it, a big value, a cold cache, the dangerous
 * whole-database commands, slow commands. Each says why and what to do, and its chips jump to the commands.
 * Pure - from the call's commands, the backend's cold marks, its statements and its log lines.
 */

export const BIG_WRITE_BYTES = 1024 * 1024;
export const BIG_READ_BYTES = 512 * 1024;
const DANGEROUS = new Set(['KEYS', 'FLUSHDB', 'FLUSHALL']);
/** SCAN commands in one call past which it is a loop over the keyspace. */
const SCAN_LOOP = 10;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chip(c: StoreCommandSummary, kind: ItemKind, label?: string): FindingChip {
  return { key: `r${c.seq}`, seq: c.seq, kind, n: `#${c.seq}`, label: label ?? `${c.command} ${c.keys[0] ?? ''}`.trim(), ms: c.micros / 1000 };
}

function finding(id: string, severity: DbFinding['severity'], title: string, short: string, why: string, fix: string | undefined,
                 commands: readonly StoreCommandSummary[], count: string, impactMs: number | null, chips: FindingChip[]): DbFinding {
  return {
    id: `redis:${id}`, severity, icon: severity === 'bad' ? '✖' : severity === 'warn' ? '⚠' : 'ℹ', title, short, why, fix,
    impactMs, impact: impactMs != null ? `≈ ${fmtMs(impactMs)}` : '', count,
    seqs: commands.map((c) => c.seq), keys: commands.map((c) => `r${c.seq}`), chips: chips.slice(0, CHIP_LIMIT),
    source: 'REDIS', fingerprints: [],
  };
}

export function storeFindings(commands: readonly StoreCommandSummary[], cold: readonly number[], statements: readonly CapturedStatement[],
                              logs: readonly LinkedLogLine[], slowMillis: number): DbFinding[] {
  if (!commands.length) return [];
  const out: DbFinding[] = [];
  const ordered = [...commands].sort((a, b) => a.seq - b.seq);

  // ---- a failed command
  const failed = ordered.filter((c) => c.outcome === 'FAILED');
  if (failed.length) {
    const first = failed[0];
    const noScript = failed.some((c) => (c.error ?? '').startsWith('NOSCRIPT'));
    const errorLine = logs.find((l) => l.seq != null && l.seq > first.seq && (l.level ?? '').toUpperCase().startsWith('ERR'));
    const chips = failed.map((c) => chip(c, 'err', `${c.command} ${c.keys[0] ?? ''} · ${c.error ?? 'failed'}`.trim()));
    if (errorLine) chips.push({ key: `log${errorLine.seq}`, seq: errorLine.seq!, kind: 'err', n: '▤', label: `ERROR ${errorLine.message.slice(0, 80)}` });
    out.push(finding('failed', 'bad', 'Redis command failed', `${first.command} - ${first.error ?? 'no reply'}`,
      noScript
        ? 'The script was not loaded on this Redis (a restart or failover empties the script cache). The application then has to retry with EVAL - or fails.'
        : 'Redis answered with an error, or the reply never came (timeout, lost connection). The call may have carried on as if nothing happened.',
      noScript ? 'Load the script on startup (SCRIPT LOAD) or let the client fall back automatically.' : 'Check the error and the code line that sent the command.',
      failed, `${failed.length} ${failed.length === 1 ? 'command' : 'commands'}`, null, chips));
  }

  // ---- single reads one by one (the folded runs of the Redis view)
  for (const g of buildStoreItems(ordered).filter((i): i is StoreGroupItem => i.kind === 'group' && i.groupKind === 'reads')) {
    const savedMs = (g.micros / 1000) * (1 - 1 / g.commands.length);
    const batched = g.warn?.split(' - ')[1]?.replace(' would do', '') ?? 'one batched read';
    out.push(finding(`reads:${g.seq}`, 'warn', `${g.commands.length} ${g.commands[0].command}s one by one`, `${g.pattern} - ${batched} would do`,
      `The same key pattern was read ${g.commands.length} times in a row from the same code line, each its own round trip.`,
      `Read them together: ${batched} - 1 round trip instead of ${g.commands.length}.`,
      g.commands, `${g.commands.length} round trips`, savedMs, g.commands.map((c) => chip(c, 'rep'))));
  }

  // ---- a miss, then the database, then the key written: the cache was empty and the call filled it
  const filled: StoreCommandSummary[] = [];
  let dbMs = 0;
  for (const miss of ordered.filter((c) => c.outcome === 'MISS' && c.keys.length)) {
    const write = ordered.find((c) => c.seq > miss.seq && c.rw === 'w' && c.keys.includes(miss.keys[0]));
    if (!write) continue;
    const between = statements.filter((s) => s.seq > miss.seq && s.seq < write.seq);
    if (!between.length) continue;
    filled.push(miss);
    dbMs += between.reduce((n, s) => n + s.durationMicros / 1000, 0);
  }
  if (filled.length) {
    out.push(finding('miss-db', 'warn', 'Cache miss, then the database', `${filled.length} ${filled.length === 1 ? 'miss was' : 'misses were'} followed by the query that fills ${filled.length === 1 ? 'it' : 'them'}`,
      'The value was not in Redis, so the database was asked and the answer written back - every call that finds the key missing pays this.',
      'Warm the cache, give the key a longer TTL, or check why it is missing this often.', filled, `${filled.length} ${filled.length === 1 ? 'key' : 'keys'}`, dbMs,
      filled.map((c) => chip(c, 'ok'))));
  }

  // ---- a big value
  const big = ordered.filter((c) => (c.rw === 'w' && c.bytes >= BIG_WRITE_BYTES) || (c.rw === 'r' && c.replyBytes >= BIG_READ_BYTES));
  if (big.length) {
    const b = big[0];
    const bytes = b.rw === 'w' ? b.bytes : b.replyBytes;
    out.push(finding('big', 'warn', b.rw === 'w' ? 'Big value written' : 'Big value read', `${b.command} ${b.keys[0] ?? ''} - ${size(bytes)} in one command, ${fmtMs(b.micros / 1000)}`,
      'A value this size crosses the network every time it is read or written, and blocks Redis while it is copied.',
      'Store less (only what is read), compress it, or split it into smaller keys.', big, `${big.length} ${big.length === 1 ? 'command' : 'commands'}`, null,
      big.map((c) => chip(c, 'big', `${c.command} ${c.keys[0] ?? ''} · ${size(c.rw === 'w' ? c.bytes : c.replyBytes)}`))));
  }

  // ---- cache cold (the backend knows the earlier writes and their TTL)
  const coldCommands = ordered.filter((c) => cold.includes(c.seq));
  if (coldCommands.length) {
    const patterns = keyPatterns(coldCommands.flatMap((c) => c.keys));
    const names = [...new Set(coldCommands.map((c) => patterns.get(c.keys[0]) ?? c.keys[0]))];
    out.push(finding('cold', 'warn', 'Cache cold', `${names.join(', ')}: ${coldCommands.length} missed - written earlier by a recorded call, the TTL ran out`,
      'These keys were written by an earlier call with a TTL that had run out by the time this call read them.',
      'A longer TTL, or refreshing the keys before they expire, keeps them warm.', coldCommands,
      `${coldCommands.length} ${coldCommands.length === 1 ? 'key' : 'keys'}`, null, coldCommands.map((c) => chip(c, 'ok'))));
  }

  // ---- slow commands
  const slow = ordered.filter((c) => c.micros > slowMillis * 1000 && !c.command.startsWith('B')); // blocking reads wait on purpose
  if (slow.length) {
    out.push(finding('slow', 'warn', slow.length === 1 ? 'Slow Redis command' : `${slow.length} slow Redis commands`,
      `${slow[0].command} ${slow[0].keys[0] ?? ''} - ${fmtMs(slow[0].micros / 1000)} (over ${slowMillis} ms)`,
      'A Redis command normally answers in well under a millisecond on a local network; this one took far longer (big value, slow command, or a busy server).',
      'Look at the value size and the command; SLOWLOG on the server shows the same.', slow, `${slow.length} ${slow.length === 1 ? 'command' : 'commands'}`,
      slow.reduce((n, c) => n + c.micros / 1000, 0), slow.map((c) => chip(c, 'slow'))));
  }

  // ---- whole-database commands in the request path
  const dangerous = ordered.filter((c) => DANGEROUS.has(c.command));
  const scans = ordered.filter((c) => c.command === 'SCAN');
  if (dangerous.length || scans.length >= SCAN_LOOP) {
    const list = [...dangerous, ...(scans.length >= SCAN_LOOP ? scans : [])];
    out.push(finding('dangerous', 'bad', `${list[0].command} in the request path`, `${list.map((c) => c.command).filter((v, i, a) => a.indexOf(v) === i).join(', ')} ran during this call`,
      'KEYS and FLUSH* walk or wipe the whole database and block every other client while they run; a SCAN loop does the same in slices.',
      'Keep a set of the keys you need instead of searching for them, and never flush from a request.', list,
      `${list.length} ${list.length === 1 ? 'command' : 'commands'}`, null, list.map((c) => chip(c, 'err'))));
  } else {
    out.push(finding('safe', 'note', 'No KEYS / FLUSH* in the request path', 'checked: KEYS, FLUSHDB, FLUSHALL, SCAN loops over 1,000 keys',
      'None of the commands that walk or wipe the whole database ran during this call.', undefined, [], '', null, []));
  }
  return out;
}
