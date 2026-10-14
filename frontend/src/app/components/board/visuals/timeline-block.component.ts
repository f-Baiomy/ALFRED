import { Component, ElementRef, computed, input, viewChild } from '@angular/core';
import { formatValue, niceTicks, parseTimeline } from '../../../shared/utils/board-visuals';
import { downloadBlobAs, svgToPngBlob } from '../../../shared/utils/svg-png';

/**
 * A ```timeline block (specs/017 R4): where the time of a call went - one bar per row from its start for its length,
 * on one scale, drawn as SVG by the board (⬇ PNG like a chart).
 */
@Component({
  selector: 'app-timeline-block',
  standalone: true,
  template: `
    <div class="board-vis" dir="ltr">
      <div class="board-vis-bar"><span>⏱ timeline · {{ total() }}</span>
        <span class="board-vis-acts">@if (model()) { <button type="button" class="board-link" (click)="png()">⬇ PNG</button> }</span></div>
      @if (parsed().error; as err) {
        <div class="board-vis-err">{{ err }}</div><pre class="board-vis-src">{{ source() }}</pre>
      } @else {
      @if (model(); as m) {
        <svg #svg class="board-chart" [attr.viewBox]="'0 0 640 ' + m.height" font-family="system-ui, sans-serif" font-size="11" role="img" aria-label="timeline">
          <rect x="0" y="0" width="640" [attr.height]="m.height" fill="#070a24" />
          @for (t of m.ticks; track $index) {
            <line [attr.x1]="t.x" y1="6" [attr.x2]="t.x" [attr.y2]="m.height - 20" stroke="#1c2358" />
            <text [attr.x]="t.x" [attr.y]="m.height - 6" text-anchor="middle" fill="#5c6690">{{ t.label }}</text>
          }
          @for (r of m.rows; track $index) {
            <text x="8" [attr.y]="r.y + 13" fill="#cbd5e1">{{ r.label }}</text>
            <rect [attr.x]="r.x" [attr.y]="r.y + 2" [attr.width]="r.w" height="16" rx="3" [attr.fill]="r.color"><title>{{ r.tip }}</title></rect>
            <text [attr.x]="r.x + r.w + 5" [attr.y]="r.y + 14" fill="#e5e9f5" font-size="10.5">{{ r.value }}</text>
          }
        </svg>
      }
      }
    </div>`,
})
export class TimelineBlockComponent {
  readonly source = input.required<string>();
  private readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');
  readonly parsed = computed(() => parseTimeline(this.source()));
  readonly total = computed(() => { const m = this.parsed().model; return m ? formatValue(m.end, m.unit) : ''; });
  readonly model = computed(() => {
    const m = this.parsed().model;
    if (!m) return null;
    const left = 170, right = 590;
    const ticks = niceTicks(m.end);
    const end = ticks[ticks.length - 1] || m.end || 1;
    const scale = (v: number) => left + (v / end) * (right - left);
    const rows = m.rows.map((r, i) => ({
      label: r.label.length > 26 ? r.label.slice(0, 25) + '…' : r.label, y: 8 + i * 24, x: scale(r.start), w: Math.max(2, scale(r.start + r.length) - scale(r.start)),
      color: r.color, value: formatValue(r.length, m.unit), tip: `${r.label}: ${formatValue(r.length, m.unit)} (from ${formatValue(r.start, m.unit)})`,
    }));
    return { rows, height: 8 + rows.length * 24 + 26, ticks: ticks.map((t) => ({ x: scale(t), label: formatValue(t, m.unit) })) };
  });

  png(): void {
    const svg = this.svg()?.nativeElement;
    if (svg) svgToPngBlob(svg).then((b) => downloadBlobAs(b, 'timeline.png')).catch(() => undefined);
  }
}
