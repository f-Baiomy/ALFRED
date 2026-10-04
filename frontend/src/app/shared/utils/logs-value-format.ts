import { tryParseJson } from './json-tokenizer';
import { tryParseXml } from './xml-tokenizer';

/**
 * What the Logs value window (⤢ Open) recognises in a value: JSON or XML, found as the window opens.
 * Detection never changes the value - "Original" always shows the text exactly as stored.
 */
export interface DetectedValue {
  readonly kind: 'json' | 'xml';
  /** Parsed JSON (for the tree); null for XML. */
  readonly json: unknown;
  /** The XML document (for the tree); null for JSON. */
  readonly xml: Document | null;
  /** Indented text: the Formatted view, and what Copy copies there. */
  readonly pretty: string;
  /** "object with 12 keys", "array of 3", "root <soap:Envelope> · 6 elements". */
  readonly summary: string;
  /** JSON that was stored as a string inside quotes (escaped) and was unwrapped. */
  readonly unwrapped: boolean;
}

/** JSON or XML, or null when the value is neither (or does not parse). */
export function detectValue(text: string): DetectedValue | null {
  const t = text.trim();
  if (t.startsWith('<')) {
    const x = tryParseXml(t);
    if (!x.ok) return null;
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    const root = doc.documentElement;
    return {
      kind: 'xml', json: null, xml: doc, pretty: x.pretty, unwrapped: false,
      summary: `root <${root.nodeName}> · ${doc.getElementsByTagName('*').length} elements`,
    };
  }
  if (!t.startsWith('{') && !t.startsWith('[') && !t.startsWith('"')) return null;
  const first = tryParseJson(t);
  if (!first.ok) return null;
  let value = first.value;
  let unwrapped = false;
  if (typeof value === 'string') {
    // JSON logged as a JSON string ("{\"a\":1}"): look inside once.
    const inner = tryParseJson(value);
    if (!inner.ok || !isContainer(inner.value)) return null;
    value = inner.value;
    unwrapped = true;
  }
  if (!isContainer(value)) return null;
  const summary = Array.isArray(value)
    ? `array of ${value.length}`
    : `object with ${Object.keys(value).length} key${Object.keys(value).length === 1 ? '' : 's'}`;
  return { kind: 'json', json: value, xml: null, pretty: JSON.stringify(value, null, 2), summary, unwrapped };
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object';
}

/** Why a value is not shown as JSON or XML ("Check format"). */
export interface FormatProblem {
  readonly kind: 'json' | 'xml' | 'text';
  /** One line: what is wrong and where. */
  readonly message: string;
  /** For JSON: the text just before the break, the character it breaks at, and a little after. */
  readonly before?: string;
  readonly at?: string;
  readonly after?: string;
  /** JSON that simply stops (cut off - e.g. by a logger's length limit). */
  readonly endsEarly?: boolean;
}

export function explainValue(text: string): FormatProblem {
  const t = text.trim();
  if (t.startsWith('<')) {
    const err = new DOMParser().parseFromString(t, 'application/xml').getElementsByTagName('parsererror')[0];
    const raw = (err?.textContent ?? '').replace(/\s+/g, ' ').trim();
    // Chrome wraps the parser's message in its own page text; keep the parser's sentence only.
    const detail = raw.replace(/^This page contains the following errors:\s*/i, '').replace(/\s*Below is a rendering.*$/i, '');
    return { kind: 'xml', message: `Looks like XML, but it does not parse: ${detail || 'not well-formed'}` };
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = /position (\d+)/.exec(msg);
      const pos = m ? Math.min(Number(m[1]), t.length) : t.length;
      const endsEarly = pos >= t.length || /end of (JSON )?input|unterminated/i.test(msg);
      const head = t.slice(0, pos);
      const line = head.split('\n').length;
      const column = pos - head.lastIndexOf('\n');
      return {
        kind: 'json',
        message: `Looks like JSON, but it does not parse${endsEarly ? ' - it ends too early' : ''}: line ${line}, column ${column}`,
        before: t.slice(Math.max(0, pos - 40), pos),
        at: endsEarly ? '' : t.charAt(pos),
        after: endsEarly ? '' : t.slice(pos + 1, pos + 30),
        endsEarly,
      };
    }
  }
  return { kind: 'text', message: 'Plain text - not JSON or XML (it does not start with { [ or <)' };
}
