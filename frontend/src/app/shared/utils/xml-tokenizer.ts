import { JsonToken } from './json-tokenizer';

/**
 * Companion to json-tokenizer.ts for XML request/response bodies (SOAP
 * suppliers commonly return XML, not JSON) - pretty-prints and tokenizes XML
 * text into the same JsonToken shape, so it slots into the exact same
 * flat-view render pipeline (highlightTokens -> splitTokensIntoLines ->
 * JsonFlatViewComponent) that JSON already uses, without that pipeline
 * needing to know which content type it's looking at.
 */

const CLOSING_TAG_START = /^<\/\w/;
// An opening tag, not a closing tag ("</..."), processing instruction ("<?...")
// comment, or doctype ("<!...") - those never need their children indented.
const OPENING_TAG_START = /^<[A-Za-z_]/;
const SELF_CLOSING_END = /\/>$/;
const INLINE_CLOSE_TAG = /<\/[\w:.-]+>$/;

/**
 * Re-indents XML by inserting a line break at every tag boundary and
 * indenting by nesting depth. Deliberately collapses the input's own
 * whitespace between tags first, so the result is the same regardless of
 * whether the source was already indented or - the common case for a
 * machine-generated SOAP response - all on one line with no whitespace at
 * all between elements.
 */
export function prettyXmlText(xml: string): string {
  const collapsed = xml.replace(/>\s+</g, '><').trim();
  const withBreaks = collapsed.replace(/(>)(<)(\/*)/g, '$1\n$2$3');

  let pad = 0;
  return withBreaks
    .split('\n')
    .map((node) => {
      let indent = 0;
      if (CLOSING_TAG_START.test(node)) {
        pad = Math.max(pad - 1, 0);
      } else if (OPENING_TAG_START.test(node) && !SELF_CLOSING_END.test(node) && !INLINE_CLOSE_TAG.test(node)) {
        indent = 1;
      }
      const line = '  '.repeat(pad) + node;
      pad += indent;
      return line;
    })
    .join('\n');
}

const XML_TOKEN_REGEX =
  /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<\/?[A-Za-z_][-\w:.]*)|(\/?>)|("[^"]*"|'[^']*')|\b([A-Za-z_][-\w:.]*)(?=\s*=)/g;

function classify(match: RegExpMatchArray): JsonToken['cls'] {
  if (match[1] || match[2]) return 'z'; // comment / CDATA
  if (match[3]) return 'k'; // tag name (including its leading "<" or "</")
  if (match[5]) return 's'; // attribute value
  if (match[6]) return 'n'; // attribute name
  return ''; // bare ">" / "/>" punctuation
}

/** Tokenizes pretty-printed XML text - the XML equivalent of json-tokenizer.ts's tokenizeJsonText. */
export function tokenizeXmlText(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(XML_TOKEN_REGEX)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, index), cls: '' });
    }
    tokens.push({ text: match[0], cls: classify(match) });
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), cls: '' });
  }
  return tokens;
}

/**
 * Confirms the text is well-formed XML via DOMParser rather than just
 * "starts with a tag" - rejects things like an HTML error-page fragment or a
 * stray "<" inside otherwise-plain text that would otherwise be misdetected.
 */
export function tryParseXml(text: string | undefined): { ok: true; pretty: string } | { ok: false } {
  if (typeof text !== 'string') return { ok: false };
  const trimmed = text.trim();
  if (!trimmed || !trimmed.startsWith('<')) return { ok: false };

  const doc = new DOMParser().parseFromString(trimmed, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return { ok: false };

  return { ok: true, pretty: prettyXmlText(trimmed) };
}
