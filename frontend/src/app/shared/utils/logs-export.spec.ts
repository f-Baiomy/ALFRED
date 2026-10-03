import { LogComment, LogLine } from '../../core/models/logs.model';
import { buildLogsExport, redactRaw } from './logs-export';
import { REDACTED } from './redact';

describe('logs-export', () => {
  const big = 'y'.repeat(2_000_000);
  const line = (id: string, raw: string): LogLine => ({
    lineId: id, inputId: 'i', byteOffset: 0, ts: 0, level: 'ERROR', groupLevel: 0, groupPath: '', missingLevel: null,
    pinned: false, unparsed: false, shape: 1, fields: {}, raw, rawUnavailable: null,
  });
  const comment: LogComment = { id: 'c', sourceId: 's', lineId: 'a', path: 'msg', text: '<b>look</b>', authorProfileId: null, createdAt: 't' };
  const opts = {
    sourceName: 'portal <detail>',
    formatTime: () => '00:00:00.000',
    comments: new Map([['a', [comment]]]),
    redactKeys: new Set<string>(),
    redactPaths: new Set<string>(),
  };

  it('exports every line in full, never truncated', () => {
    const raw = JSON.stringify({ msg: big });
    const nd = buildLogsExport([line('a', raw), line('b', '{"x":1}')], 'ndjson', opts);
    expect(nd.text).toBe(`${raw}\n{"x":1}\n`);
    expect(buildLogsExport([line('a', raw)], 'md', opts).text).toContain(big);
    expect(buildLogsExport([line('a', raw)], 'json', opts).text).toContain(big);
  });

  it('escapes everything in HTML', () => {
    const out = buildLogsExport([line('a', JSON.stringify({ msg: '<script>alert(1)</script>' }))], 'html', opts).text;
    expect(out).not.toContain('<script>alert');
    expect(out).toContain('&lt;b&gt;look&lt;/b&gt;');
    expect(out).toContain('portal &lt;detail&gt;');
  });

  it('applies redaction keys and sensitive paths before building', () => {
    const r = redactRaw(JSON.stringify({ a: { password: 'p', keep: 1 }, list: [{ email: 'e' }] }), new Set(['password']), new Set(['list.email']));
    expect(r.count).toBe(2);
    expect(r.text).toContain(REDACTED);
    expect(r.text).not.toContain('"p"');
    expect(redactRaw('not json', new Set(['x']), new Set()).text).toBe('not json');
    const md = buildLogsExport([line('a', '{"password":"p"}')], 'md', { ...opts, redactKeys: new Set(['password']) });
    expect(md.redacted).toBe(1);
    expect(md.text).toContain('1 values redacted');
  });
});
