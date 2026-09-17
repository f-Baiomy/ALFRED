import { CallRecord } from '../../core/models/call.model';
import { buildExportNarrative } from './export-narrative';
import { buildWaterfallBands, waterfallAsciiLines, waterfallAxisTicks } from './waterfall';

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

/**
 * A parent with TWO children that are each parents themselves, each with its own children - the
 * case where "which chart expands which row" stops being obvious by eye and the cross-links have to
 * carry it.
 */
function branching(): CallRecord[] {
  return [
    call('root', 0, 20_000),
    call('a', 1_000, 8_000, { service_name: 'core-service' }),
    call('a1', 1_500, 3_000, { source: 'external', service_name: null, url: 'https://x.test/a1' }),
    call('a2', 5_000, 3_000, { source: 'external', service_name: null, url: 'https://x.test/a2' }),
    call('b', 10_000, 8_000, { service_name: 'billing' }),
    call('b1', 10_500, 3_000, { source: 'external', service_name: null, url: 'https://x.test/b1' }),
    call('b2', 14_000, 3_000, { source: 'external', service_name: null, url: 'https://x.test/b2' }),
  ];
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

  it('splits the parent bar into its own work and the stretch it spent waiting', () => {
    // Parent runs 0-10,000 and its one child runs 1,000-8,000, so the parent worked alone for the
    // first 10%, waited for 70%, then worked alone for the last 20%.
    const band = buildWaterfallBands(narrativeOf(nested(4_500)))![0];

    expect(band.ownLeadFraction).toBeCloseTo(0.1, 5);
    expect(band.waitFraction).toBeCloseTo(0.7, 5);
    expect(band.ownTailFraction).toBeCloseTo(0.2, 5);
    expect(band.ownLeadFraction + band.waitFraction + band.ownTailFraction).toBeCloseTo(1, 5);
  });

  it('measures waiting as the envelope of its children, not the sum of them', () => {
    // Two sequential 3s children inside a 7s parent: the gap between them is still waiting, so the
    // wait span must cover both plus the gap, not just 6s of bars.
    const band = buildWaterfallBands(narrativeOf(nested(4_500)))![1];

    expect(band.waitFraction).toBeGreaterThan(band.rows[0].widthFraction + band.rows[1].widthFraction - 0.001);
  });

  it('shows where on the parent its children ran - late fan-out reads differently from early', () => {
    const early = buildWaterfallBands(narrativeOf(nested(1_300)))![0];
    const late = buildWaterfallBands(narrativeOf(nested(6_000)))![0];

    expect(late.waitFraction).toBeGreaterThan(early.waitFraction);
  });

  it('draws the parent row with both tones, and children solid', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);

    expect(lines[1]).toContain('█');
    expect(lines[1]).toContain('░');
    expect(lines[2]).toContain('█');
  });

  it('prints a time axis, so a bar says WHEN and not just how wide', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);

    expect(lines.some((l) => l.includes('┬') || l.includes('┼'))).toBeTrue();
    expect(lines.some((l) => l.includes('10.0s') || l.includes('10s'))).toBeTrue();
  });

  it('captions each band with its span, since bars are only meaningful against it', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);

    expect(lines[0]).toContain('10,000 ms');
    expect(lines[0]).toContain('waiting on the calls below');
  });
});

describe('waterfallAxisTicks', () => {
  it('labels 0/25/50/75/100% of the span', () => {
    expect(waterfallAxisTicks(10_000)).toEqual(['0', '2.5s', '5.0s', '7.5s', '10s']);
  });

  it('switches units rather than printing six figures of milliseconds', () => {
    expect(waterfallAxisTicks(800)).toEqual(['0', '200ms', '400ms', '600ms', '800ms']);
    expect(waterfallAxisTicks(240_000)[4]).toBe('4m0s');
  });

  it('has nothing to label when the span is unknown or zero', () => {
    expect(waterfallAxisTicks(null)).toEqual([]);
    expect(waterfallAxisTicks(0)).toEqual([]);
  });
});

describe('linking a chart to the one it sits inside', () => {
  it('names the parent on a nested band, so a chart is not an island', () => {
    const bands = buildWaterfallBands(narrativeOf(nested(4_500)))!;

    expect(bands[0].parentNumber).toBeNull();
    expect(bands[1].parentNumber).toBe(bands[0].number);
  });

  it('flags the row that is expanded further down', () => {
    const bands = buildWaterfallBands(narrativeOf(nested(4_500)))!;

    // The child has children of its own, so it gets its own chart; the grandchildren are leaves.
    expect(bands[0].rows[0].hasOwnChart).toBeTrue();
    expect(bands[1].rows.every((r) => r.hasOwnChart)).toBeFalse();
  });

  it('says so in the Markdown too, in both directions', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(nested(4_500)))!);

    expect(lines.some((l) => l.includes('charted below'))).toBeTrue();
    expect(lines.some((l) => l.includes('(inside call'))).toBeTrue();
  });
});

describe('a parent with several children that are themselves parents', () => {
  it('gives every branch its own chart, each pointing back at the right parent', () => {
    const bands = buildWaterfallBands(narrativeOf(branching()))!;
    const byNumber = new Map(bands.map((b) => [b.number, b]));

    // root + a + b = three charts; a1/a2/b1/b2 are leaves.
    expect(bands.length).toBe(3);

    const root = bands[0];
    expect(root.parentNumber).toBeNull();
    expect(root.rows.length).toBe(2);
    expect(root.rows.every((r) => r.hasOwnChart)).toBeTrue();

    // Each branch names ITS OWN parent - not merely "some parent", which a single shared
    // root would also satisfy and which is the bug worth guarding.
    for (const row of root.rows) {
      expect(byNumber.get(row.number)!.parentNumber).toBe(root.number);
    }
  });

  it('keeps the two branches independent, each scaled to its own window', () => {
    const bands = buildWaterfallBands(narrativeOf(branching()))!;
    const [, a, b] = bands;

    expect(a.number).not.toBe(b.number);
    expect(a.rows.map((r) => r.number)).not.toEqual(b.rows.map((r) => r.number));
    // Both branches are 8s wide, so a child of the same length occupies the same fraction in each.
    expect(a.spanMs).toBe(b.spanMs);
  });

  it('nests deeper charts further right in the Markdown', () => {
    const lines = waterfallAsciiLines(buildWaterfallBands(narrativeOf(branching()))!);
    const captions = lines.filter((l) => l.includes('· POST') || l.includes('· GET'));

    const rootIndent = captions[0].search(/\S/);
    const branchIndent = captions[1].search(/\S/);
    expect(branchIndent).toBeGreaterThan(rootIndent);
  });
});
