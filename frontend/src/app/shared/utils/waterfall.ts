import { NarrativeCallNode, ExportNarrative } from './export-narrative';

/**
 * The export's waterfall: for each call that caused other calls, where its children sat inside its
 * window.
 *
 * The tree in "Who called whom" already says who called whom. What it cannot say is whether two
 * children ran side by side or one after the other - and that is usually the question worth asking.
 * On a real capture two siblings of 3,038ms and 4,101ms sum to exactly their parent's 7,212ms of
 * downstream time, which means strictly sequential, which means that parent could have been ~3s
 * faster. A list of durations hides that completely.
 *
 * Drawn as one band PER PARENT, each scaled to that parent's own window, rather than as a single
 * chart on one shared axis. A shared axis was the obvious design and it does not survive real data:
 * measured on an actual export, the root call runs 248,852ms while the children worth looking at
 * live in a 7,212ms window inside it, so every child collapsed to the same single indistinguishable
 * character and the chart conveyed strictly less than the duration column beside it. Per-parent
 * bands cost a line of context each and make the sequencing obvious. Each band states its own span,
 * so no reader has to guess what the track represents.
 */
export interface WaterfallRow {
  readonly number: number;
  readonly label: string;
  /** Colours the bar - an inbound call into one of our services reads differently from an outbound one to a third party. */
  readonly direction: 'inbound' | 'outbound';
  readonly durationMs: number | null;
  /** 0-1 across the PARENT's window - see the band this row belongs to. */
  readonly startFraction: number;
  readonly widthFraction: number;
  readonly status: number | null;
  readonly error: string | null;
  readonly inProgress: boolean;
}

export interface WaterfallBand {
  readonly number: number;
  readonly label: string;
  readonly direction: 'inbound' | 'outbound';
  readonly depth: number;
  /** The window every row in this band is drawn against. */
  readonly spanMs: number | null;
  /** How much of `spanMs` the parent spent waiting on these children (union, not sum). */
  readonly downstreamMs: number | null;
  /**
   * The parent's own bar, split into the three things it was actually doing: its own work before
   * anything downstream started, the stretch where children were in flight, and its own work after
   * the last one came back. Drawn on the parent row so you can see WHERE on the parent its children
   * sit - a parent whose children run at the very end reads completely differently from one that
   * fans out immediately, and the plain full-width bar said neither.
   */
  readonly ownLeadFraction: number;
  readonly waitFraction: number;
  readonly ownTailFraction: number;
  readonly rows: readonly WaterfallRow[];
}

/** So a very short call is still a visible mark rather than nothing at all. */
const MIN_WIDTH_FRACTION = 0.01;

function labelOf(node: NarrativeCallNode): string {
  const who = node.service ?? node.host ?? 'unknown';
  return `${node.method} ${who} /${node.path}`;
}

function rowFor(child: NarrativeCallNode, parent: NarrativeCallNode): WaterfallRow {
  const span = parent.durationMs && parent.durationMs > 0 ? parent.durationMs : null;
  const parentStart = parent.startOffsetMs;
  const start = child.startOffsetMs;

  const startFraction =
    span != null && start != null && parentStart != null
      ? Math.min(1, Math.max(0, (start - parentStart) / span))
      : 0;
  const rawWidth = span != null && child.durationMs != null ? child.durationMs / span : 1;

  return {
    number: child.number,
    label: labelOf(child),
    direction: child.direction,
    durationMs: child.durationMs,
    startFraction,
    widthFraction: Math.min(1 - startFraction, Math.max(MIN_WIDTH_FRACTION, rawWidth)),
    status: child.status,
    error: child.error,
    inProgress: child.inProgress,
  };
}

function bandsOf(node: NarrativeCallNode): WaterfallBand[] {
  if (node.children.length === 0) return [];

  const rows = node.children.map((child) => rowFor(child, node));
  // The span from the first child starting to the last one finishing. Deliberately the outer
  // envelope rather than the sum: between two sequential children the parent is still waiting, not
  // working, so counting only the bars would overstate its own work.
  const firstStart = Math.min(...rows.map((row) => row.startFraction));
  const lastEnd = Math.max(...rows.map((row) => row.startFraction + row.widthFraction));

  const band: WaterfallBand = {
    number: node.number,
    label: labelOf(node),
    direction: node.direction,
    depth: node.depth,
    spanMs: node.durationMs,
    downstreamMs: node.downstreamMs,
    ownLeadFraction: Math.max(0, firstStart),
    waitFraction: Math.max(0, lastEnd - firstStart),
    ownTailFraction: Math.max(0, 1 - lastEnd),
    rows,
  };

  return [band, ...node.children.flatMap(bandsOf)];
}

/** Null for a flat capture - with no parent anywhere there is no window to draw anything inside. */
export function buildWaterfallBands(narrative: ExportNarrative): readonly WaterfallBand[] | null {
  const bands = narrative.topology.flatMap(bandsOf);
  return bands.length > 0 ? bands : null;
}

export function waterfallFormatMs(ms: number | null): string {
  if (ms == null) return '—';
  const hasFraction = Math.abs(ms % 1) > 1e-9;
  return `${ms.toLocaleString('en-US', { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })} ms`;
}

export function waterfallStatusText(row: WaterfallRow): string {
  if (row.error) return 'ERR';
  if (row.inProgress) return '...';
  return row.status != null ? String(row.status) : '?';
}

/** One line of prose per band, stating what the track is scaled to so the bars can't be misread. */
export function waterfallBandCaption(band: WaterfallBand): string {
  const span = waterfallFormatMs(band.spanMs);
  const waiting =
    band.downstreamMs != null ? `, of which ${waterfallFormatMs(band.downstreamMs)} waiting on the calls below` : '';
  return `Call ${band.number} · ${band.label} — ${span}${waiting}`;
}

/**
 * Tick labels along a band's own span, at 0/25/50/75/100%. A Gantt without an axis is a picture of
 * relative widths: it can say "this one is wider" but not "this started four seconds in", which is
 * usually the thing being reconstructed from a capture.
 */
export function waterfallAxisTicks(spanMs: number | null): string[] {
  if (spanMs == null || spanMs <= 0) return [];
  return [0, 0.25, 0.5, 0.75, 1].map((f) => compactMs(spanMs * f));
}

/** Short enough to sit under a tick without colliding with its neighbours. */
function compactMs(ms: number): string {
  if (ms === 0) return '0';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

const TRACK_CHARS = 38;
const LABEL_CHARS = 40;

/**
 * The Markdown rendering: a monospace chart, because Markdown cannot draw a real bar. Goes in a code
 * fence so proportional fonts and Markdown's table rules can't reflow the alignment it depends on.
 */
export function waterfallAsciiLines(bands: readonly WaterfallBand[]): string[] {
  const lines: string[] = [];
  const pad = ' '.repeat(LABEL_CHARS);

  bands.forEach((band, index) => {
    if (index > 0) lines.push('');
    lines.push(waterfallBandCaption(band));

    // The parent's own span as the top bar, so the children read as sub-tasks inside it rather than
    // as free-floating bars whose track the reader has to infer.
    const own = `  ${band.number}. ${band.label}`;
    const ownLabel = own.length > LABEL_CHARS ? `${own.slice(0, LABEL_CHARS - 1)}…` : own.padEnd(LABEL_CHARS);
    // █ is the parent's own work, ░ the stretch it spent waiting on the calls below it.
    const lead = Math.round(band.ownLeadFraction * TRACK_CHARS);
    const wait = Math.max(1, Math.round(band.waitFraction * TRACK_CHARS));
    const tail = Math.max(0, TRACK_CHARS - lead - wait);
    const ownTrack = '█'.repeat(lead) + '░'.repeat(wait) + '█'.repeat(tail);
    lines.push(`${ownLabel} |${ownTrack.slice(0, TRACK_CHARS).padEnd(TRACK_CHARS)}| ${waterfallFormatMs(band.spanMs).padStart(14)}`);

    for (const row of band.rows) {
      const label = `    ${row.number}. ${row.label}`;
      const clipped = label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label.padEnd(LABEL_CHARS);

      const lead = Math.round(row.startFraction * TRACK_CHARS);
      const width = Math.max(1, Math.round(row.widthFraction * TRACK_CHARS));
      const track = ' '.repeat(lead) + '█'.repeat(Math.min(width, TRACK_CHARS - lead));

      lines.push(
        `${clipped} |${track.padEnd(TRACK_CHARS)}| ${waterfallFormatMs(row.durationMs).padStart(14)}  ${waterfallStatusText(row)}`
      );
    }

    const ticks = waterfallAxisTicks(band.spanMs);
    if (ticks.length === 5) {
      const axis = '├' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┼' + '─'.repeat(8) + '┤';
      lines.push(`${pad} ${axis}`);
      // Each label is left-aligned under its own tick, except the last which is right-aligned to the
      // track's end so it can't overflow the row.
      let scale = ticks[0];
      for (let i = 1; i < 4; i++) scale = scale.padEnd(i * 9 + 1) + ticks[i];
      scale = scale.padEnd(TRACK_CHARS + 2 - ticks[4].length) + ticks[4];
      lines.push(`${pad} ${scale}`);
    }
  });

  return lines;
}
