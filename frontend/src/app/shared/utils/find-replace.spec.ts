import { buildMatcher, findAll, literalReplacement, markRanges, matcherError, replaceAll, replaceAt } from './find-replace';
import { tokenizeJsonText } from './json-tokenizer';

const PLAIN = { regex: false, matchCase: false };
const CASED = { regex: false, matchCase: true };
const REGEX = { regex: true, matchCase: false };

describe('find-replace', () => {
  describe('buildMatcher / findAll', () => {
    it('returns no matcher, and so no matches, for an empty find', () => {
      expect(buildMatcher('', PLAIN)).toBeNull();
      expect(findAll('anything', null)).toEqual([]);
    });

    it('finds plain text literally - regex metacharacters are just characters', () => {
      const matcher = buildMatcher('a.b', PLAIN);
      expect(findAll('a.b axb a.b', matcher)).toEqual([
        { start: 0, end: 3 },
        { start: 8, end: 11 },
      ]);
    });

    it('is case-insensitive by default, as the find box always was', () => {
      expect(findAll('Seats seats SEATS', buildMatcher('seats', PLAIN)).length).toBe(3);
    });

    it('honours match case when asked', () => {
      expect(findAll('Seats seats SEATS', buildMatcher('seats', CASED))).toEqual([{ start: 6, end: 11 }]);
    });

    it('runs a regex when asked', () => {
      expect(findAll('id=12 id=345', buildMatcher('\\d+', REGEX))).toEqual([
        { start: 3, end: 5 },
        { start: 9, end: 12 },
      ]);
    });

    it('returns null for a bad regex instead of throwing, and says why', () => {
      expect(buildMatcher('(\\d+', REGEX)).toBeNull();
      expect(matcherError('(\\d+', REGEX)).toBeTruthy();
      // The same text is fine as a plain find.
      expect(matcherError('(\\d+', PLAIN)).toBeNull();
      expect(buildMatcher('(\\d+', PLAIN)).not.toBeNull();
    });

    it('skips zero-length matches without looping forever', () => {
      expect(findAll('one\ntwo', buildMatcher('^', REGEX))).toEqual([]);
      expect(findAll('baa', buildMatcher('a*', REGEX))).toEqual([{ start: 1, end: 3 }]);
    });

    it('never moves the caller matcher lastIndex', () => {
      const matcher = buildMatcher('a', PLAIN)!;
      findAll('aaa', matcher);
      expect(matcher.lastIndex).toBe(0);
    });
  });

  describe('replaceAt / replaceAll', () => {
    it('replaces only the current match', () => {
      const matcher = buildMatcher('x', PLAIN);
      expect(replaceAt('x-x-x', matcher, 1, 'Y')).toBe('x-Y-x');
    });

    it('replaces every match and counts them', () => {
      expect(replaceAll('x-X-x', buildMatcher('x', PLAIN), 'Y')).toEqual({ text: 'Y-Y-Y', count: 3 });
    });

    it('expands $1 groups in a regex replacement', () => {
      const matcher = buildMatcher('(\\w+)@(\\w+)', REGEX);
      expect(replaceAt('a@b c@d', matcher, 1, '$2@$1')).toBe('a@b d@c');
      expect(replaceAll('a@b c@d', matcher, '[$&]').text).toBe('[a@b] [c@d]');
    });

    it('expands named groups and $$', () => {
      const matcher = buildMatcher('(?<n>\\d+)', REGEX);
      expect(replaceAll('7', matcher, '$$<$<n>>').text).toBe('$<7>');
    });

    it('keeps $1 literal once made literal for a plain find', () => {
      expect(replaceAll('price', buildMatcher('price', PLAIN), literalReplacement('$1')).text).toBe('$1');
    });

    it('counts matches for replaceAt the way findAll does, zero-length ones excluded', () => {
      const matcher = buildMatcher('a*', REGEX);
      expect(replaceAt('baa', matcher, 0, 'Z')).toBe('bZ');
      expect(replaceAll('^x', buildMatcher('^', REGEX), 'Q')).toEqual({ text: '^x', count: 0 });
    });

    it('leaves the text alone for an out-of-range index or no matcher', () => {
      expect(replaceAt('abc', buildMatcher('b', PLAIN), 5, 'Z')).toBe('abc');
      expect(replaceAt('abc', null, 0, 'Z')).toBe('abc');
    });
  });

  describe('markRanges', () => {
    it('marks a match that straddles two tokens as one match', () => {
      const text = '{"a":1}';
      const tokens = tokenizeJsonText(text);
      // `:1` spans the key token ("a":) and the number token (1).
      const marked = markRanges(tokens, findAll(text, buildMatcher(':1', PLAIN)));

      expect(marked.map((t) => t.text).join('')).toBe(text);
      const hits = marked.filter((t) => t.highlighted);
      expect(hits.map((t) => t.text).join('')).toBe(':1');
      expect(hits.every((t) => t.matchIndex === 0)).toBeTrue();
      expect(hits.map((t) => t.cls)).toEqual(['k', 'n']);
    });
  });
});
