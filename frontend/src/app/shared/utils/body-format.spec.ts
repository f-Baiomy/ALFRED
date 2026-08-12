import { detectAndFormatBody } from './body-format';

describe('detectAndFormatBody', () => {
  it('pretty-prints JSON and tags it as json', () => {
    expect(detectAndFormatBody('{"a":1}')).toEqual({ lang: 'json', body: '{\n  "a": 1\n}' });
  });

  it('pretty-prints XML and tags it as xml', () => {
    expect(detectAndFormatBody('<a><b>1</b></a>')).toEqual({ lang: 'xml', body: '<a>\n  <b>1</b>\n</a>' });
  });

  it('falls back to the raw text verbatim, untagged, when neither JSON nor XML', () => {
    expect(detectAndFormatBody('plain text')).toEqual({ lang: '', body: 'plain text' });
  });
});
