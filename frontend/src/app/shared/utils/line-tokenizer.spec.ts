import { highlightTokens, tokenizeJson } from './json-tokenizer';
import { splitTokensIntoLines } from './line-tokenizer';

function lineTexts(lines: ReturnType<typeof splitTokensIntoLines>): string[] {
  return lines.map((line) => line.map((t) => t.text).join(''));
}

describe('splitTokensIntoLines', () => {
  it('reassembles to the same lines as the original pretty-printed text', () => {
    const value = { a: 1, nested: { b: 'text', list: [1, 2] } };
    const originalLines = JSON.stringify(value, null, 2).split('\n');
    const tokens = highlightTokens(tokenizeJson(value), '').tokens;

    expect(lineTexts(splitTokensIntoLines(tokens))).toEqual(originalLines);
  });

  it('keeps a token entirely on one line when it has no newline', () => {
    const lines = splitTokensIntoLines([{ text: '"key": "value"', cls: 's', highlighted: false }]);
    expect(lines).toEqual([[{ text: '"key": "value"', cls: 's', highlighted: false }]]);
  });

  it('splits a single token that spans a newline into two lines, preserving cls on both pieces', () => {
    const lines = splitTokensIntoLines([{ text: ',\n  ', cls: '', highlighted: false }]);
    expect(lines).toEqual([
      [{ text: ',', cls: '', highlighted: false }],
      [{ text: '  ', cls: '', highlighted: false }],
    ]);
  });

  it('does not emit an empty token for a line break with nothing before/after it', () => {
    const lines = splitTokensIntoLines([
      { text: 'a', cls: '', highlighted: false },
      { text: '\n', cls: '', highlighted: false },
      { text: 'b', cls: '', highlighted: false },
    ]);
    expect(lines).toEqual([
      [{ text: 'a', cls: '', highlighted: false }],
      [{ text: 'b', cls: '', highlighted: false }],
    ]);
  });

  it('preserves highlight metadata on split pieces', () => {
    const lines = splitTokensIntoLines([{ text: 'x\ny', cls: 'k', highlighted: true, matchIndex: 2 }]);
    expect(lines).toEqual([
      [{ text: 'x', cls: 'k', highlighted: true, matchIndex: 2 }],
      [{ text: 'y', cls: 'k', highlighted: true, matchIndex: 2 }],
    ]);
  });
});
