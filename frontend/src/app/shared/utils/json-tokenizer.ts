/**
 * Tokenizes pretty-printed JSON text into typed pieces for template
 * interpolation, rather than building an HTML string. Angular then renders
 * each token as plain text inside a classed <span> - there is no innerHTML
 * anywhere in this pipeline, so there is nothing for an XSS payload embedded
 * in a supplier's response body to attach to.
 */
export interface JsonToken {
  readonly text: string;
  readonly cls: 'k' | 's' | 'n' | 'b' | 'z' | '';
}

export interface HighlightToken extends JsonToken {
  readonly highlighted: boolean;
  readonly matchIndex?: number;
}

const TOKEN_REGEX =
  /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g;

function classify(match: string): JsonToken['cls'] {
  if (match.startsWith('"')) {
    return match.endsWith(':') ? 'k' : 's';
  }
  if (match === 'true' || match === 'false') return 'b';
  if (match === 'null') return 'z';
  return 'n';
}

/** Tokenizes an arbitrary pretty-printed-JSON-shaped string (see filterLinesContaining below, which produces text that is no longer strictly parseable JSON but still has the same token shapes). */
export function tokenizeJsonText(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), cls: '' });
    }
    tokens.push({ text: match[0], cls: classify(match[0]) });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), cls: '' });
  }
  return tokens;
}

export function prettyJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function tokenizeJson(value: unknown): JsonToken[] {
  return tokenizeJsonText(prettyJsonText(value));
}

/**
 * Keeps only the lines whose visible text contains `query` (case-insensitive).
 * Safe to call on pretty-printed JSON text: the pretty-printer's only
 * newlines are structural (indentation) - a JSON string value never contains
 * a raw newline, only the escaped "\n" - so this never splits mid-token.
 */
export function filterLinesContaining(text: string, query: string): { text: string; hiddenCount: number; totalCount: number } {
  const q = query.toLowerCase();
  const lines = text.split('\n');
  const kept = lines.filter((line) => line.toLowerCase().includes(q));
  return { text: kept.join('\n'), hiddenCount: lines.length - kept.length, totalCount: lines.length };
}

/**
 * Splits tokens at every case-insensitive occurrence of `query`, tagging the
 * matched pieces so the template can render them as <mark>. Returns the
 * match count so the caller can drive a "3/12" counter and jump-to-match nav.
 */
export function highlightTokens(tokens: readonly JsonToken[], query: string): { tokens: HighlightToken[]; matchCount: number } {
  if (!query) {
    return { tokens: tokens.map((t) => ({ ...t, highlighted: false })), matchCount: 0 };
  }

  const q = query.toLowerCase();
  const result: HighlightToken[] = [];
  let matchCount = 0;

  for (const token of tokens) {
    const lower = token.text.toLowerCase();
    if (!lower.includes(q)) {
      result.push({ ...token, highlighted: false });
      continue;
    }

    let cursor = 0;
    let idx: number;
    while ((idx = lower.indexOf(q, cursor)) !== -1) {
      if (idx > cursor) {
        result.push({ text: token.text.slice(cursor, idx), cls: token.cls, highlighted: false });
      }
      result.push({
        text: token.text.slice(idx, idx + query.length),
        cls: token.cls,
        highlighted: true,
        matchIndex: matchCount,
      });
      matchCount++;
      cursor = idx + query.length;
    }
    if (cursor < token.text.length) {
      result.push({ text: token.text.slice(cursor), cls: token.cls, highlighted: false });
    }
  }

  return { tokens: result, matchCount };
}

export function tryParseJson(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (typeof text !== 'string') return { ok: false };
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}
