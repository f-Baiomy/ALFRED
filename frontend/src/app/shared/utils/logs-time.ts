/**
 * Times in a source's own display zone (FR-044). Intl formatters are cached per zone because the
 * list formats thousands of rows.
 */
const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string, withDate: boolean): Intl.DateTimeFormat {
  const key = `${zone}|${withDate}`;
  let f = cache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour12: false,
        ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3,
      });
    } catch {
      f = formatter('UTC', withDate);
    }
    cache.set(key, f);
  }
  return f;
}

/** "23:55:57.720" in the given zone. */
export function formatLogTime(ms: number, zone: string): string {
  return formatter(zone, false).format(new Date(ms));
}

/** "01/10/2026, 23:55:57.720" in the given zone. */
export function formatLogDateTime(ms: number, zone: string): string {
  return formatter(zone, true).format(new Date(ms));
}

/** Hover text: the same instant in UTC (ISO), so the raw value is always one glance away. */
export function utcHint(ms: number): string {
  return `${new Date(ms).toISOString()} (UTC)`;
}

/** "6.2 s" / "412 ms" for the duration column. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
