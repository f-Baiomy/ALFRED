import { CallRecord } from '../../core/models/call.model';
import { CallDbCapture } from '../../core/models/db-capture.model';
import { ExportedStoreCommand } from '../../core/models/store-command.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { parseImportedCalls } from './import-parser';
import { buildJsonExportV2, utf8Length } from './json-export-v2';
import { storeCommandsSentence, storeHeadline, storeSectionHtml, storeSectionMarkdown } from './store-export-section';

/**
 * The Redis part of the exports (specs/011-redis-capture, contracts/export-and-mcp.md): .md/.html carry every command
 * whole, .json carries one `redis` record per command and reads it back exactly - the same as version 1 does.
 */
const FORM = { supplierName: '', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging' as const, description: '' };
const BIG = 'v'.repeat(2 * 1024 * 1024); // a 2 MB value: never shortened

function cmd(seq: number, over: Partial<ExportedStoreCommand> = {}): ExportedStoreCommand {
  return {
    store: 'redis', seq, at: `2026-10-05T01:00:00.${String(seq).padStart(3, '0')}Z`, micros: 1200, command: 'GET', keys: [`fare:rule:${seq}`],
    keysTotal: 1, rw: 'r', outcome: 'HIT', replyType: 'BULK', resp: 2, args: btoa(`GET fare:rule:${seq}`), reply: btoa('{"a":1}'),
    argsBytes: 17, replyBytes: 7, beforeBytes: 0, masked: false, client: 'lettuce 6.8.2', connection: 'conn-1', server: 'redis:6379', db: 0,
    thread: 'task-1', code: 'FareService.rule(FareService.java:88)', callers: ['FareService.rule(FareService.java:88)'],
    argsText: [`fare:rule:${seq}`], replyFormat: 'json', replyText: '{"a":1}', ...over,
  };
}

function redisCommands(): ExportedStoreCommand[] {
  return [
    cmd(2),
    cmd(3, { outcome: 'MISS', replyText: '(nil)', reply: null, replyBytes: 0, origin: { cache: 'fareRules', operation: '@Cacheable', method: 'FareService.rule' } }),
    cmd(5, { command: 'MULTI', keys: [], argsText: [], group: { kind: 'tx', id: 'g1', index: 0, size: 3 }, replyText: 'OK' }),
    cmd(6, { command: 'SET', rw: 'w', outcome: 'OK', group: { kind: 'tx', id: 'g1', index: 1, size: 3 }, valueFormat: 'text', valueText: BIG, argsText: ['fare:rule:6', '<x> & "y"'] }),
    cmd(7, { command: 'EXEC', keys: [], argsText: [], group: { kind: 'tx', id: 'g1', index: 2, size: 3 }, replyText: '[OK]' }),
    cmd(8, { command: 'HGET', outcome: 'FAILED', error: 'WRONGTYPE Operation against a key holding the wrong kind of value', reply: null, replyText: null }),
    cmd(9, { keys: ['session:abc'], masked: true, args: null, reply: null, replyText: null, replyBytes: 1412 }),
  ];
}

function capture(): CallDbCapture {
  return {
    summary: { callId: 'in-1', statements: 0, failed: 0, totalMicros: 0, flags: [] },
    statements: [], supplierMarkers: [], transactions: [],
    redis: redisCommands(),
    redisSummary: { callId: 'in-1', project: 'odeysys', commands: 7, reads: 5, writes: 1, hits: 2, misses: 1, failed: 1, micros: 8400, dropped: 0, live: false, endedEarly: false },
  } as unknown as CallDbCapture;
}

function call(): CallRecord {
  return {
    id: 'in-1', original_url: 'http://localhost:9001/fare', url: 'http://host.docker.internal:8080/fare', method: 'GET', request: { headers: {} },
    timestamp: '2026-10-05T01:00:00.000Z', duration_ms: 90, response: { status: 200, headers: {}, body: '{}' }, state: 'COMPLETED',
    source: 'internal', service_name: 'odeysys', dbCapture: capture(),
  };
}

describe('Redis in the exports', () => {
  it('.md: a headline, every command in order with groups as headings, every value whole', () => {
    const md = storeSectionMarkdown(call(), 3).join('\n');
    expect(md).toContain('### ⬢ Redis');
    expect(md).toContain(storeHeadline(redisCommands()));
    expect(md).toContain('**MULTI … EXEC - 3 commands**');
    expect(md).toContain('WRONGTYPE Operation against a key holding the wrong kind of value');
    expect(md).toContain('Spring Cache fareRules');
    expect(md).toContain('‹masked · 1,412 B›');
    expect(md).toContain(BIG); // never truncated
    expect(md.indexOf('fare:rule:2')).toBeLessThan(md.indexOf('fare:rule:3'));
  });

  it('.html: escaped, whole, groups and failures marked', () => {
    const html = storeSectionHtml(call());
    expect(html).toContain('⬢ Redis');
    expect(html).toContain('&lt;x&gt; &amp; &quot;y&quot;');
    expect(html).not.toContain('<x>');
    expect(html).toContain('class="rdc x"');
    expect(html).toContain('<details class="rdg" open><summary>MULTI … EXEC - 3 commands</summary>');
    expect(html).toContain(BIG);
  });

  it('says nothing for a call without Redis commands, and one sentence in "About This Document" when there are', () => {
    const plain = { ...call(), dbCapture: undefined };
    expect(storeSectionMarkdown(plain, 3)).toEqual([]);
    expect(storeSectionHtml(plain)).toBe('');
    expect(storeCommandsSentence([plain])).toBe('');
    expect(storeCommandsSentence([call()])).toContain('Redis commands the application sent while handling it (7 in all)');
  });

  it('.json: one `redis` record per command, indexed by line and byte offset, imported exactly as version 1 imports it', () => {
    const lines = buildJsonExportV2({ calls: [call()], form: FORM, commentsByCallId: new Map(), exportedAt: '2026-10-05T02:00:00Z' });
    const text = lines.join('\n');
    const file = JSON.parse(text);
    expect(file.redis.length).toBe(7);
    expect(file.redis[0].of).toBe('in-1');
    expect(file.dbCalls[0].redis).toBeUndefined(); // in its own section, not twice
    const entry = file.index[0].redis;
    expect([entry.count, entry.failed, entry.misses]).toEqual([7, 1, 1]);
    const bytes = new TextEncoder().encode(text);
    const slice = new TextDecoder().decode(bytes.subarray(entry.offset, entry.offset + entry.bytes)).split('\n');
    expect(slice.length).toBe(7);
    expect(JSON.parse(slice[0].replace(/,$/, '')).seq).toBe(2);
    expect(utf8Length(text)).toBe(bytes.length);

    const v2 = parseImportedCalls(file);
    const v1 = parseImportedCalls(JSON.parse(JSON.stringify(buildBulkExportPayload([call()], FORM, new Map(), '2026-10-05T02:00:00Z'))));
    expect(v2.calls[0].dbCapture?.redis).toEqual(redisCommands());
    expect(v2.calls[0].dbCapture?.redis).toEqual(v1.calls[0].dbCapture?.redis);
    expect(v2.calls[0].dbCapture?.redisSummary).toEqual(capture().redisSummary);
  });
});
