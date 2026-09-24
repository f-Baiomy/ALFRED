import { relativeTime } from './relative-time';

describe('relativeTime', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');

  it('reads seconds as just now', () => {
    expect(relativeTime('2026-09-24T11:59:30Z', now)).toBe('just now');
  });

  it('reads minutes, hours and days', () => {
    expect(relativeTime('2026-09-24T11:57:00Z', now)).toBe('3 min ago');
    expect(relativeTime('2026-09-24T10:00:00Z', now)).toBe('2 h ago');
    expect(relativeTime('2026-09-20T12:00:00Z', now)).toBe('4 d ago');
  });

  it('never reads a clock-skewed future time as negative', () => {
    expect(relativeTime('2026-09-24T12:00:10Z', now)).toBe('just now');
  });

  it('gives back what it cannot parse', () => {
    expect(relativeTime('not a date', now)).toBe('not a date');
  });
});
