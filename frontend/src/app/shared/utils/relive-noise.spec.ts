import { ClassifyContext, classify, RawDifference } from './relive-noise';

function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    noiseRules: [],
    expected: [],
    variablesUsed: [],
    variablesProduced: [],
    ...overrides,
  };
}

describe('classify', () => {
  it('reproduces the mock.html Supplier B example: 2 unexpected, 1 expected (GLOBAL rule), 1 noise (traceId)', () => {
    const diffs: RawDifference[] = [
      { part: 'body', path: 'body.results', recorded: '12', actual: '11' },
      { part: 'body', path: 'body.cheapest', recorded: '1795', actual: '1860' },
      { part: 'body', path: 'body.currency', recorded: 'USD', actual: 'AED' },
      { part: 'body', path: 'body.traceId', recorded: 'b-7c1e', actual: 'b-99d0' },
    ];

    const result = classify(
      diffs,
      ctx({ expected: [{ path: 'body.currency', cause: 'GLOBAL rule "Currency → AED"' }] }),
    );

    expect(result.filter((d) => d.kind === 'UNEXPECTED').length).toBe(2);
    expect(result.filter((d) => d.kind === 'EXPECTED').length).toBe(1);
    expect(result.filter((d) => d.kind === 'NOISE_AUTO').length).toBe(1);
    expect(result.find((d) => d.path === 'body.currency')?.cause).toBe('GLOBAL rule "Currency → AED"');
    expect(result.find((d) => d.path === 'body.traceId')?.cause).toBe('trace id');
  });

  it('classifies an ISO timestamp field as noise', () => {
    const result = classify(
      [{ part: 'body', path: 'body.requestTime', recorded: '2026-09-26T10:00:04Z', actual: '2026-09-27T14:30:11Z' }],
      ctx(),
    );
    expect(result[0].kind).toBe('NOISE_AUTO');
    expect(result[0].cause).toBe('timestamp');
  });

  it('classifies a UUID-shaped value as a generated id', () => {
    const result = classify(
      [
        {
          part: 'body',
          path: 'body.sessionRef',
          recorded: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          actual: '9c858901-8a57-4791-81fe-4c455b099bc9',
        },
      ],
      ctx(),
    );
    expect(result[0].kind).toBe('NOISE_AUTO');
    expect(result[0].cause).toBe('generated id');
  });

  it('classifies a Date/ETag response header as noise', () => {
    const result = classify([{ part: 'header', path: 'ETag', recorded: 'W/"1"', actual: 'W/"2"' }], ctx());
    expect(result[0].kind).toBe('NOISE_AUTO');
  });

  it('classifies a value equal to a substituted variable as EXPECTED', () => {
    const result = classify(
      [{ part: 'body', path: 'body.bookingId', recorded: 'BK-1', actual: 'BK-6004' }],
      ctx({ variablesUsed: [{ name: 'bookingId', value: 'BK-6004' }] }),
    );
    expect(result[0].kind).toBe('EXPECTED');
    expect(result[0].cause).toBe('you substituted {{bookingId}}');
  });

  it('classifies a value equal to an extracted variable as EXPECTED', () => {
    const result = classify(
      [{ part: 'body', path: 'body.searchId', recorded: 'S-1', actual: 'S-90417' }],
      ctx({ variablesProduced: [{ name: 'searchId', value: 'S-90417' }] }),
    );
    expect(result[0].kind).toBe('EXPECTED');
    expect(result[0].cause).toBe('you extracted {{searchId}}');
  });

  it('marks a matching user NoiseRule as NOISE_USER', () => {
    const result = classify(
      [{ part: 'body', path: 'body.debugId', recorded: 'a', actual: 'b' }],
      ctx({ noiseRules: [{ part: 'body', path: 'body.debugId', auto: false, count: false }] }),
    );
    expect(result[0].kind).toBe('NOISE_USER');
  });

  it('a NoiseRule with count:true overrides an auto-noise decision back to UNEXPECTED', () => {
    const result = classify(
      [{ part: 'body', path: 'body.traceId', recorded: 'b-7c1e', actual: 'b-99d0' }],
      ctx({ noiseRules: [{ part: 'body', path: 'body.traceId', auto: true, count: true }] }),
    );
    expect(result[0].kind).toBe('UNEXPECTED');
    expect(result[0].cause).toBeNull();
  });

  it('falls through to UNEXPECTED when nothing explains the difference', () => {
    const result = classify([{ part: 'body', path: 'body.flights', recorded: '12', actual: '9' }], ctx());
    expect(result[0].kind).toBe('UNEXPECTED');
    expect(result[0].cause).toBeNull();
  });
});
