import { buildHttpDiff, diffHeaders, diffLines } from './interception-diff';

describe('interception diff', () => {
  describe('diffLines', () => {
    it('pretty-prints JSON so a one-field change is one changed line', () => {
      // Both sides arrive as single-line JSON from the wire. Diffed raw, every change would be
      // "the whole body changed", which tells you nothing.
      const lines = diffLines('{"a":1,"b":2}', '{"a":1,"b":3}');

      expect(lines.filter((l) => l.kind === 'removed').map((l) => l.text.trim())).toEqual(['"b": 2']);
      expect(lines.filter((l) => l.kind === 'added').map((l) => l.text.trim())).toEqual(['"b": 3']);
      expect(lines.filter((l) => l.kind === 'same').length).toBeGreaterThan(0);
    });

    it('leaves a non-JSON body alone and diffs it by line', () => {
      const lines = diffLines('<a>\n<b>one</b>\n</a>', '<a>\n<b>two</b>\n</a>');

      expect(lines.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['<b>one</b>']);
      expect(lines.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['<b>two</b>']);
    });

    it('diffs a body that merely looks like JSON as raw text rather than throwing', () => {
      const lines = diffLines('{not json', '{not json either');

      expect(lines.length).toBe(2);
      expect(lines[0].kind).toBe('removed');
      expect(lines[1].kind).toBe('added');
    });

    it('reports an unchanged body as entirely unchanged', () => {
      expect(diffLines('{"a":1}', '{"a":1}').every((l) => l.kind === 'same')).toBeTrue();
    });

    it('treats an added or removed body as wholly added or removed', () => {
      expect(diffLines(null, 'hello').every((l) => l.kind === 'added')).toBeTrue();
      expect(diffLines('hello', null).every((l) => l.kind === 'removed')).toBeTrue();
      expect(diffLines(null, null)).toEqual([]);
    });

    it('stays correct rather than minimal on a body too large to diff properly', () => {
      // The LCS table is O(n*m) and this runs on the main thread. Past the bound the answer is
      // still truthful - everything changed - which beats locking the tab for a nicer diff.
      const big = Array.from({ length: 3500 }, (_, i) => `line ${i}`).join('\n');
      const lines = diffLines(big, big + '\nextra');

      expect(lines.some((l) => l.kind === 'same')).toBeFalse();
      expect(lines.filter((l) => l.kind === 'removed').length).toBe(3500);
    });
  });

  describe('diffHeaders', () => {
    it('marks added, removed and unchanged headers', () => {
      const rows = diffHeaders({ a: '1', gone: 'x' }, { a: '1', fresh: 'y' });

      expect(rows.find((r) => r.name === 'gone')?.kind).toBe('removed');
      expect(rows.find((r) => r.name === 'fresh')?.kind).toBe('added');
      expect(rows.find((r) => r.name === 'a')?.kind).toBe('same');
    });

    it('shows a changed header as its old value then its new one', () => {
      const rows = diffHeaders({ 'x-test': 'old' }, { 'x-test': 'new' });

      expect(rows.map((r) => [r.kind, r.value])).toEqual([
        ['removed', 'old'],
        ['added', 'new'],
      ]);
    });

    it('compares names case-insensitively, as HTTP does', () => {
      // A rule that sets `X-Alfred` over an existing `x-alfred` REPLACED it. Reporting one
      // removed plus one added would misdescribe what happened.
      const rows = diffHeaders({ 'x-alfred': 'on' }, { 'X-Alfred': 'on' });

      expect(rows.length).toBe(1);
      expect(rows[0].kind).toBe('same');
    });

    it('puts changed headers first so the one that matters is not buried', () => {
      const before: Record<string, string> = { changed: 'a' };
      for (let i = 0; i < 20; i++) before[`h${i}`] = 'same';
      const after = { ...before, changed: 'b' };

      const rows = diffHeaders(before, after);

      expect(rows[0].kind).not.toBe('same');
      expect(rows[1].kind).not.toBe('same');
    });
  });

  describe('buildHttpDiff', () => {
    it('is null when nothing was captured, which is not the same as nothing changed', () => {
      expect(buildHttpDiff(null, { body: 'x' })).toBeNull();
    });

    it('reports a status change with its reason phrase', () => {
      const diff = buildHttpDiff(
        { status: 200, reason: 'OK', body: '{}' },
        { status: 500, reason: 'Internal Server Error', body: '{}' }
      );

      expect(diff?.statusChange).toBe('200 OK → 500 Internal Server Error');
    });

    it('reports no status change when only the body moved', () => {
      const diff = buildHttpDiff({ status: 200, reason: 'OK', body: '{"a":1}' }, { status: 200, reason: 'OK', body: '{"a":2}' });

      expect(diff?.statusChange).toBeNull();
      expect(diff?.bodyChanged).toBeTrue();
    });

    it('surfaces a url change, which is the only visible effect of a query rewrite', () => {
      const diff = buildHttpDiff(
        { method: 'POST', url: 'https://x/search', headers: {}, body: '' },
        { url: 'https://x/search?passengers=5', headers: {}, body: '' }
      );

      expect(diff?.urlChange).toEqual({ from: 'https://x/search', to: 'https://x/search?passengers=5' });
      expect(diff?.bodyChanged).toBeFalse();
      expect(diff?.headersChanged).toBeFalse();
    });

    it('flags header and body changes independently', () => {
      const diff = buildHttpDiff(
        { headers: { a: '1' }, body: '{"x":1}' },
        { headers: { a: '1', b: '2' }, body: '{"x":1}' }
      );

      expect(diff?.headersChanged).toBeTrue();
      expect(diff?.bodyChanged).toBeFalse();
    });
  });
});
