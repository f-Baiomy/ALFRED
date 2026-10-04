/**
 * Time-range helpers for the Logs time panel: wall-clock parts of an instant in a zone and back, ranges
 * typed in words, lengths in words, stepping a range. Pure - no Angular - so they are tested directly.
 *
 * A "zone" is an IANA name: the source's own display zone (usually UTC) or this computer's
 * (`localZone()`). Everything is stored and searched in epoch milliseconds; zones only change how a
 * moment reads and how typed wall-clock times are turned into moments.
 */

export interface WallClock {
  readonly Y: number;
  /** 0-11 */
  readonly M: number;
  readonly D: number;
  readonly h: number;
  readonly m: number;
  readonly s: number;
  /** 0 = Sunday */
  readonly dow: number;
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const fmts = new Map<string, Intl.DateTimeFormat>();
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** "UTC+03:00" for a zone at a moment (daylight saving included). */
export function zoneOffsetText(zone: string, at = Date.now()): string {
  const p = wallClock(at, zone);
  const off = Math.round((Date.UTC(p.Y, p.M, p.D, p.h, p.m, p.s) - Math.floor(at / 1000) * 1000) / 60_000);
  const a = Math.abs(off);
  return `UTC${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function wallClock(ms: number, zone: string): WallClock {
  let f = fmts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    fmts.set(zone, f);
  }
  const o: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { Y: +o['year'], M: +o['month'] - 1, D: +o['day'], h: +o['hour'] % 24, m: +o['minute'], s: +o['second'], dow: DOW[o['weekday']] ?? 0 };
}

/** The moment a wall-clock time names in a zone (two passes settle daylight-saving edges). */
export function fromWallClock(Y: number, M: number, D: number, h: number, m: number, s: number, zone: string): number {
  const want = Date.UTC(Y, M, D, h, m, s);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = wallClock(t, zone);
    t += want - Date.UTC(p.Y, p.M, p.D, p.h, p.m, p.s);
  }
  return t;
}

export function startOfDay(ms: number, zone: string): number {
  const p = wallClock(ms, zone);
  return fromWallClock(p.Y, p.M, p.D, 0, 0, 0, zone);
}

export function endOfDay(ms: number, zone: string): number {
  const p = wallClock(ms, zone);
  return fromWallClock(p.Y, p.M, p.D, 23, 59, 59, zone);
}

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthName(M: number): string {
  return MON[M];
}

/** "14 Sep 2026" */
export function dayText(ms: number, zone: string): string {
  const p = wallClock(ms, zone);
  return `${p.D} ${MON[p.M]} ${p.Y}`;
}

/** "09:30:15" */
export function clockText(ms: number, zone: string): string {
  const p = wallClock(ms, zone);
  return `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
}

/** "2026-09-14 09:30:15" */
export function fullText(ms: number, zone: string): string {
  const p = wallClock(ms, zone);
  return `${p.Y}-${pad(p.M + 1)}-${pad(p.D)} ${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`;
}

/** "2 h 30 min", "7 days 23 h 59 min 59 s", "0 s". */
export function lengthText(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return [d && `${d} day${d === 1 ? '' : 's'}`, h && `${h} h`, m && `${m} min`, x && `${x} s`].filter(Boolean).join(' ') || '0 s';
}

export interface Span {
  readonly from: number;
  readonly to: number;
}

/**
 * A range typed in words, in `zone`: "last 90 minutes" / "last 2 h" / "last 3 days" (back from `newest`),
 * "today", "yesterday", "today 14:00 to 16:30", "yesterday 9:00 to 12:00",
 * "2026-10-04 09:00 to 12:00", "2026-10-04 09:00 to 2026-10-05 18:00:30".
 * null = empty text, undefined = not understood.
 */
export function parseRangeWords(text: string, zone: string, newest: number, now = Date.now()): Span | null | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^last\s+(\d+)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hours?|d|days?)$/))) {
    const n = +m[1];
    const u = m[2][0];
    const ms = n * (u === 's' ? 1000 : u === 'm' ? 60_000 : u === 'h' ? HOUR : DAY);
    return { from: newest - ms, to: newest };
  }
  const today = startOfDay(now, zone);
  const yesterday = startOfDay(today - 12 * HOUR, zone);
  if (t === 'today') return { from: today, to: endOfDay(today, zone) };
  if (t === 'yesterday') return { from: yesterday, to: endOfDay(yesterday, zone) };
  const time = (x: string): [number, number, number] | null => {
    const r = x.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    return r && +r[1] < 24 && +r[2] < 60 && +(r[3] ?? 0) < 60 ? [+r[1], +r[2], +(r[3] ?? 0)] : null;
  };
  if ((m = t.match(/^(today|yesterday)\s+(\S+)\s+to\s+(\S+)$/))) {
    const base = wallClock(m[1] === 'today' ? today : yesterday, zone);
    const a = time(m[2]);
    const b = time(m[3]);
    if (a && b) return { from: fromWallClock(base.Y, base.M, base.D, ...a, zone), to: fromWallClock(base.Y, base.M, base.D, ...b, zone) };
    return undefined;
  }
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\S+)\s+to\s+(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\S+)$/))) {
    const a = time(m[4]);
    const b = time(m[8]);
    if (!a || !b) return undefined;
    return {
      from: fromWallClock(+m[1], +m[2] - 1, +m[3], ...a, zone),
      to: fromWallClock(+(m[5] ?? m[1]), +(m[6] ?? m[2]) - 1, +(m[7] ?? m[3]), ...b, zone),
    };
  }
  return undefined;
}

/** The previous (-1) or next (+1) window of the same length; windows touch, never overlap or leave a gap. */
export function stepSpan(span: Span, dir: number): Span {
  const len = span.to - span.from;
  return { from: span.from + dir * len, to: span.to + dir * len };
}
