import { changedText, textDiff } from './text-diff';

describe('textDiff (specs/034)', () => {
  it('marks the words the user changed and keeps the rest', () => {
    const d = textDiff('deployed to Staging 216 and ready', 'deployed to staging 216 (build 3.4.7) and ready');
    expect(d.filter((p) => p.kind === 'del').map((p) => p.text.trim())).toContain('Staging');
    expect(d.filter((p) => p.kind === 'ins').map((p) => p.text).join('')).toContain('(build 3.4.7)');
    expect(d.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe('deployed to staging 216 (build 3.4.7) and ready');
    expect(d.filter((p) => p.kind !== 'ins').map((p) => p.text).join('')).toBe('deployed to Staging 216 and ready');
  });

  it('says nothing changed for the same text, and handles empty sides', () => {
    expect(changedText(textDiff('same', 'same'))).toBeFalse();
    expect(textDiff('', 'new')).toEqual([{ kind: 'ins', text: 'new' }]);
    expect(textDiff('old', '')).toEqual([{ kind: 'del', text: 'old' }]);
  });

  it('a very long text is shown as replaced rather than diffed slowly', () => {
    const a = 'word '.repeat(5000);
    const d = textDiff(a, a + 'more');
    expect(d.map((p) => p.kind)).toEqual(['del', 'ins']);
  });
});
