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
  readonly depth: number;
  /** The window every row in this band is drawn against. */
  readonly spanMs: number | null;
  /** How much of `spanMs` the parent spent waiting on these children (union, not sum). */
  readonly downstreamMs: number | null;
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
    durationMs: child.durationMs,
    startFraction,
    widthFraction: Math.min(1 - startFraction, Math.max(MIN_WIDTH_FRACTION, rawWidth)),
    status: child.status,
    error: child.error,
    inProgress: child.inProgress,
  };
}

function bandsOf(node: NarrativeCallNode): WaterfallBand[] {
  const here: WaterfallBand[] =
    node.children.length > 0
      ? [
          {
            number: node.number,
            label: labelOf(node),
            depth: node.depth,
            spanMs: node.durationMs,
            downstreamMs: node.downstreamMs,
            rows: node.children.map((child) => rowFor(child, node)),
          },
        ]
      : [];
  return [...here, ...node.children.flatMap(bandsOf)];
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

const TRACK_CHARS = 38;
const LABEL_CHARS = 40;

/**
 * The Markdown rendering: a monospace chart, because Markdown cannot draw a real bar. Goes in a code
 * fence so proportional fonts and Markdown's table rules can't reflow the alignment it depends on.
 */
export function waterfallAsciiLines(bands: readonly WaterfallBand[]): string[] {
  const lines: string[] = [];
  bands.forEach((band, index) => {
    if (index > 0) lines.push('');
    lines.push(waterfallBandCaption(band));
    for (const row of band.rows) {
      const label = `  ${row.number}. ${row.label}`;
      const clipped = label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label.padEnd(LABEL_CHARS);

      const lead = Math.round(row.startFraction * TRACK_CHARS);
      const width = Math.max(1, Math.round(row.widthFraction * TRACK_CHARS));
      const track = ' '.repeat(lead) + '█'.repeat(Math.min(width, TRACK_CHARS - lead));

      lines.push(
        `${clipped} |${track.padEnd(TRACK_CHARS)}| ${waterfallFormatMs(row.durationMs).padStart(14)}  ${waterfallStatusText(row)}`
      );
    }
  });
  return lines;
}
