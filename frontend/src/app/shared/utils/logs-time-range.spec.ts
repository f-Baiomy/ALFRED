import { DAY, HOUR, endOfDay, fromWallClock, fullText, lengthText, parseRangeWords, startOfDay, stepSpan, wallClock, zoneOffsetText } from './logs-time-range';

describe('logs-time-range', () => {
  const T = Date.UTC(2026, 9, 4, 9, 30, 15); // 2026-10-04 09:30:15 UTC

  it('reads and builds wall-clock times in any zone', () => {
    expect(wallClock(T, 'UTC')).toEqual(jasmine.objectContaining({ Y: 2026, M: 9, D: 4, h: 9, m: 30, s: 15 }));
    expect(wallClock(T, 'Asia/Dubai')).toEqual(jasmine.objectContaining({ h: 13, m: 30 }));
    expect(fromWallClock(2026, 9, 4, 13, 30, 15, 'Asia/Dubai')).toBe(T);
    expect(fromWallClock(2026, 9, 4, 9, 30, 15, 'UTC')).toBe(T);
    expect(fullText(T, 'Africa/Cairo')).toBe('2026-10-04 12:30:15');
    expect(zoneOffsetText('Asia/Dubai', T)).toBe('UTC+04:00');
    expect(zoneOffsetText('UTC', T)).toBe('UTC+00:00');
  });

  it('finds the start and end of a day in a zone', () => {
    expect(startOfDay(T, 'Asia/Dubai')).toBe(Date.UTC(2026, 9, 3, 20, 0, 0));
    expect(endOfDay(T, 'UTC')).toBe(Date.UTC(2026, 9, 4, 23, 59, 59));
  });

  it('says a length in words', () => {
    expect(lengthText(2.5 * HOUR)).toBe('2 h 30 min');
    expect(lengthText(8 * DAY - 1000)).toBe('7 days 23 h 59 min 59 s');
    expect(lengthText(0)).toBe('0 s');
  });

  it('understands ranges typed in words', () => {
    const newest = T;
    expect(parseRangeWords('last 90 minutes', 'UTC', newest)).toEqual({ from: newest - 90 * 60_000, to: newest });
    expect(parseRangeWords('Last 2 h', 'UTC', newest)).toEqual({ from: newest - 2 * HOUR, to: newest });
    expect(parseRangeWords('today', 'UTC', newest, T)).toEqual({ from: Date.UTC(2026, 9, 4), to: Date.UTC(2026, 9, 4, 23, 59, 59) });
    expect(parseRangeWords('yesterday 14:00 to 16:30', 'UTC', newest, T)).toEqual({ from: Date.UTC(2026, 9, 3, 14), to: Date.UTC(2026, 9, 3, 16, 30) });
    expect(parseRangeWords('2026-10-04 09:00 to 12:00', 'Asia/Dubai', newest)).toEqual({ from: Date.UTC(2026, 9, 4, 5), to: Date.UTC(2026, 9, 4, 8) });
    expect(parseRangeWords('2026-10-04 09:00 to 2026-10-05 18:00:30', 'UTC', newest)).toEqual({ from: Date.UTC(2026, 9, 4, 9), to: Date.UTC(2026, 9, 5, 18, 0, 30) });
    expect(parseRangeWords('', 'UTC', newest)).toBeNull();
    expect(parseRangeWords('sometime soon', 'UTC', newest)).toBeUndefined();
    expect(parseRangeWords('today 25:00 to 26:00', 'UTC', newest)).toBeUndefined();
  });

  it('steps a range to the window before or after it, edge to edge', () => {
    const s = { from: Date.UTC(2026, 9, 4, 10), to: Date.UTC(2026, 9, 4, 12) };
    expect(stepSpan(s, 1)).toEqual({ from: Date.UTC(2026, 9, 4, 12), to: Date.UTC(2026, 9, 4, 14) });
    expect(stepSpan(s, -1)).toEqual({ from: Date.UTC(2026, 9, 4, 8), to: Date.UTC(2026, 9, 4, 10) });
  });
});
