import vectors from '../../../../../specs/014-task-board/vectors/mentions.json';
import { callOf, mentionsIn, parseMentions, serializeMention, slug } from './mention-syntax';

describe('mention syntax (shared vectors with MentionParser.java)', () => {
  for (const v of vectors.vectors) {
    it(`parses: ${v.name}`, () => {
      expect(parseMentions(v.text)).toEqual(v.segments as ReturnType<typeof parseMentions>);
    });
  }

  for (const v of vectors.slugs) {
    it(`slugs '${v.heading}'`, () => expect(slug(v.heading)).toBe(v.slug));
  }

  for (const v of vectors.serialize) {
    it(`serializes ${v.text}`, () => expect(serializeMention(v.mention)).toBe(v.text));
  }

  it('round-trips a serialized mention back to itself', () => {
    const ref = { type: 'spec', ref: 'c-1/spec.md#acceptance', label: 'a | b ] c' };
    expect(parseMentions(serializeMention(ref))).toEqual([{ mention: ref }]);
  });

  it('keeps the first occurrence of each mention', () => {
    expect(mentionsIn('@[cycle:a|A] @[cycle:a|again] @[cycle:b|B]').map((m) => m.ref)).toEqual(['a', 'b']);
  });

  it('reads a call mention into its parts', () => {
    expect(callOf({ type: 'call', ref: 'out:x1@c-9', label: 'x' })).toEqual({ direction: 'out', id: 'x1', cycleId: 'c-9' });
    expect(callOf({ type: 'call', ref: 'in:x1', label: 'x' })).toEqual({ direction: 'in', id: 'x1', cycleId: null });
    expect(callOf({ type: 'cycle', ref: 'c', label: 'x' })).toBeNull();
  });
});
