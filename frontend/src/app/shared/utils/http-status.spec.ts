import { customStatusFrom, isKnownStatus, isValidStatus, searchStatuses, statusLabel } from './http-status';

describe('http status', () => {
  it('labels a known status with its phrase and an unknown one with just the number', () => {
    expect(statusLabel(503)).toBe('503 Service Unavailable');
    expect(statusLabel(599)).toBe('599');
    expect(statusLabel(null)).toBe('');
  });

  it('finds a status by its code or by its words', () => {
    // The thing a user knows is "service unavailable", not that it is 503 - searching only by
    // number would make the picker no better than the text box it replaced.
    const codes = (query: string) => searchStatuses(query).flatMap((g) => g.statuses.map((s) => s.code));

    expect(codes('503')).toEqual([503]);
    expect(codes('unavail')).toEqual([503]);
    expect(codes('SERVICE')).toEqual([503]);
    expect(codes('timeout')).toEqual([408, 504]);
  });

  it('drops groups with nothing left in them rather than leaving empty headings', () => {
    expect(searchStatuses('teapot')).toEqual([]);
    expect(searchStatuses('').length).toBeGreaterThan(3);
  });

  it('offers a typed three-digit code that is not in the list', () => {
    // A supplier answering 599 is exactly the case worth reproducing, so it must not be the
    // awkward path.
    expect(customStatusFrom('599')).toBe(599);
    expect(customStatusFrom(' 418 ')).toBe(418);
  });

  it('does not offer a custom code for something already listed, or for nonsense', () => {
    expect(customStatusFrom('503')).toBeNull();
    expect(customStatusFrom('99')).toBeNull();
    expect(customStatusFrom('6000')).toBeNull();
    expect(customStatusFrom('unavailable')).toBeNull();
  });

  it('accepts the whole wire range, not only the codes it lists', () => {
    expect(isValidStatus(599)).toBeTrue();
    expect(isKnownStatus(599)).toBeFalse();
    expect(isValidStatus(99)).toBeFalse();
    expect(isValidStatus(600)).toBeFalse();
    expect(isValidStatus(null)).toBeFalse();
  });
});
