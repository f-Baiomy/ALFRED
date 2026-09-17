import { CallRecord } from '../../core/models/call.model';
import { buildExportNarrative } from './export-narrative';
import { buildWaterfallBands, waterfallAsciiLines } from './waterfall';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(id: string, startMs: number, durationMs: number, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    original_url: `http://localhost:9001/${id}`,
    url: `http://host.docker.internal:8080/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200, headers: {}, body: '{}' },
    state: 'COMPLETED',
    source: 'internal',
    service_name: 'odeysys',
    ...extra,
  };
}

function narrativeOf(calls: readonly CallRecord[]) {
  return buildExportNarrative({ calls, commentsByCallId: new Map() });
}

/** The shape from a real capture: a parent, an inbound child, and two outbound grandchildren. */
function nested(secondChildStart: number): CallRecord[] {
  return [
    call('parent', 0, 10_000),
    call('child', 1_000, 7_000, { service_name: 'core-service' }),
    call('g1', 1_200, 3_000, { source: 'external', service_name: null, url: 'https://sabre.test/getBooking' }),
    call('g2', secondChildStart, 3_000, { source: 'external', service_name: null, url: 'https://sabre.test/checkTickets' }),
  ];
}

describe('buildWaterfallBands', () => {
  it('returns null for a flat capture - with no parent there is no window to draw anything inside', () => {
    const flat = [call('a', 0, 100), call('b', 500, 100), call('c', 1_000, 100)];

    expect(buildWaterfallBands(narrativeOf(flat))).toBeNull();
  });

  it('emits one band per call that caused others, not one row per call', () => {
    const bands = buildWaterfallBands(narrativeOf(nested(4_500)))!;

    // parent -> [child], and child -> [g1, g2]. The grandchildren are leaves and start no band.
    expect(bands.length).toBe(2);
    expect(bands[0].rows.length).toBe(1);
    expect(bands[1].rows.length).toBe(2);
  });

  /**
   * The reason this feature exists. Two siblings that run back to back look identical to two that
   * run together if you only have durations - both are "3,000 ms" twice. Their positions are the
   * only thing that distinguishes them, and the difference is whether the parent could be ~3s faster.
   */
  it('separates sequential siblings, which durations alone cannot', () => {
    const band = buildWaterfallBands(narrativeOf(nested(4_500)))![1];
    const [g1, g2] = band.rows;

    expect(g2.startFraction).toBeGreaterThan(g1.startFraction + g1.widthFraction - 0.001);
  });

  it('overlaps parallel siblings, so they read differently from sequential ones', () => {
    const band = buildWaterfallBands(narrativeOf(nested(1_300)))![1];
    const [g1, g2] = band.rows;

    expect(g2.startFraction).toBeLessThan(g1.startFraction + g1.widthFraction);
  });

  /**
   * Why bands exist at all. Scaled against the 10s root, the grandchildren would sit within ~1% of
   * each other and render identically - which is what the single-axis version actually did on a real
   * 248,852ms export. Scaled against their own 7s parent they are plainly sequential.
   */
  it('scales children against their own parent, not the root', () => {
    const bands = buildWaterfallBands(narrativeOf(nested(4_500)))!;

    expect(bands[1].spanMs).toBe(7_000);
    const [g1, g2] = bands[1].rows;
    expect(g2.startFraction - g1.startFraction).toBeGreaterThan(0.3);
  });

  it('keeps a very short call visible rather than drawing nothing', () => {
    const calls = [...nested(4_500), call('tiny', 2_000, 20, { source: 'external', service_name: null })];
    const bands = buildWaterfallBands(narrativeOf(calls))!;
    const tiny = bands.flatMap((b) => b.rows).find((r) => r.label.includes('tiny'));

    expect(tiny!.widthFraction).toBeGreaterThanOrEqual(0.01);
  });

  it('never lets a bar run past the end of its track', () => {
    for (const band of buildWaterfallBands(narrativeOf(nested(4_500)))!) {
      for (const row of band.rows) {
        expect(row.startFraction).toBeGreaterThanOrEqual(0);
        expect(row.startFraction + row.widthFraction).toBeLessThanOrEqual(1.0001);
      }
    }
  });

  it('states each band own span, so a bar cannot be read against the wrong scale', () => {
    const bands = buildWaterfallBands(narrativeOf(nested(4_500)))!;

    expect(bands[0].spanMs).toBe(10_000);
    expect(bands[0].downstreamMs).toBe(7_000);
  });
});

describe('waterfallAsciiLines', () => {
  it('draws a later sibling further right than an earlier one', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);
    const bars = lines.filter((l) => l.includes('|'));
    const barStart = (line: string) => line.indexOf('█');

    // last band: g1 then g2, sequential
    expect(barStart(bars[bars.length - 1])).toBeGreaterThan(barStart(bars[bars.length - 2]));
  });

  it('keeps every bar row the same width, so the chart stays aligned in a code fence', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);
    const bars = lines.filter((l) => l.includes('|'));

    expect(new Set(bars.map((l) => l.indexOf('|'))).size).toBe(1);
  });

  it('captions each band with its span, since bars are only meaningful against it', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);

    expect(lines[0]).toContain('10,000 ms');
    expect(lines[0]).toContain('waiting on the calls below');
  });
});
