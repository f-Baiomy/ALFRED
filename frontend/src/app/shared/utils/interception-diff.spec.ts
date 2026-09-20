import {
  buildHttpDiff,
  copyableView,
  diffHeaders,
  diffLines,
  highlightLine,
  lineOfMatch,
  searchBody,
  searchHeaders,
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

    it('trims the matching ends first, so one real edit in a huge body stays a real diff', () => {
      // Found live: editing ONE field in a 7,368-line intercepted response rendered the WHOLE
      // body as removed-then-added. The untrimmed body was past MAX_DIFF_LINES, and the bound's
      // fallback marks everything changed rather than nothing - correct in the sense of never
      // lying, useless in the sense of being asked to find what changed. A real edit changes a
      // handful of lines inside a body that is otherwise identical top and bottom; this is that
      // shape, just past the size the OLD bound tolerated.
      const before = Array.from({ length: 3500 }, (_, i) => `line ${i}`).join('\n');
      const after = before.replace('line 1750', 'line CHANGED');

      const lines = diffLines(before, after);

      expect(lines.filter((l) => l.kind === 'same').length).toBe(3499);
      expect(lines.filter((l) => l.kind === 'removed').map((l) => l.text)).toEqual(['line 1750']);
      expect(lines.filter((l) => l.kind === 'added').map((l) => l.text)).toEqual(['line CHANGED']);
    });

    it('still falls back honestly when the CHANGED part itself is too large to diff', () => {
      // The bound still exists - trimming the matching ends cannot help when most of the body
      // really did change, and showing it all as different is the honest answer there, not a
      // compromise.
      const big = Array.from({ length: 3500 }, (_, i) => `line ${i}`).join('\n');
      const shuffled = Array.from({ length: 3500 }, (_, i) => `line ${3499 - i}`).join('\n');

      const lines = diffLines(big, shuffled);

      expect(lines.some((l) => l.kind === 'same')).toBeFalse();
      expect(lines.filter((l) => l.kind === 'removed').length).toBe(3500);
      expect(lines.filter((l) => l.kind === 'added').length).toBe(3500);
    });

    it('trims a common prefix and a common suffix at once, around a single-line edit', () => {
      const lines = diffLines('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');

      expect(lines.map((l) => [l.kind, l.text])).toEqual([
        ['same', 'a'],
        ['same', 'b'],
        ['removed', 'c'],
        ['added', 'X'],
        ['same', 'd'],
        ['same', 'e'],
      ]);
    });

    it('trims correctly when the two sides are different lengths', () => {
      // A value growing or shrinking enough to add or remove a pretty-printed line - the suffix
      // trim has to walk from each side's OWN end, not assume they line up.
      const lines = diffLines('a\nb\nc\nd', 'a\nb\nX\nY\nc\nd');

      expect(lines.map((l) => [l.kind, l.text])).toEqual([
        ['same', 'a'],
        ['same', 'b'],
        ['added', 'X'],
        ['added', 'Y'],
        ['same', 'c'],
        ['same', 'd'],
      ]);
    });

    it('reports two entirely different bodies as entirely different, not as one giant "same"', () => {
      // A degenerate case for prefix/suffix trimming: nothing at the start or end matches at
      // all, so the whole thing has to go through the real diff untouched.
      const lines = diffLines('one\ntwo\nthree', 'uno\ndos\ntres');

      expect(lines.every((l) => l.kind !== 'same')).toBeTrue();
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

    it('colours a large body too, now that the panel windows instead of building it', () => {
      // There was a cap here, dropping colour past 4,000 lines because colour costs one DOM node
      // per token. Windowing removed the thing that cap was protecting: the number of rows BUILT
      // no longer depends on the size of the body.
      const huge = JSON.stringify(Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['k' + i, i])));

      const lines = diffLines(huge, huge.replace('"k0":0', '"k0":1'));

      expect(lines.length).toBeGreaterThan(5000);
      expect(lines.every((l) => l.tokens !== null)).toBeTrue();
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

  describe('searching a body without building it', () => {
    /**
     * The split that lets the panel window. Counting runs over every line, because the total has
     * to be truthful - "3 of 412" cannot only know about the rows on screen. Building the tokens
     * is the expensive half and happens per visible row.
     */
    const headers = () => diffHeaders({ 'x-supplier': 'amadeus' }, { 'x-supplier': 'sabre' });
    const body = () => diffLines('{"supplier":"amadeus"}', '{"supplier":"sabre"}');

    it('counts every match in the body without producing a single token', () => {
      const search = searchBody(body(), 'supplier');

      expect(search.count).toBe(2);
      expect(search.perLine.reduce((a, b) => a + b, 0)).toBe(2);
    });

    it('numbers continuously from the headers into the body', () => {
      // A count that restarted at the body would make "3 of 7" ambiguous about which 3.
      const marked = searchHeaders(headers(), 'supplier');
      const search = searchBody(body(), 'supplier', marked.count);

      const headerIndices = marked.rows
        .flatMap((r) => [...r.nameTokens, ...r.valueTokens])
        .filter((t) => t.highlighted)
        .map((t) => t.matchIndex ?? -1);
      expect(headerIndices).toEqual([0, 1]);
      expect(search.firstIndex[search.perLine.findIndex((n) => n > 0)]).toBe(marked.count);
      expect(marked.count + search.count).toBe(4);
    });

    it('highlights one line on its own with the numbering the whole panel uses', () => {
      const lines = body();
      const search = searchBody(lines, 'supplier', 5);
      const changed = lines.findIndex((l) => l.kind === 'removed');

      const line = highlightLine(lines[changed], 'supplier', search.firstIndex[changed]);

      expect(line.highlighted.filter((t) => t.highlighted).map((t) => t.matchIndex)).toEqual([5]);
    });

    it('keeps a highlighted line reassembling to exactly its own text', () => {
      const lines = body();
      const search = searchBody(lines, 'supplier');

      lines.forEach((line, i) => {
        const marked = highlightLine(line, 'supplier', search.firstIndex[i]);
        expect(marked.highlighted.map((t) => t.text).join('')).toBe(line.text);
      });
    });

    it('is case-insensitive but keeps the original casing on screen', () => {
      const lines = diffLines('{"Supplier":1}', '{"Supplier":2}');
      const search = searchBody(lines, 'supplier');

      expect(search.count).toBe(2);
      const marked = lines.flatMap((l, i) => highlightLine(l, 'supplier', search.firstIndex[i]).highlighted);
      expect(marked.filter((t) => t.highlighted).every((t) => t.text === 'Supplier')).toBeTrue();
    });

    it('finds nothing for an empty query rather than everything', () => {
      expect(searchBody(body(), '').count).toBe(0);
      expect(searchHeaders(headers(), '').count).toBe(0);
    });

    it('highlights an uncoloured line too, so plain text is still searchable', () => {
      const lines = diffLines('grant_type=a', 'grant_type=b');
      const search = searchBody(lines, 'grant');

      expect(search.count).toBe(2);
      expect(highlightLine(lines[0], 'grant', 0).highlighted.some((t) => t.highlighted)).toBeTrue();
    });

    describe('lineOfMatch', () => {
      /** Twelve lines, a match on every third one. */
      const spread = () => {
        const before = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? `hit ${i}` : `miss ${i}`)).join('\n');
        return diffLines(before, before);
      };

      it('finds the line a global match number falls on', () => {
        // The panel cannot find its current match by querying the DOM for a <mark>: once it
        // windows, that row may never have been built.
        const lines = spread();
        const search = searchBody(lines, 'hit');

        expect(search.count).toBe(4);
        expect(lineOfMatch(search, 0)).toBe(0);
        expect(lineOfMatch(search, 1)).toBe(3);
        expect(lineOfMatch(search, 3)).toBe(9);
      });

      it('reports no line for a match number that is not in the body', () => {
        const search = searchBody(spread(), 'hit');

        expect(lineOfMatch(search, 99)).toBe(-1);
        expect(lineOfMatch(searchBody([], 'x'), 0)).toBe(-1);
      });

      it('skips past the headers when the body numbering is offset', () => {
        const lines = spread();
        const search = searchBody(lines, 'hit', 10);

        expect(lineOfMatch(search, 9)).toBe(-1);
        expect(lineOfMatch(search, 10)).toBe(0);
        expect(lineOfMatch(search, 11)).toBe(3);
      });
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
