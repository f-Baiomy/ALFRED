import { blockDir, inlineWords, nextChoice, textDir } from './text-direction';
import { markdownBlocks } from './markdown-blocks';

describe('text direction', () => {
  it('Arabic reads right-to-left, English left-to-right, mixed by the language most of it is in', () => {
    expect(textDir('الـcycle دي اتسجل فيها 370 call')).toBe('rtl');
    expect(textDir('The search ran 9 times (POST flight-search/search)')).toBe('ltr');
    expect(textDir('عمل الـuser الـsearch 9 مرات (POST flight-search/search)، اتنين رجعوا 500')).toBe('rtl');
    expect(textDir('Fixed in OrganizationModel - شكرا')).toBe('ltr');
    expect(textDir('370 · 500 · 27.5')).toBeNull();
  });

  it('an Arabic sentence that starts with English still reads right-to-left (dir="auto" would not)', () => {
    expect(textDir('POST flight-search/search اتنفذت تسع مرات واتنين منهم رجعوا خطأ')).toBe('rtl');
  });

  it('code and mentions do not count; the user\'s choice wins over the words', () => {
    const [p] = markdownBlocks('ده `org.hibernate.SQL.select` فيه مشكلة @[call:in:1|POST /Booking2/flight-search/search]');
    const words = p.kind === 'paragraph' ? inlineWords(p.inlines) : '';
    expect(words).not.toContain('hibernate');
    expect(blockDir('auto', words)).toBe('rtl');
    expect(blockDir('ltr', words)).toBe('ltr');
    expect(blockDir('auto', '123')).toBe('auto');
    expect([nextChoice('auto'), nextChoice('rtl'), nextChoice('ltr')]).toEqual(['rtl', 'ltr', 'auto']);
  });
});
