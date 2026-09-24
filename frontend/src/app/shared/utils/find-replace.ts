import { HighlightToken, JsonToken } from './json-tokenizer';

/**
 * Find & replace over a body being edited by hand - the pure half of the body editor's search.
 *
 * Everything the editor shows about a search (the i/N counter, the marks painted behind the
 * caret, the match Replace acts on) goes through ONE matcher built here, so the count, the
 * highlight and the replacement can never disagree about what "a match" is. The old find-only
 * search counted with an indexOf over the whole text but highlighted token by token, so a match
 * that straddled two tokens was counted and never marked; ranges over the whole text fix that.
 */

export interface FindOptions {
  /** Treat the find text as a JavaScript regular expression rather than literal text. */
  readonly regex: boolean;
  /** Off by default - the find box has always been case-insensitive, and stays so unless asked. */
  readonly matchCase: boolean;
}

/** One match, as a half-open [start, end) range of UTF-16 offsets into the searched text. */
export interface MatchRange {
  readonly start: number;
  readonly end: number;
}

function flagsFor(opts: FindOptions): string {
  return opts.matchCase ? 'g' : 'gi';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The single matcher for a find text. Null for an empty find, and null - never a throw - for a
 * regex that does not compile: the find box is typed into a character at a time, and `(` on its
 * way to `(\d+)` is invalid for a keystroke. `matcherError` says why.
 */
export function buildMatcher(find: string, opts: FindOptions): RegExp | null {
  if (!find) return null;
  try {
    return new RegExp(opts.regex ? find : escapeRegExp(find), flagsFor(opts));
  } catch {
    return null;
  }
}

/** Why `buildMatcher` returned null for a non-empty find, in the engine's own words; else null. */
export function matcherError(find: string, opts: FindOptions): string | null {
  if (!find || !opts.regex) return null;
  try {
    new RegExp(find, flagsFor(opts));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A private global copy, so a caller's matcher (and its lastIndex) is never mutated here. */
function globalCopy(matcher: RegExp): RegExp {
  return new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : matcher.flags + 'g');
}

/**
 * Every non-empty match, in order. Zero-length matches (`^`, `\b`, `a*` between the a's) are
 * skipped: there is nothing to mark or replace, and counting them would put "1/40" on a body
 * with no visible match. Stepping lastIndex past one is what keeps `^` from looping forever.
 */
export function findAll(text: string, matcher: RegExp | null): MatchRange[] {
  if (!matcher) return [];
  const re = globalCopy(matcher);
  const out: MatchRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Makes a replacement string literal - `$1` stays the two characters `$1`. The editor applies it
 * when Regex is off: a plain-text find should put back exactly what was typed.
 */
export function literalReplacement(replacement: string): string {
  return replacement.replace(/\$/g, '$$$$');
}

/**
 * Replaces only the `index`-th non-empty match (counted the way `findAll` counts), leaving every
 * other one alone. The replacement understands the same `$1`, `$<name>`, `$&` and `$$` a native
 * String.replace does. Out of range, or no matcher, returns the text unchanged.
 */
export function replaceAt(text: string, matcher: RegExp | null, index: number, replacement: string): string {
  if (!matcher || index < 0) return text;
  let seen = -1;
  return text.replace(globalCopy(matcher), (...args: unknown[]) => {
    const match = args[0] as string;
    if (match.length === 0) return match;
    seen++;
    return seen === index ? expandReplacement(replacement, args) : match;
  });
}

/** Replaces every non-empty match; `count` is how many were replaced. */
export function replaceAll(text: string, matcher: RegExp | null, replacement: string): { text: string; count: number } {
  if (!matcher) return { text, count: 0 };
  let count = 0;
  const out = text.replace(globalCopy(matcher), (...args: unknown[]) => {
    const match = args[0] as string;
    if (match.length === 0) return match;
    count++;
    return expandReplacement(replacement, args);
  });
  return { text: out, count };
}

/**
 * Expands `$` patterns for one match, with the same rules String.replace uses. Needed because the
 * callback form of replace (the only way to act on just one match) gets no expansion of its own.
 * `args` is exactly what String.replace hands its callback: match, groups..., offset, input, and
 * a named-groups object only when the pattern has named groups.
 */
function expandReplacement(replacement: string, args: unknown[]): string {
  if (!replacement.includes('$')) return replacement;
  const hasNamed = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
  const named = hasNamed ? (args[args.length - 1] as Record<string, string | undefined>) : undefined;
  const tail = hasNamed ? 3 : 2;
  const input = args[args.length - tail + 1] as string;
  const offset = args[args.length - tail] as number;
  const match = args[0] as string;
  const groups = args.slice(1, args.length - tail) as (string | undefined)[];

  return replacement.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (token, what: string, name?: string) => {
    if (what === '$') return '$';
    if (what === '&') return match;
    if (what === '`') return input.slice(0, offset);
    if (what === "'") return input.slice(offset + match.length);
    if (name !== undefined) return named ? named[name] ?? '' : token;
    // Two digits only when that many groups exist - `$10` with one group is `$1` then "0".
    const two = Number(what);
    if (what.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number(what[0]);
    if (one >= 1 && one <= groups.length) return (groups[one - 1] ?? '') + what.slice(1);
    return token;
  });
}

/**
 * Marks `ranges` on a gapless token stream (the tokenizers cover every character of the text, so
 * token offsets ARE text offsets). A match that straddles tokens becomes several marked pieces
 * sharing one matchIndex, so it is painted whole and lights up as one "current" match.
 */
export function markRanges(tokens: readonly JsonToken[], ranges: readonly MatchRange[]): HighlightToken[] {
  if (ranges.length === 0) return tokens.map((t) => ({ ...t, highlighted: false }));
  const out: HighlightToken[] = [];
  let r = 0;
  let pos = 0;
  for (const token of tokens) {
    const tokenEnd = pos + token.text.length;
    let cursor = pos;
    while (cursor < tokenEnd) {
      while (r < ranges.length && ranges[r].end <= cursor) r++;
      const range = ranges[r];
      if (!range || range.start >= tokenEnd) {
        out.push({ text: token.text.slice(cursor - pos), cls: token.cls, highlighted: false });
        break;
      }
      if (range.start > cursor) {
        out.push({ text: token.text.slice(cursor - pos, range.start - pos), cls: token.cls, highlighted: false });
        cursor = range.start;
      }
      const end = Math.min(range.end, tokenEnd);
      out.push({ text: token.text.slice(cursor - pos, end - pos), cls: token.cls, highlighted: true, matchIndex: r });
      cursor = end;
    }
    pos = tokenEnd;
  }
  return out;
}
