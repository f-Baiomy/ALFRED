import { prettyXmlText, tokenizeXmlText, tryParseXml } from './xml-tokenizer';

describe('prettyXmlText', () => {
  it('indents an unindented single-line document by nesting depth', () => {
    const pretty = prettyXmlText('<a><b>text</b><c/></a>');
    expect(pretty).toBe('<a>\n  <b>text</b>\n  <c/>\n</a>');
  });

  it('is idempotent on already-indented input', () => {
    const once = prettyXmlText('<a><b>text</b></a>');
    expect(prettyXmlText(once)).toBe(once);
  });

  it('leaves an XML declaration and attributes untouched', () => {
    const pretty = prettyXmlText('<?xml version="1.0"?><root attr="1"><child/></root>');
    expect(pretty).toBe('<?xml version="1.0"?>\n<root attr="1">\n  <child/>\n</root>');
  });
});

describe('tokenizeXmlText', () => {
  it('classifies tag names, attribute names, attribute values, and comments', () => {
    const tokens = tokenizeXmlText('<a id="1"><!-- note --></a>');
    const byClass = (cls: string) => tokens.filter((t) => t.cls === cls).map((t) => t.text);

    expect(byClass('k')).toEqual(['<a', '</a']);
    expect(byClass('n')).toEqual(['id']);
    expect(byClass('s')).toEqual(['"1"']);
    expect(byClass('z')).toEqual(['<!-- note -->']);
  });

  it('reassembles to the original text', () => {
    const text = prettyXmlText('<a id="1"><b>text</b></a>');
    expect(tokenizeXmlText(text).map((t) => t.text).join('')).toBe(text);
  });
});

describe('tryParseXml', () => {
  it('accepts well-formed XML and returns it pretty-printed', () => {
    const result = tryParseXml('<a><b>1</b></a>');
    expect(result).toEqual({ ok: true, pretty: '<a>\n  <b>1</b>\n</a>' });
  });

  it('rejects malformed XML, plain text, JSON, empty strings, and non-strings', () => {
    expect(tryParseXml('<a><b></a>')).toEqual({ ok: false });
    expect(tryParseXml('not xml')).toEqual({ ok: false });
    expect(tryParseXml('{"a":1}')).toEqual({ ok: false });
    expect(tryParseXml('')).toEqual({ ok: false });
    expect(tryParseXml(undefined)).toEqual({ ok: false });
  });
});
