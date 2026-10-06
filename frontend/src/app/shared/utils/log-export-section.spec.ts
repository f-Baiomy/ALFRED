import { CallRecord } from '../../core/models/call.model';
import { LinkedLogLine } from '../../core/models/call-logs.model';
import { Redaction } from '../../core/models/redaction.model';
import { buildBulkExportPayload } from './bulk-json-builder';
import { parseImportedCalls } from './import-parser';
import { buildJsonExportV2 } from './json-export-v2';
import { logLinesSentence, logSectionHtml, logSectionMarkdown } from './log-export-section';
import { redactCalls } from './redact';

const FORM = { supplierName: 'odeysys', credentialsUsed: '', apiKey: '', url: '', environment: 'Staging' as const, description: '' };
/** Far longer than any table cell would ever show - it must come out whole. */
const LONG = 'x'.repeat(50_000) + ' END';

function line(id: string, offsetMs: number, extra: Partial<LinkedLogLine> = {}): LinkedLogLine {
  const message = extra.message ?? `msg ${id}`;
  return {
    sourceId: 's1', sourceName: 'wildfly', lineId: `in:${id}`, at: new Date(Date.parse('2026-10-05T01:00:00Z') + offsetMs).toISOString(), offsetMs,
    level: 'INFO', thread: 'default task-4', logger: 'a.B', message, matchedBy: 'THREAD_TIME',
    raw: JSON.stringify({ message, password: 'hunter2', 'process.thread.name': 'default task-4' }), ...extra,
  };
}

function inbound(lines: readonly LinkedLogLine[] | undefined): CallRecord {
  return {
    id: 'in-1', original_url: 'http://localhost:9001/search', url: 'http://h:8080/search', method: 'POST', timestamp: '2026-10-05T01:00:00.000Z',
    duration_ms: 2000, response: { status: 200, headers: {}, body: '{}' }, request: { headers: {}, body: '{}' }, state: 'COMPLETED',
    source: 'internal', service_name: 'odeysys', logLines: lines,
  };
}

const LINES = [line('a', 40, { level: 'WARN', message: 'pipe | and <b>tag</b> ```fence```' }), line('b', 900, { level: 'ERROR', message: LONG, matchedBy: 'EXACT' })];

describe('log lines in exports', () => {
  it('.md: a table row per line and each whole raw line, never cut, fenced safely', () => {
    const md = logSectionMarkdown(inbound(LINES), 3).join('\n');
    expect(md).toContain('### 📜 Logs');
    expect(md).toContain('2 log lines from wildfly, 1 matched by the call id, 1 by request thread and time');
    expect(md).toContain('| +40 ms | WARN | default task-4 | pipe \\| and');
    expect(md).toContain(LONG);
    expect(md).toContain('````json'); // the raw line holds ``` - the fence is longer
    expect(logSectionMarkdown(inbound(undefined), 3)).toEqual([]);
  });

  it('.html: escaped, every line whole, counts on the block', () => {
    const html = logSectionHtml(inbound(LINES));
    expect(html).toContain('📜 Logs');
    expect(html).toContain('<b>1</b> errors');
    expect(html).toContain('&lt;b&gt;tag&lt;/b&gt;');
    expect(html).not.toContain('<b>tag</b>');
    expect(html).toContain(LONG);
  });

  it('.md/.html: caught lines say so and keep their exception whole (specs/009)', () => {
    const stack = 'java.lang.IllegalStateException: bad\n' + '\tat a.B.c(B.java:1)\n'.repeat(400);
    const caught = line('c', 5, { matchedBy: 'CAUGHT', sourceName: 'caught by the agent', logger: 'com.app.Search',
      raw: JSON.stringify({ message: 'boom', exception: { type: 'java.lang.IllegalStateException', stack } }) });
    const md = logSectionMarkdown(inbound([caught]), 3).join('\n');
    expect(md).toContain('caught by the agent inside the application');
    expect(md).toContain(JSON.stringify(stack).slice(1, -1));
    expect(logSectionHtml(inbound([caught]))).toContain('com.app.Search · caught');
  });

  it('says so in About This Document', () => {
    expect(logLinesSentence([inbound(LINES)])).toContain('2 in all');
    expect(logLinesSentence([inbound(undefined)])).toBe('');
  });

  it('.json v3: a logLines section and index counts; import gives back every line exactly', () => {
    const calls = [inbound(LINES)];
    const lines = buildJsonExportV2({ calls, form: FORM, commentsByCallId: new Map(), exportedAt: '2026-10-05T02:00:00Z' });
    const file = JSON.parse(lines.join('\n'));
    expect(file.logLines.length).toBe(2);
    expect(file.logLines[0].of).toBe('in-1');
    expect(file.index[0].logs).toEqual(jasmine.objectContaining({ count: 2, errors: 1, warnings: 1, matchedBy: 'THREAD_TIME' }));
    expect(file.layout.logLines.count).toBe(2);
    // the index's line numbers point at the records
    const [first] = file.index[0].logs.lines;
    expect(JSON.parse(lines[first - 1].replace(/,$/, '')).lineId).toBe('in:a');

    const back = parseImportedCalls(file).calls.find((c) => c.id === 'in-1')!;
    expect(back.logLines).toEqual(LINES);
    // and without log lines the file still imports exactly like version 1 (the yardstick)
    const v1 = parseImportedCalls(JSON.parse(JSON.stringify(buildBulkExportPayload([inbound(undefined)], FORM, new Map(), '2026-10-05T02:00:00Z', [], 'all', 0))));
    const v3 = parseImportedCalls(JSON.parse(buildJsonExportV2({ calls: [inbound(undefined)], form: FORM, commentsByCallId: new Map(), exportedAt: '2026-10-05T02:00:00Z' }).join('\n')));
    expect(v3.calls).toEqual(v1.calls);
  });

  it('masks log lines like bodies', () => {
    const rule = { id: 'r', kind: 'response-body-key', name: 'password', scope: 'all', callId: null } as unknown as Redaction;
    const { calls, redactedValueCount } = redactCalls([inbound(LINES)], [rule]);
    expect(redactedValueCount).toBe(2);
    expect(calls[0].logLines!.every((l) => !l.raw.includes('hunter2'))).toBeTrue();
  });
});
