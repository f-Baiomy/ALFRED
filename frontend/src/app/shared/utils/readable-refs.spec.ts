import { parseMentions } from './mention-syntax';
import { callMeaning, cycleCallOf, entryLabel, findBareRefs, shortOf, withBareRefs } from './readable-refs';

describe('readable-refs (specs/021)', () => {
  it('finds every shorthand Claude writes, each as what it is', () => {
    const refs = findBareRefs('Triage [6]: #49 same as #47. AC8: calls #75, #81 and #88 sent 3 branches (f89e0b77 before the build).');
    expect(refs.map((r) => `${r.kind}:${r.n ?? r.id}`)).toEqual([
      'history:6', 'card:49', 'card:47', 'ac:8', 'cycleCall:75', 'cycleCall:81', 'cycleCall:88', 'shortId:f89e0b77',
    ]);
  });

  it('never touches code, links, URLs or existing mentions', () => {
    const text = '`AC8` and\n```\n#47\n```\nand [see](https://x/#12) and @[card:p#47|All Agencies (#47)] and <span id="#3">';
    expect(findBareRefs(text)).toEqual([]);
  });

  it('a call range and a word that only looks like an id stay what they are', () => {
    expect(findBareRefs('calls #40-#61').map((r) => r.n)).toEqual([40, 61]);
    expect(findBareRefs('deadbeef accepted array[0] colour #fff')).toEqual([]);
  });

  it('draws older text with mentions to look up, only where they can be placed', () => {
    const shown = withBareRefs('Same as #47; AC8 not tried; calls #75; see [6]', { project: 'odeysys', cycleId: 'c1', card: 49 });
    const refs = parseMentions(shown).filter((s) => 'mention' in s).map((s) => ('mention' in s ? `${s.mention.type}:${s.mention.ref}` : ''));
    expect(refs).toEqual(['card:odeysys#47', 'spec:c1/*#ac8', 'call:n:75@c1', 'card:odeysys#49/i6']);
    expect(withBareRefs('AC8 and #47', {})).toBe('AC8 and #47');
  });

  it('a code in parentheses takes them with it - the chip writes its own', () => {
    const shown = withBareRefs("returns only that branch's requests (AC8)", { cycleId: 'c1' });
    expect(shown).toBe("returns only that branch's requests @[spec:c1/*#ac8|AC8]");
  });

  it('makes a short name from a long title', () => {
    expect(shortOf("Not exercised: Searching with one branch returns only that branch's requests (AC8)")).toBe('searching with one branch');
    expect(shortOf('PNR filter ignores dates.')).toBe('PNR filter ignores dates');
  });

  it('says a call, a cycle call and a history entry in words', () => {
    expect(callMeaning('POST', 'http://h/odeysysadmin/Booking2/refunded-requests/search?x=1', 200)).toBe('POST refunded-requests/search · 200');
    expect(cycleCallOf({ type: 'call', ref: 'n:75@c1', label: '' })).toEqual({ n: 75, cycleId: 'c1' });
    expect(entryLabel('USER', 'COMMENT', null, '**Answers** Triage: "the same"')).toBe('your answer');
    expect(entryLabel('CLAUDE', 'COMMENT', null, '```questions\n{}\n```')).toBe("Claude's question");
  });
});
