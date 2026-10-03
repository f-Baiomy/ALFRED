/**
 * C1 chaining: pulling values out of a resend response and substituting them into later drafts.
 *
 * Two halves, deliberately separate:
 *  - `extractValues` reads a call's own ExtractRule[] against ITS OWN response, right after that
 *    call returns.
 *  - `substituteDraft` resolves `{{this.x}}` / `{{row.x}}` (and the client-side `{{$base64:this.x
 *    | row.x}}` case from D4's grammar) in a LATER draft's method/url/headers/body, right before
 *    it is sent.
 *
 * `this.*` values live in a plain mutable object the caller (BulkResendDialogService) owns for the
 * whole send: a sequential run merges into it after each call, so the next call in the same run
 * sees it immediately; a parallel group's caller only merges once the whole group has settled, so
 * "extracted values are available only to runs after the group" holds without this file knowing
 * anything about groups or run order.
 */

import { asText, parseJson, valuesAt } from './json-paths';
import { ExtractRule, ResendResponseSnapshot } from './resend-draft';

/** `this.<name>` -> value, accumulated across one send. */
export type ThisValues = Record<string, string>;

/**
 * What one call's extract rules produced, keyed by `as`. A rule whose source is missing stores
 * nothing when `missing === 'SKIP'` - a later `{{this.x}}` referencing it is then reported
 * unavailable rather than silently substituting an empty string.
 */
export function extractValues(response: ResendResponseSnapshot | null, rules: readonly ExtractRule[] | undefined): Record<string, string> {
  if (!response || !rules || rules.length === 0) return {};
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const value = extractOne(response, rule);
    if (value !== undefined) out[rule.as] = value;
    else if (rule.missing === 'FALLBACK') out[rule.as] = rule.fallback ?? '';
  }
  return out;
}

function extractOne(response: ResendResponseSnapshot, rule: ExtractRule): string | undefined {
  const path = rule.path.trim();
  if (!path) return undefined;
  if (rule.from === 'JSON') {
    const doc = parseJson(response.body);
    if (doc === undefined) return undefined;
    const values = valuesAt(doc, path);
    return values.length ? asText(values[0]) : undefined;
  }
  if (rule.from === 'HEADER') {
    const lower = path.toLowerCase();
    for (const [name, value] of Object.entries(response.headers)) {
      if (name.toLowerCase() === lower) return value;
    }
    return undefined;
  }
  if (rule.from === 'XML') return xmlValue(response.body, path);
  if (rule.from === 'REGEX') return regexValue(response.body, rule.path);
  return cookieValue(response.headers, path);
}

/** The first element (or `@attribute` of it) whose own name and the names of the elements above
 *  it end with `path`'s segments - so `token`, `LoginResponse.token` and the full
 *  `Envelope.Body.LoginResponse.token` all find the same SOAP field. Prefixes never count. */
export function xmlValue(body: string | null | undefined, path: string): string | undefined {
  if (!body || typeof DOMParser === 'undefined') return undefined;
  const doc = new DOMParser().parseFromString(body, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return undefined;
  const segments = path.split('.').map((s) => s.trim()).filter(Boolean);
  const attribute = segments.length && segments[segments.length - 1].startsWith('@') ? segments.pop()!.slice(1) : null;
  if (!segments.length) return undefined;
  const all = doc.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    let el: Element | null = all[i];
    let matched = true;
    for (let s = segments.length - 1; s >= 0; s--) {
      if (!el || el.localName !== segments[s]) { matched = false; break; }
      el = el.parentElement;
    }
    if (!matched) continue;
    if (attribute === null) return (all[i].textContent ?? '').trim();
    for (const attr of Array.from(all[i].attributes)) {
      if (attr.localName === attribute) return attr.value;
    }
  }
  return undefined;
}

/** The pattern's first group (or the whole match) in the body. An invalid pattern finds nothing. */
export function regexValue(body: string | null | undefined, pattern: string): string | undefined {
  if (!body || !pattern) return undefined;
  let found: RegExpExecArray | null;
  try {
    found = new RegExp(pattern).exec(body);
  } catch {
    return undefined;
  }
  if (!found) return undefined;
  return found.length > 1 ? found[1] ?? undefined : found[0];
}

/**
 * `set-cookie` is joined with ", " like every repeated header (contracts.md section 2), which is
 * ambiguous with a cookie's own attributes (`Expires=..., 13-Nov-2026 ...` also contains a comma) -
 * so a new cookie only starts where a comma is followed by a bare `name=`, not by an attribute.
 */
function cookieValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  return setCookies(headers).find((c) => c.name === name)?.value;
}

/** One cookie a response sets. `cleared`: Max-Age=0 or an Expires in the past - the server
 *  deleting it (a logout), so a browser would stop sending it. */
export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly cleared: boolean;
}

export function setCookies(headers: Readonly<Record<string, string>>): SetCookie[] {
  const raw = Object.entries(headers).find(([h]) => h.toLowerCase() === 'set-cookie')?.[1];
  if (!raw) return [];
  const out: SetCookie[] = [];
  for (const part of raw.split(/,(?=\s*[^=;,\s]+=)/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const [pair, ...attributes] = part.split(';');
    const name = pair.slice(0, pair.indexOf('=')).trim();
    if (!name) continue;
    const value = pair.slice(pair.indexOf('=') + 1).trim();
    out.push({ name, value, cleared: attributes.some(isClearingAttribute) });
  }
  return out;
}

function isClearingAttribute(attribute: string): boolean {
  const [key, ...rest] = attribute.split('=');
  const name = key.trim().toLowerCase();
  const value = rest.join('=').trim();
  if (name === 'max-age') return Number(value) <= 0;
  if (name === 'expires') {
    const at = Date.parse(value);
    return !Number.isNaN(at) && at < Date.now();
  }
  return false;
}

const THIS_TOKEN = /\{\{this\.([A-Za-z0-9_.-]+)\}\}/g;
const ROW_TOKEN = /\{\{row\.([A-Za-z0-9_.-]+)\}\}/g;
/** Only the client-resolvable case of D4's `{{$base64:...}}` grammar - a `this.`/`row.` argument.
 *  Anything else starting with `$` is left for the backend, unchanged. */
const BASE64_TOKEN = /\{\{\$base64:(this|row)\.([A-Za-z0-9_.-]+)\}\}/g;

export interface SubstituteResult {
  readonly text: string;
  /** `this.<name>` entries referenced but not (yet) available - left literal in `text`. */
  readonly unavailable: readonly string[];
}

/** Substitutes one piece of text. `rowValues` is only passed for a dataset-driven group run. */
export function substituteTokens(text: string, thisValues: Readonly<ThisValues>, rowValues?: Readonly<Record<string, string>>): SubstituteResult {
  const unavailable: string[] = [];

  let out = text.replace(BASE64_TOKEN, (match, scope: 'this' | 'row', name: string) => {
    const value = scope === 'this' ? thisValues[name] : rowValues?.[name];
    if (value === undefined) {
      if (scope === 'this') unavailable.push(name);
      return match;
    }
    return toBase64(value);
  });

  out = out.replace(THIS_TOKEN, (match, name: string) => {
    const value = thisValues[name];
    if (value === undefined) {
      unavailable.push(name);
      return match;
    }
    return value;
  });

  if (rowValues) {
    out = out.replace(ROW_TOKEN, (match, name: string) => (rowValues[name] === undefined ? match : rowValues[name]));
  }

  return { text: out, unavailable };
}

function toBase64(value: string): string {
  try {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(value)));
  } catch {
    /* fall through to literal-ish best effort below */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buffer = (globalThis as any).Buffer;
  return buffer ? buffer.from(value, 'utf-8').toString('base64') : value;
}

export interface SubstitutedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly { name: string; value: string; removed: boolean; added?: boolean }[];
  readonly body: string;
  /** De-duplicated `this.<name>` references that had no value at send time. */
  readonly unavailable: readonly string[];
}

/** Substitutes every field of a draft that is actually sent - not the group/include bookkeeping. */
export function substituteDraft(
  draft: { method: string; url: string; headers: readonly { name: string; value: string; removed: boolean; added?: boolean }[]; body: string },
  thisValues: Readonly<ThisValues>,
  rowValues?: Readonly<Record<string, string>>
): SubstitutedRequest {
  const unavailable = new Set<string>();
  const sub = (text: string): string => {
    const r = substituteTokens(text, thisValues, rowValues);
    r.unavailable.forEach((name) => unavailable.add(name));
    return r.text;
  };
  const method = sub(draft.method);
  const url = sub(draft.url);
  const headers = draft.headers.map((h) => (h.removed ? h : { ...h, value: sub(h.value) }));
  const body = sub(draft.body);
  return { method, url, headers, body, unavailable: [...unavailable] };
}

/** Merges one call's (or one settled parallel group's) extracted values into the running map. */
export function mergeThisValues(target: ThisValues, extracted: Readonly<Record<string, string>>): void {
  Object.assign(target, extracted);
}
