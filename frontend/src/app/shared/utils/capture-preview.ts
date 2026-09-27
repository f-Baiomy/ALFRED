import { JsonType, jsonTypeOf } from './json-paths';

/**
 * A faithful TS port of proxy/interception.py's `_capture_value` (plus the dotted-path grammar
 * `_parse_path`/`_collect` it shares with Set/Remove JSON field), for the CAPTURE_REQUEST_VARIABLE
 * / CAPTURE_RESPONSE_VARIABLE action cards' "Preview on a call…" - see capture-value-preview
 * component. Pure: given a hydrated call's request or response half, says what the capture would
 * read, exactly as the proxy would read it from the same bytes.
 *
 * Kept deliberately narrow: this answers "what would this capture read from THIS call", not
 * "what does this call match" - RuleMatch has its own (already-live) preview machinery.
 */

export type CapturePhase = 'request' | 'response';
export type CaptureSource = 'JSON_FIELD' | 'HEADER' | 'COOKIE';

/** Same shape as the request/response half of a hydrated CallRecord - only what a capture reads. */
export interface CaptureMessage {
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly body?: string | null;
}

export interface CaptureOutcome {
  readonly found: boolean;
  /** The captured value (its real JSON type preserved for JSON_FIELD), or null when not found. */
  readonly value: unknown;
}

/** `'a.b[0].c'` / `'a[*].c'` -> `['a', 'b', 0, 'c']` / `['a', '*', 'c']` - proxy's `_parse_path`. */
export function parseCapturePath(path: string | null | undefined): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const part of String(path ?? '').split('.')) {
    if (!part) continue;
    const bracketAt = part.indexOf('[');
    const name = bracketAt < 0 ? part : part.slice(0, bracketAt);
    if (name) segments.push(name);
    let rest = bracketAt < 0 ? '' : part.slice(bracketAt + 1);
    while (rest) {
      const closeAt = rest.indexOf(']');
      const rawIndex = closeAt < 0 ? rest : rest.slice(0, closeAt);
      const index = rawIndex.trim();
      if (index === '*') segments.push('*');
      else if (/^-?\d+$/.test(index)) segments.push(Number(index));
      rest = (closeAt < 0 ? '' : rest.slice(closeAt + 1)).replace(/^\[+/, '');
    }
  }
  return segments;
}

/** Every value `segments` resolves to under `node` - proxy's `_collect`. `[*]` walks every item of a list. */
export function collectAtPath(node: unknown, segments: readonly (string | number)[]): unknown[] {
  if (segments.length === 0) return [node];
  const [head, ...rest] = segments;
  if (head === '*') {
    if (!Array.isArray(node)) return [];
    const out: unknown[] = [];
    for (const item of node) out.push(...collectAtPath(item, rest));
    return out;
  }
  if (typeof head === 'number') {
    if (!Array.isArray(node) || head >= node.length || head < -node.length) return [];
    return collectAtPath(node[head < 0 ? node.length + head : head], rest);
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node) || !(head in (node as Record<string, unknown>))) return [];
  return collectAtPath((node as Record<string, unknown>)[head], rest);
}

/** Parses `body` as JSON once and reads every value at `path` - proxy's `_json_field`. Empty on non-JSON or a miss. */
export function jsonFieldValues(body: string | null | undefined, path: string | null | undefined): unknown[] {
  if (!body) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  return collectAtPath(doc, parseCapturePath(path));
}

/** Header lookup case-insensitively, as HTTP names are (mitmproxy's Headers already does this). */
export function headerValue(headers: Readonly<Record<string, string>> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** name -> value for a Cookie header, first occurrence winning - proxy's `_request_cookies`. */
export function parseCookieHeader(headerText: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of String(headerText ?? '').split(';')) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const name = piece.slice(0, eq).trim();
    if (name && !(name in out)) out[name] = piece.slice(eq + 1).trim();
  }
  return out;
}

/** Attribute names SimpleCookie treats as belonging to the cookie before them, not as a new one. */
const SET_COOKIE_ATTRS = new Set(['expires', 'path', 'comment', 'domain', 'max-age', 'secure', 'version', 'httponly', 'samesite']);

/**
 * name -> value from a Set-Cookie header (or several, newline-joined - the flattened shape a
 * hydrated CallRecord carries) - proxy's `SimpleCookie().load(header)` over `get_all('set-cookie')`.
 * Best-effort: a CallRecord's headers are a flat map, so two distinct Set-Cookie headers that
 * collapsed to one string are read as newline-separated - the common single-cookie case is exact.
 */
export function parseSetCookieHeader(headerText: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of String(headerText ?? '').split('\n')) {
    let any = false;
    for (const piece of header.split(';')) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      const name = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim();
      const value = eq < 0 ? '' : trimmed.slice(eq + 1).trim();
      if (!name) continue;
      if (any && SET_COOKIE_ATTRS.has(name.toLowerCase())) continue;
      if (!(name in out)) out[name] = value;
      any = true;
    }
  }
  return out;
}

/**
 * What `CAPTURE_REQUEST_VARIABLE` / `CAPTURE_RESPONSE_VARIABLE` would read from `message` (the
 * call's request half in the request phase, its response half in the response phase) - proxy's
 * `_capture_value`, minus the missingBehavior fallback (the preview shows that separately, since
 * showing the fallback value AS the capture would misrepresent what the source actually held).
 */
export function captureValue(message: CaptureMessage | null | undefined, source: CaptureSource | null | undefined, path: string | null | undefined): CaptureOutcome {
  const p = path ?? '';
  if (source === 'JSON_FIELD') {
    const values = jsonFieldValues(message?.body, p);
    if (values.length === 0) return { found: false, value: null };
    return { found: true, value: p.includes('[*]') ? values : values[0] };
  }
  if (source === 'HEADER') {
    const value = headerValue(message?.headers, p);
    return { found: value !== undefined, value: value ?? null };
  }
  if (source === 'COOKIE') {
    const cookies = parseCookieHeader(headerValue(message?.headers, 'cookie'));
    if (p in cookies) return { found: true, value: cookies[p] };
    return { found: false, value: null };
  }
  return { found: false, value: null };
}

/** The response-half twin of `captureValue`'s COOKIE branch - reads Set-Cookie, not Cookie. */
export function captureValueResponse(message: CaptureMessage | null | undefined, source: CaptureSource | null | undefined, path: string | null | undefined): CaptureOutcome {
  if (source !== 'COOKIE') return captureValue(message, source, path);
  const p = path ?? '';
  const cookies = parseSetCookieHeader(headerValue(message?.headers, 'set-cookie'));
  if (p in cookies) return { found: true, value: cookies[p] };
  return { found: false, value: null };
}

/** One entry point for either phase - the capture reads Cookie in the request half, Set-Cookie in the response half. */
export function captureValueFor(message: CaptureMessage | null | undefined, source: CaptureSource | null | undefined, path: string | null | undefined, phase: CapturePhase): CaptureOutcome {
  return phase === 'response' ? captureValueResponse(message, source, path) : captureValue(message, source, path);
}

/** Whether a captured variable's NAME looks like something that should be masked before display. */
export const LOOKS_SECRET = /token|session|auth|key|password|secret/i;

export interface CaptureShape {
  readonly type: JsonType;
  /** String length, array length, or object key count - null for a number/boolean/null value. */
  readonly length: number | null;
}

/** The JSON type and a size for a found value - shown beside the (possibly masked) value itself. */
export function shapeOf(value: unknown): CaptureShape {
  const type = jsonTypeOf(value);
  if (type === 'text') return { type, length: (value as string).length };
  if (type === 'list') return { type, length: (value as unknown[]).length };
  if (type === 'object') return { type, length: Object.keys(value as Record<string, unknown>).length };
  return { type, length: null };
}

/** "abc" -> "•••" of the same length capped at 12 - close enough to read as "masked" without giving away its size exactly. */
export function maskText(value: string): string {
  return '•'.repeat(Math.min(value.length, 12) || 1);
}
