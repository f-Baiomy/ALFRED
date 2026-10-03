import { formatDuration, formatLogTime, utcHint } from './logs-time';

describe('logs-time', () => {
  const ms = Date.UTC(2026, 9, 1, 23, 55, 57, 720);

  it('formats in the source zone, not the browser zone', () => {
    expect(formatLogTime(ms, 'UTC')).toBe('23:55:57.720');
    expect(formatLogTime(ms, 'Asia/Dubai')).toBe('03:55:57.720');
    expect(formatLogTime(ms, 'Not/AZone')).toBe('23:55:57.720');
  });

  it('keeps the UTC instant on hover and formats durations', () => {
    expect(utcHint(ms)).toBe('2026-10-01T23:55:57.720Z (UTC)');
    expect(formatDuration(6183)).toBe('6.2 s');
    expect(formatDuration(412)).toBe('412 ms');
    expect(formatDuration(null)).toBe('');
  });
});
