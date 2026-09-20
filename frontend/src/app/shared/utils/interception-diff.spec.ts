import {
  MAX_COLOURED_LINES,
  buildHttpDiff,
  copyableView,
  diffHeaders,
  diffLines,
  searchView,
  sharedBodyKind,
} from './interception-diff';

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

    it('pretty-prints XML too, not only JSON', () => {
      // This used to reformat JSON and nothing else, so one changed value inside a SOAP envelope
      // was two vast, visually identical lines and you diffed it by eye.
      const lines = diffLines('<a><b>one</b></a>', '<a><b>two</b></a>');

      expect(lines.filter((l) => l.kind === 'removed').map((l) => l.text.trim())).toEqual(['<b>one</b>']);
      expect(lines.filter((l) => l.kind === 'added').map((l) => l.text.trim())).toEqual(['<b>two</b>']);
      // Re-indented, which is what turns one enormous line into one changed line.
      expect(lines.some((l) => l.text.startsWith('  '))).toBeTrue();
    });

    it('diffs text that is neither exactly as it stands', () => {
      const lines = diffLines('grant_type=a\nscope=read', 'grant_type=b\nscope=read');

      expect(lines.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['grant_type=a']);
      expect(lines.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['grant_type=b']);
      expect(lines.every((l) => l.tokens === null)).toBeTrue();
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

  describe('colouring it', () => {
    it('carries the same tokens the call cards render, per line', () => {
      const lines = diffLines('{"a":1}', '{"a":2}');
      const changed = lines.find((l) => l.kind === 'added');

      // Not a lookalike: these are the tokens tokenizeJsonText produces, so `.k`/`.s`/`.n`
      // resolve to the theme's own --tok-* exactly as they do on the card above this panel.
      expect(changed?.tokens?.some((t) => t.cls === 'k' && t.text.includes('a'))).toBeTrue();
      expect(changed?.tokens?.some((t) => t.cls === 'n' && t.text === '2')).toBeTrue();
    });

    it('colours XML with the XML tokenizer, not the JSON one', () => {
      const lines = diffLines('<Total currency="AED">1420.00</Total>', '<Total currency="AED">1.00</Total>');

      expect(lines.every((l) => l.tokens !== null)).toBeTrue();
      expect(lines.flatMap((l) => l.tokens ?? []).some((t) => t.cls !== '')).toBeTrue();
    });

    it('never colours a body that is not structured', () => {
      // Colouring a form-encoded body as JSON would be inventing structure that is not there.
      expect(diffLines('a=1', 'a=2').every((l) => l.tokens === null)).toBeTrue();
    });

    it('every line of a coloured side reassembles to exactly its own text', () => {
      // The one that matters. Tokens are attached to lines BY INDEX from a separate split, so a
      // tokenizer that swallowed or added a newline would paint each line with its neighbour's
      // colours - wrong, and silently so, on the one screen whose job is to show what changed.
      const before = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: 'x' } });
      const after = JSON.stringify({ a: 9, b: [1, 2, 3], c: { d: 'y' } });

      for (const line of diffLines(before, after)) {
        if (line.tokens) {
          expect(line.tokens.map((t) => t.text).join('')).toBe(line.text);
        }
      }
    });

    it('drops colour past the size it would cost more than it is worth', () => {
      // One DOM node per token instead of one per line; the call view measured a four-second
      // freeze on a body this shape, which is why it windows. Here the trade is monochrome.
      const huge = JSON.stringify(Object.fromEntries(Array.from({ length: MAX_COLOURED_LINES + 10 }, (_, i) => [`k${i}`, i])));

      const lines = diffLines(huge, huge.replace('"k0":0', '"k0":1'));

      expect(lines.length).toBeGreaterThan(MAX_COLOURED_LINES);
      expect(lines.every((l) => l.tokens === null)).toBeTrue();
      // Still pretty-printed, which is the part that costs nothing.
      expect(lines.some((l) => l.text.startsWith('  '))).toBeTrue();
    });

    it('formats both sides by ONE kind so the format itself cannot invent a difference', () => {
      // A 502 HTML page replacing a JSON body: if each side chose its own formatter the diff
      // would also report every line of the JSON as reformatted. The structured side decides.
      expect(sharedBodyKind('{"a":1}', '<html><body>502 Bad Gateway<br>nginx</body></html>')).toBe('json');
      expect(sharedBodyKind(null, '{"a":1}')).toBe('json');
      expect(sharedBodyKind('a=1', 'b=2')).toBe('text');
      // When both are structured the AFTER side wins - a mocked response is the one being read.
      expect(sharedBodyKind('{"a":1}', '<a><b/></a>')).toBe('xml');
    });
  });

  describe('searchView', () => {
    const headers = () => diffHeaders({ 'x-supplier': 'amadeus' }, { 'x-supplier': 'sabre' });
    const body = () => diffLines('{"supplier":"amadeus"}', '{"supplier":"sabre"}');

    it('numbers matches in reading order across headers and then body', () => {
      // A diff interleaves lines from two separately-tokenized sides, each of which would start
      // its own count at zero - so "3 of 7" would point at two different places.
      const result = searchView(headers(), body(), 'supplier');

      const indices = [
        ...result.headers.flatMap((r) => [...r.nameTokens, ...r.valueTokens]),
        ...result.body.flatMap((l) => l.highlighted),
      ]
        .filter((t) => t.highlighted)
        .map((t) => t.matchIndex);

      expect(indices).toEqual([...indices].sort((a, b) => (a ?? 0) - (b ?? 0)));
      expect(new Set(indices).size).toBe(indices.length);
      expect(result.matchCount).toBe(indices.length);
    });

    it('searches the headers too, not only the body', () => {
      const result = searchView(headers(), [], 'supplier');

      expect(result.matchCount).toBeGreaterThan(0);
    });

    it('is case-insensitive but keeps the original casing on screen', () => {
      const result = searchView([], diffLines('{"Supplier":1}', '{"Supplier":2}'), 'supplier');

      expect(result.matchCount).toBeGreaterThan(0);
      const marked = result.body.flatMap((l) => l.highlighted).filter((t) => t.highlighted);
      expect(marked.every((t) => t.text === 'Supplier')).toBeTrue();
    });

    it('marks nothing for an empty query rather than everything', () => {
      expect(searchView(headers(), body(), '').matchCount).toBe(0);
    });

    it('leaves a searched line reassembling to its own text', () => {
      for (const line of searchView([], body(), 'supplier').body) {
        expect(line.highlighted.map((t) => t.text).join('')).toBe(line.text);
      }
    });

    it('gives an uncoloured line highlight tokens anyway, so plain text is still searchable', () => {
      const result = searchView([], diffLines('grant_type=a', 'grant_type=b'), 'grant');

      expect(result.matchCount).toBe(2);
      expect(result.body[0].highlighted.some((t) => t.highlighted)).toBeTrue();
    });
  });

  describe('copyableView', () => {
    it('copies the status change as well as the body, because that is usually the point', () => {
      const text = copyableView({
        statusChange: '200 OK -> 500 Internal Server Error',
        headers: diffHeaders({ a: '1' }, { a: '2' }),
        body: diffLines('{"x":1}', '{"x":2}'),
        showMarkers: true,
      });

      expect(text).toContain('Status  200 OK -> 500');
      expect(text).toContain('- a: 1');
      expect(text).toContain('+ a: 2');
      expect(text).toContain('"x": 1');
    });

    it('copies a single side clean, with no markers, so it can be replayed as-is', () => {
      const body = diffLines('{"x":1}', '{"x":1}');

      const text = copyableView({ headers: [], body, showMarkers: false });

      expect(text).not.toMatch(/^[-+] /m);
      expect(text).toContain('Body');
    });

    it('says nothing about a section that is not there', () => {
      expect(copyableView({ headers: [], body: [], showMarkers: true })).toBe('');
    });
  });
});
