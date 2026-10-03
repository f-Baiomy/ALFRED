/**
 * What keeps an Automatic Relive run logged in: the recorded requests carry yesterday's session
 * cookie and token, and the app answers them with "please log in". Two mechanisms, both applied
 * to a step's request right before it is sent, neither touching the stored recording:
 *
 *  - a cookie jar for the run: every Set-Cookie a step receives replaces that cookie in later
 *    steps' Cookie header, the way the browser that made the recording did;
 *  - value swaps: an extraction that remembers the value its recording had (`recordedValue`) puts
 *    the value this run produced wherever the recorded one appears in a later step - URL, headers
 *    or body - so a token handed from Login to every later call needs no edit to those calls.
 *
 * The proxy does the reverse of the swaps for a REPLAY supplier call's "matches the recording"
 * test (`interception.unswap_values`), so the same value counts as unchanged on both sides.
 */
import { setCookies } from './resend-draft-chain';
import { StepResult } from './relive-types';

/** host -> cookie name -> value this run holds. A cookie the server cleared is held as `null`. */
export type CookieJar = Map<string, Map<string, string | null>>;

export interface ValueSwap {
  readonly name: string;
  readonly recorded: string;
  readonly current: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Takes in every cookie a response to `url` set or cleared. */
export function absorbSetCookies(jar: CookieJar, url: string, headers: Readonly<Record<string, string>> | null | undefined): void {
  if (!headers) return;
  const cookies = setCookies(headers);
  if (!cookies.length) return;
  const host = hostOf(url);
  const held = jar.get(host) ?? new Map<string, string | null>();
  for (const cookie of cookies) held.set(cookie.name, cookie.cleared ? null : cookie.value);
  jar.set(host, held);
}

export interface CookieApplied {
  readonly headers: Record<string, string>;
  /** Cookie names whose value came from the jar, not the recording. */
  readonly carried: readonly string[];
}

/** `headers` with the Cookie header the run's jar implies for `url`: held cookies replace the
 *  recorded ones, cleared ones are dropped, and ones the recording did not send are added. */
export function applyCookieJar(jar: CookieJar, url: string, headers: Readonly<Record<string, string>>): CookieApplied {
  const held = jar.get(hostOf(url));
  if (!held || held.size === 0) return { headers: { ...headers }, carried: [] };
  const headerName = Object.keys(headers).find((name) => name.toLowerCase() === 'cookie');
  const recorded = headerName ? headers[headerName] : '';
  const pairs: [string, string][] = [];
  for (const part of recorded.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    pairs.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  const carried: string[] = [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [name, value] of pairs) {
    seen.add(name);
    if (!held.has(name)) {
      out.push(`${name}=${value}`);
      continue;
    }
    const current = held.get(name);
    if (current === null || current === undefined) continue;
    out.push(`${name}=${current}`);
    if (current !== value) carried.push(name);
  }
  for (const [name, value] of held) {
    if (seen.has(name) || value === null) continue;
    out.push(`${name}=${value}`);
    carried.push(name);
  }
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name !== headerName) next[name] = value;
  }
  if (out.length) next[headerName ?? 'Cookie'] = out.join('; ');
  return { headers: next, carried };
}

/** The swaps a run can make now: extractions that remember a recorded value and whose variable
 *  holds a different value in this run. */
export function valueSwaps(
  steps: readonly { readonly extract: readonly { readonly as: string; readonly recordedValue?: string }[] }[],
  vars: Readonly<Record<string, string>>,
): ValueSwap[] {
  const swaps: ValueSwap[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const rule of step.extract) {
      const recorded = rule.recordedValue;
      const current = vars[rule.as];
      if (!recorded || seen.has(rule.as) || current === undefined || current === '' || current === recorded) continue;
      seen.add(rule.as);
      swaps.push({ name: rule.as, recorded, current });
    }
  }
  return swaps;
}

export interface SwapResult {
  readonly text: string;
  readonly swapped: readonly string[];
}

/** `text` with each recorded value replaced by this run's value, also in URL-encoded form.
 *  Longest recorded value first, so one that contains a shorter one is replaced whole. */
export function swapRecordedValues(text: string, swaps: readonly ValueSwap[]): SwapResult {
  if (!text || !swaps.length) return { text, swapped: [] };
  let result = text;
  const swapped: string[] = [];
  for (const swap of [...swaps].sort((a, b) => b.recorded.length - a.recorded.length)) {
    const before = result;
    result = result.split(swap.recorded).join(swap.current);
    const encoded = encodeURIComponent(swap.recorded);
    if (encoded !== swap.recorded) result = result.split(encoded).join(encodeURIComponent(swap.current));
    if (result !== before) swapped.push(swap.name);
  }
  return { text: result, swapped };
}

/** What the run service's `prepareSession` did to a step's request - stored on the step result (`editsApplied`). */
export interface SessionApplied {
  /** Variables whose run value replaced the recorded value somewhere in the request. */
  readonly swapped: readonly string[];
  /** Cookies sent with the value an earlier step's response set, not the recorded one. */
  readonly cookies: readonly string[];
}

/** A step result's `SessionApplied`, or null for one stored before it or with nothing to say. */
export function sessionAppliedOf(result: StepResult | null | undefined): SessionApplied | null {
  const raw = (result?.editsApplied as { session?: SessionApplied } | null | undefined)?.session;
  if (!raw || (!raw.swapped?.length && !raw.cookies?.length)) return null;
  return { swapped: raw.swapped ?? [], cookies: raw.cookies ?? [] };
}
