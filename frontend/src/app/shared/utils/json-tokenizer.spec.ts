import { filterLinesContaining, highlightTokens, tokenizeJson, tokenizeJsonText, tryParseJson } from './json-tokenizer';

describe('tokenizeJson', () => {
  it('classifies keys, strings, numbers, booleans, and null', () => {
    const tokens = tokenizeJson({ a: 'text', b: 1, c: true, d: null });
    const byClass = (cls: string) => tokens.filter((t) => t.cls === cls).map((t) => t.text);

    expect(byClass('k')).toEqual(['"a":', '"b":', '"c":', '"d":']);
    expect(byClass('s')).toEqual(['"text"']);
    expect(byClass('n')).toEqual(['1']);
    expect(byClass('b')).toEqual(['true']);
    expect(byClass('z')).toEqual(['null']);
  });

  it('reassembles to the original pretty-printed text', () => {
    const value = { nested: { list: [1, 2, 3] } };
    const tokens = tokenizeJsonText(JSON.stringify(value, null, 2));
    expect(tokens.map((t) => t.text).join('')).toBe(JSON.stringify(value, null, 2));
  });
});

describe('tryParseJson', () => {
  it('parses valid JSON', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects invalid JSON, empty strings, and non-strings without throwing', () => {
    expect(tryParseJson('not json')).toEqual({ ok: false });
    expect(tryParseJson('')).toEqual({ ok: false });
    expect(tryParseJson(undefined)).toEqual({ ok: false });
  });
});

describe('filterLinesContaining', () => {
  const text = 'line one\nline two\nsomething else\nline three';

  it('keeps only lines containing the query, case-insensitively', () => {
    const result = filterLinesContaining(text, 'LINE');
    expect(result.text).toBe('line one\nline two\nline three');
    expect(result.hiddenCount).toBe(1);
    expect(result.totalCount).toBe(4);
  });

  it('reports every line hidden when nothing matches', () => {
    const result = filterLinesContaining(text, 'zzz-no-match');
    expect(result.text).toBe('');
    expect(result.hiddenCount).toBe(4);
  });
});

describe('highlightTokens', () => {
  it('returns every token unhighlighted for an empty query', () => {
    const tokens = tokenizeJson({ a: 1 });
    const { tokens: result, matchCount } = highlightTokens(tokens, '');
    expect(matchCount).toBe(0);
    expect(result.every((t) => !t.highlighted)).toBe(true);
  });

  it('splits a token at every case-insensitive match and assigns sequential match indexes', () => {
    const { tokens, matchCount } = highlightTokens([{ text: 'aXaXa', cls: '' }], 'x');
    expect(matchCount).toBe(2);
    expect(tokens.map((t) => t.text)).toEqual(['a', 'X', 'a', 'X', 'a']);
    expect(tokens.filter((t) => t.highlighted).map((t) => t.matchIndex)).toEqual([0, 1]);
  });

  it('leaves non-matching tokens untouched', () => {
    const { tokens } = highlightTokens([{ text: 'no match here', cls: 'k' }], 'zzz');
    expect(tokens).toEqual([{ text: 'no match here', cls: 'k', highlighted: false }]);
  });
});
