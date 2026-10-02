import { parseCookieHeader } from './capture-preview';

/** One name a header / cookie box can offer, with the value the call had for it (a preview). */
export interface NameSuggestion {
  readonly name: string;
  readonly value: string;
}

/** Headers that say how the bytes travelled, not what the call was - least likely to be wanted. */
const TRANSPORT = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'date', 'accept-encoding', 'content-encoding',
  'host', 'vary', 'expires', 'pragma', 'cache-control', 'te', 'upgrade', 'proxy-connection',
]);
/** Standard headers everyone sends - offered after the call's own, unusual ones. */
const STANDARD = new Set([
  'accept', 'accept-language', 'content-type', 'user-agent', 'origin', 'referer', 'cookie', 'set-cookie',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'access-control-allow-origin', 'access-control-allow-credentials', 'x-content-type-options', 'x-frame-options',
  'x-xss-protection',
]);
const AUTH_LIKE = /auth|token|key|session|signature|api|id$/i;

function rank(name: string): number {
  const lower = name.toLowerCase();
  if (TRANSPORT.has(lower)) return 3;
  if (STANDARD.has(lower)) return 2;
  return AUTH_LIKE.test(lower) ? 0 : 1;
}

/** A call's headers, most useful first: its own and auth-like ones, then standard, transport last. */
export function headerSuggestions(headers: Readonly<Record<string, string>> | null | undefined): readonly NameSuggestion[] {
  return Object.entries(headers ?? {})
    .map(([name, value]) => ({ name, value: String(value ?? '') }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

function headerValue(headers: Readonly<Record<string, string>> | null | undefined, name: string): string | null {
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return found ? String(found[1] ?? '') : null;
}

/** The cookies a request sent (its Cookie header). */
export function requestCookieSuggestions(headers: Readonly<Record<string, string>> | null | undefined): readonly NameSuggestion[] {
  return Object.entries(parseCookieHeader(headerValue(headers, 'cookie'))).map(([name, value]) => ({ name, value }));
}

/**
 * The cookies a response set. Repeated Set-Cookie headers arrive joined with ", " - ambiguous with
 * an Expires date's own comma - so a new cookie only starts where a comma is followed by `name=`.
 */
export function responseCookieSuggestions(headers: Readonly<Record<string, string>> | null | undefined): readonly NameSuggestion[] {
  const raw = headerValue(headers, 'set-cookie');
  if (!raw) return [];
  const out: NameSuggestion[] = [];
  for (const part of raw.split(/\n|,(?=\s*[^=;,\s]+=)/)) {
    const [pair, ...attributes] = part.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name || out.some((c) => c.name === name)) continue;
    const path = attributes.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith('path='));
    out.push({ name, value: pair.slice(eq + 1).trim() + (path ? ` · ${path.toLowerCase()}` : '') });
  }
  return out;
}

/** What a box with this text should offer: names containing it (case-insensitive), in order. */
export function filterSuggestions(all: readonly NameSuggestion[], typed: string): readonly NameSuggestion[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return all;
  const starts = all.filter((s) => s.name.toLowerCase().startsWith(needle));
  const contains = all.filter((s) => !s.name.toLowerCase().startsWith(needle) && s.name.toLowerCase().includes(needle));
  return [...starts, ...contains];
}
