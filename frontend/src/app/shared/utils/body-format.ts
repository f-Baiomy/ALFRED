import { tryParseJson } from './json-tokenizer';
import { tryParseXml } from './xml-tokenizer';

export type BodyLang = 'json' | 'xml' | '';

/**
 * Single detect-and-format entry point shared by the HTML and Markdown
 * exporters (the live json-panel view does its own detection since it also
 * needs the parsed JSON *value* for the Tree view, not just formatted text).
 * JSON is tried first since it's cheaper to rule out and is the more common
 * body type; XML is only attempted once JSON fails.
 */
export function detectAndFormatBody(text: string): { lang: BodyLang; body: string } {
  const asJson = tryParseJson(text);
  if (asJson.ok) return { lang: 'json', body: JSON.stringify(asJson.value, null, 2) };

  const asXml = tryParseXml(text);
  if (asXml.ok) return { lang: 'xml', body: asXml.pretty };

  return { lang: '', body: text };
}
