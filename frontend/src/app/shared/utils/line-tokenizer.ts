import { HighlightToken } from './json-tokenizer';

/**
 * Splits a flat token stream (as produced by tokenizeJsonText/highlightTokens)
 * into per-line token arrays, so the Flat view can render one DOM row per
 * line - which is what lets each line carry its own comment gutter.
 *
 * Only the untyped "plain" gap tokens between JSON values can contain the
 * pretty-printer's structural newlines (a JSON string/number/bool/null
 * token never has one), but this splits on '\n' generically regardless of
 * token type so it stays correct even for an edge case like a search query
 * that happened to contain a literal newline.
 */
export function splitTokensIntoLines(tokens: readonly HighlightToken[]): HighlightToken[][] {
  const lines: HighlightToken[][] = [[]];

  for (const token of tokens) {
    const parts = token.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push([]);
      }
      if (part.length > 0) {
        lines[lines.length - 1].push({ ...token, text: part });
      }
    });
  }

  return lines;
}
