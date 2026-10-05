import { CallRecord } from '../../core/models/call.model';

/**
 * A response that says it worked (status below 400) while its body says it did not - a SOAP Fault,
 * an OTA `<Error Code="322">`, a JSON `errors` list, `"success": false`. Suppliers answer this way
 * all the time, and a status column then reads green while the booking silently found nothing: a
 * real debugging session lost several steps to an Air Arabia error 322 hidden in a 200. Pure and
 * body-only, so the MCP server, the exports and later the UI all judge a call the same way.
 */
export interface SoftFailure {
  /** The supplier's own code when it gives one ("322"), else null. */
  readonly code: string | null;
  /** Its message, shortened - never the whole body. */
  readonly message: string;
  /** Where it was found: 'soap-fault' | 'xml-error' | 'json-errors' | 'json-success-false' | 'json-error'. */
  readonly kind: string;
}

const MESSAGE_LIMIT = 200;

function short(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MESSAGE_LIMIT ? `${clean.slice(0, MESSAGE_LIMIT)}…` : clean;
}

function decodeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

function xmlFailure(body: string): SoftFailure | null {
  const fault = /<(?:[\w.-]+:)?Fault\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Fault>/i.exec(body);
  if (fault) {
    const text = /<(?:[\w.-]+:)?(?:faultstring|Text|Reason)\b[^>]*>([\s\S]*?)<\//i.exec(fault[1]);
    const code = /<(?:[\w.-]+:)?(?:faultcode|Value)\b[^>]*>([^<]*)</i.exec(fault[1]);
    return { kind: 'soap-fault', code: code ? decodeXml(code[1]).trim() : null, message: short(decodeXml(text ? text[1].replace(/<[^>]+>/g, ' ') : 'SOAP Fault')) };
  }
  // OTA and most travel XML: <Errors><Error Code="322" ShortText="...">text</Error></Errors>. A
  // <Warning> is not a failure; an <Error> element anywhere is.
  const error = /<(?:[\w.-]+:)?Error\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?Error>)/i.exec(body);
  if (error) {
    const attrs = error[1] ?? '';
    const text = (error[2] ?? '').replace(/<[^>]+>/g, ' ');
    const message = attr(attrs, 'ShortText') ?? (text.trim() ? decodeXml(text) : null) ?? attr(attrs, 'Type') ?? 'Error element in the response';
    return { kind: 'xml-error', code: attr(attrs, 'Code'), message: short(message) };
  }
  return null;
}

function messageOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    for (const key of ['message', 'Message', 'description', 'detail', 'error', 'errorMessage', 'title', 'text']) {
      if (typeof v[key] === 'string' && v[key]) return v[key] as string;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function codeOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  for (const key of ['code', 'Code', 'errorCode', 'status']) {
    if (typeof v[key] === 'string' || typeof v[key] === 'number') return String(v[key]);
  }
  return null;
}

/** Checks the top level and one level down - deeper keys named "error" are too often ordinary data. */
function jsonFailure(value: unknown, depth = 0): SoftFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  for (const key of ['errors', 'Errors']) {
    const errors = v[key];
    if (Array.isArray(errors) && errors.length > 0) return { kind: 'json-errors', code: codeOf(errors[0]), message: short(messageOf(errors[0])) };
    if (errors && typeof errors === 'object' && !Array.isArray(errors) && Object.keys(errors).length > 0) {
      const first = Object.values(errors)[0];
      return { kind: 'json-errors', code: codeOf(first), message: short(messageOf(first)) };
    }
  }
  if (v['success'] === false || v['Success'] === false || v['ok'] === false) {
    return { kind: 'json-success-false', code: codeOf(v), message: short(messageOf(v['message'] ?? v['error'] ?? v['errorMessage'] ?? 'success: false')) };
  }
  for (const key of ['error', 'Error']) {
    const error = v[key];
    if (error !== undefined && error !== null && error !== false && error !== '' && !(typeof error === 'object' && Object.keys(error).length === 0)) {
      return { kind: 'json-error', code: codeOf(error), message: short(messageOf(error)) };
    }
  }
  if (depth === 0) {
    for (const child of Object.values(v)) {
      const found = jsonFailure(child, 1);
      if (found) return found;
    }
  }
  return null;
}

/** The soft failure in a call's response body, or null - only for a response whose status claims success. */
export function softFailureOf(call: Pick<CallRecord, 'response' | 'error'>): SoftFailure | null {
  const status = call.response?.status;
  const body = call.response?.body;
  if (call.error || status === undefined || status >= 400 || !body) return null;
  const trimmed = body.trimStart();
  if (trimmed.startsWith('<')) return xmlFailure(trimmed);
  if (trimmed.startsWith('{')) {
    try {
      return jsonFailure(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return null;
}

/** What makes a key a result list: the names searches and listings put their results under. */
const RESULT_KEY = /(offers?|results?|items|flights|journeys|itineraries|records|hits|rows|hotels|fares|availability|options|list)$/i;
const COUNT_KEY = /^(total|count|totalCount|totalResults|resultCount|numberOfResults)$/i;

function isEmptyHolder(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

export interface EmptyResult {
  /** The result-like keys that are empty, as paths ("searchOffers.offers"). */
  readonly emptyKeys: readonly string[];
}

/**
 * A successful JSON response whose result lists are all empty (`"offers": {}`, `[]`, `"total": 0`) -
 * "the search found nothing", worth showing next to the supplier calls that explain why. Null when
 * any result-like key holds something, or when the body has none at all.
 */
export function emptyResultOf(call: Pick<CallRecord, 'response' | 'error'>): EmptyResult | null {
  const status = call.response?.status;
  const body = call.response?.body?.trimStart();
  if (call.error || status === undefined || status >= 300 || !body?.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const empty: string[] = [];
  let filled = false;
  const visit = (node: unknown, path: string, depth: number) => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 2) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const at = path ? `${path}.${key}` : key;
      // `searchOffers: { offers: {}, journeys: {} }` is a wrapper, not a list: judged by what it holds.
      const wrapper = value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).some((k) => RESULT_KEY.test(k) || COUNT_KEY.test(k));
      if (RESULT_KEY.test(key) && value !== null && typeof value === 'object' && !wrapper) {
        // `bestPriceOffers: { "00:00-05:59": {}, ... }` holds buckets, not results: only what is in them counts.
        const size = Array.isArray(value) ? value.length : Object.values(value).filter((v) => !isEmptyHolder(v)).length;
        if (size === 0) empty.push(at);
        else filled = true;
      } else if (COUNT_KEY.test(key) && typeof value === 'number') {
        if (value === 0) empty.push(at);
        else filled = true;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(value, at, depth + 1);
    }
  };
  visit(parsed, '', 0);
  return !filled && empty.length > 0 ? { emptyKeys: empty } : null;
}
