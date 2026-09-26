/** One grammar for authored tokens, suggestions and variable names. */
export const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
export const VARIABLE_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g;

export interface TokenPart { readonly text: string; readonly token: boolean; }

export function tokenParts(value: string): TokenPart[] {
  const parts: TokenPart[] = [];
  let end = 0;
  for (const match of value.matchAll(VARIABLE_TOKEN)) {
    const start = match.index;
    if (start > end) parts.push({ text: value.slice(end, start), token: false });
    parts.push({ text: match[0], token: true });
    end = start + match[0].length;
  }
  if (end < value.length) parts.push({ text: value.slice(end), token: false });
  return parts;
}

export function tokenNames(value: string): string[] {
  return [...new Set([...value.matchAll(VARIABLE_TOKEN)].map((match) => match[1]))];
}

export function suggestionRange(value: string, caret: number): { start: number; end: number; query: string } | null {
  const match = /\{\{([A-Za-z0-9_.-]*)$/.exec(value.slice(0, caret));
  return match ? { start: caret - match[0].length, end: caret, query: match[1] } : null;
}

export function insertToken(value: string, range: { start: number; end: number }, name: string): { value: string; caret: number } {
  const closing = value.slice(range.end).startsWith('}}') ? 2 : 0;
  const token = `{{${name}}}`;
  return {
    value: value.slice(0, range.start) + token + value.slice(range.end + closing),
    caret: range.start + token.length,
  };
}
