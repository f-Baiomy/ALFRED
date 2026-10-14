/**
 * The fixed visual blocks of a board text (specs/017 R2-R4): ```stats, ```chart and ```timeline, parsed from their
 * source into plain models the board draws itself - no library, no code of the writer's runs. A source that does not
 * parse gives an error the block shows next to the source, never a thrown exception.
 */

export type VisualColor = 'red' | 'green' | 'amber' | 'blue' | 'purple' | 'cyan' | 'dim';
export const VISUAL_COLORS: readonly VisualColor[] = ['red', 'green', 'amber', 'blue', 'purple', 'cyan', 'dim'];
/** The colours as the dark theme draws them (SVG fills need values, not classes). */
export const COLOR_VALUES: Record<VisualColor, string> = {
  red: '#f87171', green: '#34d399', amber: '#fbbf24', blue: '#60a5fa', purple: '#a78bfa', cyan: '#22d3ee', dim: '#5c6690',
};
/** Series colours in order when the writer gives none. */
export const SERIES_COLORS: readonly string[] = ['#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#60a5fa', '#f472b6', '#94a3b8'];

export function colorValue(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback;
  const n = name.trim().toLowerCase();
  if ((VISUAL_COLORS as readonly string[]).includes(n)) return COLOR_VALUES[n as VisualColor];
  return /^#[0-9a-f]{3,8}$/i.test(n) ? n : fallback;
}

export interface Parsed<T> {
  readonly model: T | null;
  readonly error: string | null;
}

// ------------------------------------------------------------------------------------------------------------- stats

export interface StatCard {
  readonly label: string;
  readonly value: string;
  readonly color: VisualColor | null;
  readonly note: string;
}

/** `label | value | colour | note` per line; colour and note optional. */
export function parseStats(source: string): Parsed<StatCard[]> {
  const cards: StatCard[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2 || !parts[0]) return { model: null, error: `A stat is "label | value | colour | note" - this line is not: ${line}` };
    const color = parts[2] && (VISUAL_COLORS as readonly string[]).includes(parts[2].toLowerCase()) ? parts[2].toLowerCase() as VisualColor : null;
    const note = color ? parts.slice(3).join(' | ') : parts.slice(2).join(' | ');
    cards.push({ label: parts[0], value: parts[1], color, note });
  }
  if (!cards.length) return { model: null, error: 'No stats - write one per line: label | value | colour | note' };
  return { model: cards, error: null };
}

// ------------------------------------------------------------------------------------------------------------- chart

export type ChartType = 'bar' | 'hbar' | 'line' | 'area' | 'pie';
export const CHART_TYPES: readonly ChartType[] = ['bar', 'hbar', 'line', 'area', 'pie'];

export interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
  readonly color: string;
  /** One colour per value (the short form's "colors"), for bars. */
  readonly colors?: readonly string[];
}

export interface ChartSpec {
  readonly type: ChartType;
  readonly title: string;
  readonly labels: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly unit: string;
  /** A target / threshold line. */
  readonly line: { readonly at: number; readonly label: string } | null;
}

/**
 * JSON: `{type, title?, labels, series: [{name, values, color?}]}` or the short form `{type, labels, values, colors?}`;
 * `line: {at, label}` draws a target, `unit` follows every value.
 */
export function parseChart(source: string): Parsed<ChartSpec> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(source) as Record<string, unknown>;
  } catch (e) {
    return { model: null, error: `The chart is JSON: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { model: null, error: 'The chart is a JSON object: {"type": "bar", "labels": [...], "series": [...]}' };
  const type = String(raw['type'] ?? 'bar').toLowerCase() as ChartType;
  if (!CHART_TYPES.includes(type)) return { model: null, error: `type is one of ${CHART_TYPES.join(', ')}` };
  const labels = Array.isArray(raw['labels']) ? (raw['labels'] as unknown[]).map((l) => String(l)) : [];
  let series: ChartSeries[] = [];
  if (Array.isArray(raw['series'])) {
    series = (raw['series'] as unknown[]).map((s, i) => {
      const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
      return { name: String(o['name'] ?? `Series ${i + 1}`), values: numbers(o['values']), color: colorValue(o['color'] as string, SERIES_COLORS[i % SERIES_COLORS.length]) };
    });
  } else if (Array.isArray(raw['values'])) {
    const colors = Array.isArray(raw['colors']) ? (raw['colors'] as unknown[]).map(String) : null;
    series = [{ name: String(raw['name'] ?? ''), values: numbers(raw['values']), color: colorValue(colors?.[0], SERIES_COLORS[0]),
      ...(colors && colors.length > 1 ? { colors: colors.map((c, i) => colorValue(c, SERIES_COLORS[i % SERIES_COLORS.length])) } : {}) }];
  }
  if (!series.length || series.every((s) => !s.values.length)) return { model: null, error: 'The chart needs values: "series": [{"name": "…", "values": [1, 2]}] or "values": [1, 2]' };
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  const fullLabels = Array.from({ length: n }, (_, i) => labels[i] ?? String(i + 1));
  const lineRaw = raw['line'] && typeof raw['line'] === 'object' ? raw['line'] as Record<string, unknown> : null;
  const line = lineRaw && Number.isFinite(Number(lineRaw['at'])) ? { at: Number(lineRaw['at']), label: String(lineRaw['label'] ?? '') } : null;
  return { model: { type, title: String(raw['title'] ?? ''), labels: fullLabels, series, unit: String(raw['unit'] ?? ''), line }, error: null };
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)) : [];
}

/** Round axis steps: 1, 2, 2.5 or 5 × 10^n, about `count` of them up to `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max * 1.0001 + step * 0.0001; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

export function formatValue(v: number, unit = ''): string {
  const abs = Math.abs(v);
  const s = abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${(v / 1e3).toFixed(1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(abs < 1 ? 3 : 1);
  return unit ? `${s} ${unit}` : s;
}

// ------------------------------------------------------------------------------------------------------------ timeline

export interface TimelineRow {
  readonly label: string;
  readonly start: number;
  readonly length: number;
  readonly color: string;
}

/** `label | start | length | colour` per line (milliseconds; colour optional). */
export function parseTimeline(source: string): Parsed<{ rows: TimelineRow[]; end: number; unit: string }> {
  const rows: TimelineRow[] = [];
  let unit = 'ms';
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const u = /^unit\s*:\s*(\S+)$/i.exec(line);
    if (u) { unit = u[1]; continue; }
    const p = line.split('|').map((x) => x.trim());
    const start = Number(p[1]);
    const length = Number(p[2]);
    if (p.length < 3 || !p[0] || !Number.isFinite(start) || !Number.isFinite(length) || length < 0) {
      return { model: null, error: `A timeline row is "label | start | length | colour" (numbers) - this line is not: ${line}` };
    }
    rows.push({ label: p[0], start, length, color: colorValue(p[3], SERIES_COLORS[rows.length % SERIES_COLORS.length]) });
  }
  if (!rows.length) return { model: null, error: 'No rows - write one per line: label | start | length | colour' };
  return { model: { rows, end: Math.max(...rows.map((r) => r.start + r.length)), unit }, error: null };
}

// ------------------------------------------------------------------------------------------------------- line blocks

/** `[progress: 3/9 re-tested]` */
export const PROGRESS_LINE = /^\s*\[progress:\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*([^\]]*)\]\s*$/i;
/** `[choose: A | B | C]` */
export const CHOOSE_LINE = /^\s*\[choose:\s*([^\]]+)\]\s*$/i;
/** `[action: retest | Re-test now] [action: run /alfred-fix 33]` - one or more on a line */
export const ACTION_LINE = /^\s*(\[action:\s*[^\]]+\]\s*)+$/i;
/** `!@[call:in:x|label]` alone on a line - the expanded call view */
export const CALLVIEW_LINE = /^\s*!(@\[call:[^\]]+\])\s*$/;
/** Lines that are a block of their own (they end a paragraph). */
export function isLineBlock(line: string): boolean {
  return PROGRESS_LINE.test(line) || CHOOSE_LINE.test(line) || ACTION_LINE.test(line) || CALLVIEW_LINE.test(line) || /^\s*:::/.test(line);
}

export interface ActionChip {
  readonly kind: string;
  readonly arg: string;
  readonly label: string;
}

export function parseActions(line: string): ActionChip[] {
  const out: ActionChip[] = [];
  for (const m of line.matchAll(/\[action:\s*([^\]]+)\]/gi)) {
    const [what, label] = m[1].split('|').map((s) => s.trim());
    const sp = what.indexOf(' ');
    const kind = (sp < 0 ? what : what.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : what.slice(sp + 1).trim();
    out.push({ kind, arg, label: label || what });
  }
  return out;
}

/** The fence languages the board draws as a visual rather than as code. */
export const VISUAL_LANGS = ['stats', 'chart', 'timeline', 'mermaid', 'calls', 'statement', 'call-logs', 'compare', 'form'] as const;
export type VisualLang = (typeof VISUAL_LANGS)[number] | 'html' | 'python';

/** ```chart, ```stats … and ```html live / ```python live (a snippet) are visuals; every other fence is code. */
export function visualLangOf(lang: string, info: string): VisualLang | null {
  const l = lang.toLowerCase();
  if ((VISUAL_LANGS as readonly string[]).includes(l)) return l as VisualLang;
  if ((l === 'html' || l === 'python') && /^live\b/i.test(info.trim())) return l;
  return null;
}

/** `name="Fare dashboard" libs="echarts@5" height=300` → attributes of a fence's info string. */
export function infoAttrs(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of info.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/** Ready-made sources the editor inserts (the toolbar's Visual menu and the / menu). */
export const VISUAL_TEMPLATES: Record<string, string> = {
  stats: 'Median | 2380 → 610 ms | green | ▼ 74%\n95th percentile | 2900 → 940 ms | green | ▼ 68%\nDatabase time | 108 → 104 ms | dim | unchanged',
  chart: JSON.stringify({ type: 'bar', title: 'Before and after the fix', unit: 'ms', labels: ['Median', '95th', 'Slowest'],
    series: [{ name: 'before', values: [2380, 2900, 2950], color: 'red' }, { name: 'after', values: [610, 940, 960], color: 'green' }],
    line: { at: 1000, label: 'target' } }, null, 1),
  timeline: 'POST /fare-confirm | 0 | 2400 | purple\nrule hash + GZIP | 40 | 740 | red\nRedis lists | 800 | 290 | amber\nSQL (4 statements) | 1100 | 108 | green',
  progress: '[progress: 3/9 searches re-tested]',
  tabs: ':::tabs\n## Before\n…\n## After\n…\n:::',
  html: '<div id="app"></div>\n<style>\n  .row { margin: 6px 0 }\n  .bar { height: 14px; border-radius: 4px; width: 0; transition: width .9s ease }\n</style>\n<script>\n'
    + '  const rows = [["Before", 2380, "var(--red)"], ["After", 610, "var(--green)"]];\n'
    + '  app.innerHTML = rows.map(([k, v, c]) => `<div class="row">${k} · ${v} ms<div class="bar" style="background:${c}" data-w="${v / 24}%"></div></div>`).join("");\n'
    + '  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll(".bar").forEach((b) => (b.style.width = b.dataset.w))));\n</script>',
  mermaid: 'flowchart LR\n  A[Browser] --> B[Gateway]\n  B --> C[Backend]\n  C --> D[(board.db)]',
};
