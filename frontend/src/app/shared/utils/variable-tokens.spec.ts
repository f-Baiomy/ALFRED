import { insertToken, suggestionRange, tokenNames, tokenParts } from './variable-tokens';

describe('variable token editing', () => {
  it('keeps surrounding text exactly once', () => {
    const value = 'before {{v}} after';
    expect(tokenParts(value)).toEqual([
      { text: 'before ', token: false },
      { text: '{{v}}', token: true },
      { text: ' after', token: false },
    ]);
    expect(tokenNames(value)).toEqual(['v']);
  });

  it('replaces the typed prefix and consumes existing closing braces once', () => {
    const value = 'before {{v}} after';
    const range = suggestionRange(value, 'before {{v'.length);
    expect(range).toEqual({ start: 7, end: 10, query: 'v' });
    expect(insertToken(value, range!, 'variable')).toEqual({
      value: 'before {{variable}} after', caret: 'before {{variable}}'.length,
    });
  });

  it('offers no suggestion when there is no opening prefix', () => {
    expect(suggestionRange('plain text', 10)).toBeNull();
  });

  it('recognizes and inserts Relive-scoped tokens', () => {
    expect(tokenNames('global {{name}} and relive {{$.bookingId}}')).toEqual(['name', '$.bookingId']);
    const range = suggestionRange('{{$.book', '{{$.book'.length);
    expect(range?.query).toBe('$.book');
    expect(insertToken('{{$.book', range!, '$.bookingId').value).toBe('{{$.bookingId}}');
  });
});
