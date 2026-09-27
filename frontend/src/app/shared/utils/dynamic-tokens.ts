/**
 * Dynamic `{{$...}}` tokens - the frontend's copy of the grammar in
 * specs/002-power-features/contracts.md section 4. The proxy (interception.py) and the resend
 * backend (ResendService) implement the same grammar; all three are held to
 * specs/002-power-features/dynamic-token-vectors.json, so a token previews here exactly as it
 * will be sent. Anything the grammar does not recognise is left literal.
 */
export const DYNAMIC_TOKEN = /\{\{\$([A-Za-z][A-Za-z0-9]*)((?:[+-]\d{1,6}[smhd])?)(?::([^{}]*))?\}\}/g;

const RANDOM_LIMIT = 1e12;
const OFFSET_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function resolveDynamicTokens(
  text: string,
  lookup: (name: string) => string | undefined,
  now: Date = new Date(),
  rng: () => number = Math.random,
): string {
  if (!text || !text.includes('{{$')) return text;
  return text.replace(DYNAMIC_TOKEN, (token, fn: string, offset: string, arg: string | undefined) => {
    const out = resolveOne(fn, offset, arg, lookup, now, rng);
    return out ?? token;
  });
}

function resolveOne(fn: string, offset: string, arg: string | undefined, lookup: (name: string) => string | undefined,
                    now: Date, rng: () => number): string | null {
  if (fn === 'now') {
    let ms = now.getTime();
    if (offset) ms += Number(offset.slice(0, -1)) * OFFSET_MS[offset.slice(-1)];
    return formatNow(new Date(ms), arg);
  }
  if (offset) return null;
  if (fn === 'uuid') return arg === undefined ? uuid(rng) : null;
  if (fn === 'randomInt') {
    const parts = (arg ?? '').split(':');
    if (parts.length !== 2 || !parts.every((p) => /^-?\d+$/.test(p))) return null;
    const [min, max] = parts.map(Number);
    if (min > max || Math.abs(min) > RANDOM_LIMIT || Math.abs(max) > RANDOM_LIMIT) return null;
    return String(min + Math.floor(rng() * (max - min + 1)));
  }
  if (fn === 'base64') {
    if (!arg) return null;
    const value = lookup(arg);
    return value === undefined ? null : base64Utf8(value);
  }
  return null;
}

function formatNow(date: Date, pattern: string | undefined): string {
  if (pattern === undefined) return date.toISOString();
  if (pattern === 'epoch') return String(Math.floor(date.getTime() / 1000));
  if (pattern === 'epochMs') return String(date.getTime());
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const parts: Record<string, string> = {
    yyyy: pad(date.getUTCFullYear(), 4), MM: pad(date.getUTCMonth() + 1, 2), dd: pad(date.getUTCDate(), 2),
    HH: pad(date.getUTCHours(), 2), mm: pad(date.getUTCMinutes(), 2), ss: pad(date.getUTCSeconds(), 2),
    SSS: pad(date.getUTCMilliseconds(), 3),
  };
  // Longest letters first, scanned left to right, so "yyyy" is never read as "yy" + "yy".
  return pattern.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (letters) => parts[letters]);
}

function uuid(rng: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
