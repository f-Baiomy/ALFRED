import { prettyJsonText, tryParseJson } from './json-tokenizer';
import { prettyXmlText, tryParseXml } from './xml-tokenizer';

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

/* ------------------------------------------------------------------------------------------
 * Editing a body by hand - the paused-call inspector.
 *
 * Built on the detection above rather than beside it: a body has to be classified the same way
 * whether it is being exported or edited, or the two end up disagreeing about what a payload is.
 * ---------------------------------------------------------------------------------------- */

export type BodyKind = 'json' | 'xml' | 'text';

export interface BodyValidity {
  readonly state: 'valid' | 'invalid' | 'none' | 'unchecked';
  /** Why it is invalid, in the parser's own words - a position is far more useful than "bad JSON". */
  readonly message?: string;
}

/**
 * Bodies above this are not re-checked on every keystroke. A 6 MB payload is real here (one
 * measured response pretty-prints to 110k lines), and parsing it per character would make the
 * textarea unusable - which is a worse failure than not showing a tick.
 */
export const LIVE_CHECK_LIMIT = 512_000;

export function detectBodyKind(text: string | null | undefined): BodyKind {
  if (!text || !text.trim()) return 'text';
  if (tryParseJson(text).ok) return 'json';
  if (tryParseXml(text).ok) return 'xml';
  return 'text';
}

/**
 * Pretty-prints, or returns null when this body cannot be formatted - malformed, or simply not a
 * structured format. Null rather than the input unchanged, so a caller can tell "nothing to do"
 * from "done" and say so.
 */
export function formatBody(text: string, kind: BodyKind): string | null {
  if (kind === 'json') {
    const parsed = tryParseJson(text);
    return parsed.ok ? prettyJsonText(parsed.value) : null;
  }
  if (kind === 'xml') {
    const parsed = tryParseXml(text);
    return parsed.ok ? parsed.pretty : null;
  }
  return null;
}

export function minifyBody(text: string, kind: BodyKind): string | null {
  if (kind === 'json') {
    const parsed = tryParseJson(text);
    return parsed.ok ? JSON.stringify(parsed.value) : null;
  }
  if (kind === 'xml') {
    // Between tags only. Whitespace INSIDE an element is content and removing it would change
    // what the document says, not just how it looks.
    const parsed = tryParseXml(text);
    return parsed.ok ? text.replace(/>\s+</g, '><').trim() : null;
  }
  return null;
}

/**
 * The form two bodies are compared in to decide whether one has really been edited.
 *
 * This is the load-bearing function here. Releasing a paused call sends only what changed, so an
 * untouched release is byte-identical to never having paused at all - and pretty-printing must
 * not quietly break that. Normalising both sides means reformatting alone is not an edit, while
 * changing any actual value is.
 *
 * Both normalisers are idempotent, which is what makes the comparison stable: `prettyJsonText`
 * round-trips through the parser, and `prettyXmlText` collapses the input's own whitespace before
 * re-indenting (see its own tests).
 */
export function normalizeBody(text: string | null | undefined, kind: BodyKind): string {
  const value = text ?? '';
  if (kind === 'json') {
    const parsed = tryParseJson(value);
    return parsed.ok ? JSON.stringify(parsed.value) : value;
  }
  if (kind === 'xml') {
    return prettyXmlText(value);
  }
  return value;
}

/** Whether two bodies differ in substance rather than only in layout. */
export function bodiesDiffer(before: string | null | undefined, after: string | null | undefined): boolean {
  const kind = detectBodyKind(after ?? before);
  return normalizeBody(before, kind) !== normalizeBody(after, kind);
}

export function validateBody(text: string, kind: BodyKind): BodyValidity {
  if (!text.trim()) return { state: 'none' };
  if (text.length > LIVE_CHECK_LIMIT) return { state: 'unchecked' };

  if (kind === 'json' || looksLikeJson(text)) {
    try {
      JSON.parse(text);
      return { state: 'valid' };
    } catch (e) {
      return { state: 'invalid', message: (e as Error).message };
    }
  }

  if (kind === 'xml' || text.trimStart().startsWith('<')) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const error = doc.getElementsByTagName('parsererror')[0];
    if (!error) return { state: 'valid' };
    // The browser's parsererror is a whole XHTML document; its text is the only useful part, and
    // only the first line of that says what actually went wrong.
    return { state: 'invalid', message: (error.textContent ?? 'Not well-formed XML').split('\n')[0].trim() };
  }

  return { state: 'none' };
}

/**
 * Used only to decide whether a body that does not currently PARSE should still be judged as
 * JSON - so that a half-typed edit is reported as broken JSON rather than silently reclassified
 * as plain text the moment it stops parsing.
 */
function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/** Where every occurrence of `query` starts, case-insensitively. Empty for an empty query. */
export function findMatches(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}
