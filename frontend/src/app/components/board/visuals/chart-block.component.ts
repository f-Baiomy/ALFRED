import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';
import { ChartSpec, formatValue, niceTicks, parseChart } from '../../../shared/utils/board-visuals';
import { downloadBlobAs, fileNameOf, svgToPngBlob } from '../../../shared/utils/svg-png';
import { copyToClipboard } from '../../../shared/utils/clipboard';

interface Rect { x: number; y: number; w: number; h: number; fill: string; tip: string; label: string; lx: number; ly: number }
interface Path { d: string; stroke: string; fill: string; tip: string }
interface Dot { x: number; y: number; fill: string; tip: string }
interface Text { x: number; y: number; t: string; anchor: string; fill?: string; size?: number }

const W = 640;
const H = 270;

/**
 * A ```chart block (specs/017 R3): bar, horizontal bar, line, area or pie from a small JSON spec, drawn as SVG by the
 * board itself - every colour an attribute, so ⬇ PNG looks the same. A spec that does not parse shows why, and the source.
 */
@Component({
  selector: 'app-chart-block',
  standalone: true,
  template: `
    <div class="board-vis" dir="ltr">
      <div class="board-vis-bar"><span>▤ chart{{ spec()?.title ? ' · ' + spec()!.title : '' }}</span>
        <span class="board-vis-acts">
          @if (spec()) { <button type="button" class="board-link" (click)="png()">⬇ PNG</button> }
          <button type="button" class="board-link" (click)="showSource.set(!showSource())">{{ showSource() ? 'chart' : '&lt;/&gt; source' }}</button>
          <button type="button" class="board-link" (click)="copy()">{{ copied() ? '✓ copied' : '⧉ data' }}</button>
        </span></div>
      @if (parsed().error; as err) {
        <div class="board-vis-err">{{ err }}</div>
        <pre class="board-vis-src">{{ source() }}</pre>
      } @else if (showSource()) {
        <pre class="board-vis-src">{{ source() }}</pre>
      } @else {
      @if (spec(); as s) {
        @if (s.series.length > 1 || s.type === 'pie') {
          <div class="board-vis-legend">@for (l of legend(); track $index) { <span><i [style.background]="l.color"></i>{{ l.name }}</span> }</div>
        }
        <svg #svg class="board-chart" [attr.viewBox]="'0 0 ' + w + ' ' + h" preserveAspectRatio="xMidYMid meet" role="img"
             [attr.aria-label]="s.title || 'chart'" font-family="system-ui, sans-serif" font-size="11">
          <rect x="0" y="0" [attr.width]="w" [attr.height]="h" fill="#070a24" />
          @for (t of model().grid; track $index) { <line [attr.x1]="t.x1" [attr.y1]="t.y1" [attr.x2]="t.x2" [attr.y2]="t.y2" stroke="#1c2358" /> }
          @for (t of model().texts; track $index) {
            <text [attr.x]="t.x" [attr.y]="t.y" [attr.text-anchor]="t.anchor" [attr.fill]="t.fill || '#93a0c2'" [attr.font-size]="t.size || 11">{{ t.t }}</text>
          }
          @for (p of model().paths; track $index) {
            <path [attr.d]="p.d" [attr.stroke]="p.stroke" [attr.fill]="p.fill" stroke-width="2.2" stroke-linejoin="round"><title>{{ p.tip }}</title></path>
          }
          @for (r of model().rects; track $index) {
            <g class="board-chart-bar"><rect [attr.x]="r.x" [attr.y]="r.y" [attr.width]="r.w" [attr.height]="r.h" [attr.fill]="r.fill" rx="2"><title>{{ r.tip }}</title></rect>
              @if (r.label) { <text [attr.x]="r.lx" [attr.y]="r.ly" text-anchor="middle" fill="#e5e9f5" font-size="10.5">{{ r.label }}</text> }</g>
          }
          @for (d of model().dots; track $index) { <circle [attr.cx]="d.x" [attr.cy]="d.y" r="3.2" [attr.fill]="d.fill"><title>{{ d.tip }}</title></circle> }
          @if (model().target; as tl) {
            <line [attr.x1]="tl.x1" [attr.y1]="tl.y1" [attr.x2]="tl.x2" [attr.y2]="tl.y2" stroke="#fbbf24" stroke-dasharray="6 4" stroke-width="1.5" />
            <text [attr.x]="tl.tx" [attr.y]="tl.ty" fill="#fbbf24" font-size="10.5" [attr.text-anchor]="tl.anchor">{{ tl.label }}</text>
          }
        </svg>
      }
      }
    </div>`,
})
export class ChartBlockComponent {
  readonly source = input.required<string>();
  readonly w = W;
  readonly h = H;
  readonly showSource = signal(false);
  readonly copied = signal(false);
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');

  readonly parsed = computed(() => parseChart(this.source()));
  readonly spec = computed(() => this.parsed().model);
  readonly legend = computed(() => {
    const s = this.spec();
    if (!s) return [];
    if (s.type === 'pie') return s.labels.map((l, i) => ({ name: l, color: pieColor(s, i) }));
    return s.series.map((x) => ({ name: x.name, color: x.color || x.colors?.[0] || '#a78bfa' }));
  });
  readonly model = computed(() => layout(this.spec()));

  png(): void {
    const svg = this.svg()?.nativeElement;
    if (!svg) return;
    svgToPngBlob(svg).then((b) => downloadBlobAs(b, fileNameOf(this.spec()?.title || 'chart', 'png'))).catch(() => undefined);
  }

  copy(): void {
    copyToClipboard(this.source()).then(() => { this.copied.set(true); setTimeout(() => this.copied.set(false), 1500); });
  }
}

function pieColor(s: ChartSpec, i: number): string {
  const first = s.series[0];
  return first.colors?.[i] ?? ['#a78bfa', '#22d3ee', '#34d399', '#fbbf24', '#f87171', '#60a5fa', '#f472b6', '#94a3b8'][i % 8];
}

interface Layout {
  grid: { x1: number; y1: number; x2: number; y2: number }[];
  texts: Text[];
  rects: Rect[];
  paths: Path[];
  dots: Dot[];
  target: { x1: number; y1: number; x2: number; y2: number; tx: number; ty: number; label: string; anchor: string } | null;
}

/** The chart's shapes in viewBox coordinates - pure, so it can be tested without a browser. */
export function layout(s: ChartSpec | null): Layout {
  const out: Layout = { grid: [], texts: [], rects: [], paths: [], dots: [], target: null };
  if (!s) return out;
  const unit = s.unit;
  if (s.type === 'pie') {
    const vals = s.series[0].values.map((v) => Math.max(0, v));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = W / 2, cy = H / 2 + 4, r = 105;
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const b = a + (2 * Math.PI * v) / total;
      const large = b - a > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a), x2 = cx + r * Math.cos(b), y2 = cy + r * Math.sin(b);
      const d = vals.length === 1 || v === total ? `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0`
        : `M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large} 1 ${x2.toFixed(1)},${y2.toFixed(1)} Z`;
      const pct = Math.round((100 * v) / total);
      out.paths.push({ d, stroke: '#0b1030', fill: pieColor(s, i), tip: `${s.labels[i]}: ${formatValue(v, unit)} (${pct}%)` });
      if (pct >= 6) {
        const m = (a + b) / 2;
        out.texts.push({ x: cx + r * 0.62 * Math.cos(m), y: cy + r * 0.62 * Math.sin(m) + 4, t: `${pct}%`, anchor: 'middle', fill: '#0b1030', size: 11 });
      }
      a = b;
    });
    return out;
  }
  const all = s.series.flatMap((x) => x.values);
  const max = Math.max(1, ...all, s.line?.at ?? 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || max;
  if (s.type === 'hbar') {
    const left = 120, right = W - 50, y0 = 14, y1 = H - 26;
    const sx = (v: number) => left + (Math.max(0, v) / top) * (right - left);
    ticks.forEach((t) => { out.grid.push({ x1: sx(t), y1: y0, x2: sx(t), y2: y1 }); out.texts.push({ x: sx(t), y: H - 10, t: formatValue(t), anchor: 'middle' }); });
    const n = s.labels.length, band = (y1 - y0) / n, k = s.series.length, bh = Math.min(26, (band * 0.75) / k);
    s.labels.forEach((label, i) => {
      out.texts.push({ x: left - 8, y: y0 + band * i + band / 2 + 4, t: clip(label, 18), anchor: 'end' });
      s.series.forEach((ser, j) => {
        const v = ser.values[i] ?? 0;
        const y = y0 + band * i + (band - bh * k) / 2 + j * bh;
        const w = sx(v) - left;
        out.rects.push({ x: left, y, w: Math.max(0, w), h: bh - 2, fill: ser.colors?.[i] ?? ser.color, tip: `${label}${ser.name ? ' · ' + ser.name : ''}: ${formatValue(v, unit)}`,
          label: '', lx: 0, ly: 0 });
        out.texts.push({ x: left + Math.max(0, w) + 4, y: y + bh / 2 + 3, t: formatValue(v), anchor: 'start', fill: '#e5e9f5', size: 10.5 });
      });
    });
    if (s.line) out.target = { x1: sx(s.line.at), y1: y0, x2: sx(s.line.at), y2: y1, tx: sx(s.line.at) + 4, ty: y0 + 10, label: s.line.label, anchor: 'start' };
    return out;
  }
  const left = 52, right = W - 14, y0 = 16, y1 = H - 34;
  const sy = (v: number) => y1 - (Math.max(0, v) / top) * (y1 - y0);
  ticks.forEach((t) => { out.grid.push({ x1: left, y1: sy(t), x2: right, y2: sy(t) }); out.texts.push({ x: left - 6, y: sy(t) + 4, t: formatValue(t), anchor: 'end' }); });
  const n = s.labels.length;
  if (s.type === 'bar') {
    const band = (right - left) / n, k = s.series.length, bw = Math.min(46, (band * 0.72) / k);
    s.labels.forEach((label, i) => {
      out.texts.push({ x: left + band * i + band / 2, y: H - 14, t: clip(label, Math.max(6, Math.floor(band / 7))), anchor: 'middle' });
      s.series.forEach((ser, j) => {
        const v = ser.values[i] ?? 0;
        const x = left + band * i + (band - bw * k) / 2 + j * bw;
        out.rects.push({ x: x + 1, y: sy(v), w: bw - 2, h: y1 - sy(v), fill: ser.colors?.[i] ?? ser.color,
          tip: `${label}${ser.name ? ' · ' + ser.name : ''}: ${formatValue(v, unit)}`, label: bw >= 22 ? formatValue(v) : '', lx: x + bw / 2, ly: sy(v) - 4 });
      });
    });
  } else {
    const step = n > 1 ? (right - left) / (n - 1) : 0;
    const sx = (i: number) => (n > 1 ? left + step * i : (left + right) / 2);
    s.labels.forEach((label, i) => { if (n <= 12 || i % Math.ceil(n / 12) === 0) out.texts.push({ x: sx(i), y: H - 14, t: clip(label, 10), anchor: 'middle' }); });
    s.series.forEach((ser) => {
      const pts = ser.values.map((v, i) => [sx(i), sy(v)] as const);
      if (!pts.length) return;
      const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      if (s.type === 'area') {
        out.paths.push({ d: `${line} L${pts[pts.length - 1][0].toFixed(1)},${y1} L${pts[0][0].toFixed(1)},${y1} Z`, stroke: 'none', fill: ser.color + '33', tip: ser.name });
      }
      out.paths.push({ d: line, stroke: ser.color, fill: 'none', tip: ser.name });
      ser.values.forEach((v, i) => out.dots.push({ x: sx(i), y: sy(v), fill: ser.color, tip: `${s.labels[i]}${ser.name ? ' · ' + ser.name : ''}: ${formatValue(v, unit)}` }));
    });
  }
  if (s.line) out.target = { x1: left, y1: sy(s.line.at), x2: right, y2: sy(s.line.at), tx: right - 2, ty: sy(s.line.at) - 5, label: s.line.label, anchor: 'end' };
  return out;
}

function clip(t: string, n: number): string {
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
