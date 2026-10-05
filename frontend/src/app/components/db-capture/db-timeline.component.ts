import { ChangeDetectionStrategy, Component, HostListener, computed, input, output, signal } from '@angular/core';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { DbOverview, ITEM_LABELS, ItemKind, fmtMs, idleKey } from '../../shared/utils/db-findings';

interface Item {
  readonly key: string;
  readonly kind: ItemKind;
  readonly atMs: number;
  readonly ms: number;
  readonly jump: number;
  readonly row: number;
  readonly label: string;
  readonly title: string;
  readonly lines: readonly string[];
}

const KINDS: readonly ItemKind[] = ['ok', 'fan', 'slow', 'rep', 'big', 'err', 'tx', 'sup', 'idle'];
const ROW_PX = 19;
const LABEL_MIN_PCT = 6;

/**
 * The call's timeline (specs/006-db-capture/timeline-mock.html): three lanes - Database, Supplier calls (calls that
 * overlap stacked on rows of their own), Idle (≥ 1 s with nothing running) - coloured by what each item is, the big
 * ones labelled. Hover shows a card, click jumps to it in the list, dragging across a lane zooms in.
 */
@Component({
  standalone: true,
  selector: 'app-db-timeline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dbt" [class.dimmed]="highlight()?.size">
      <div class="dbt-axis">
        @for (t of ticks(); track t) {<span [style.left.%]="x(t)">{{ fmt(t) }}</span>}
      </div>
      @for (lane of lanes(); track lane.name) {
        <div class="dbt-lane">
          <div class="dbt-name">{{ lane.name }}</div>
          <div class="dbt-track" [style.height.px]="6 + lane.rows * rowPx" (mousedown)="dragStart($event)">
            @for (t of ticks(); track t) {<div class="dbt-grid" [style.left.%]="x(t)"></div>}
            @for (it of lane.items; track it.key) {
              <div class="dbt-seg" [class]="'dbt-seg k-' + it.kind" [class.hl]="highlight()?.has(it.key)"
                   [style.left.%]="x(it.atMs)" [style.width.%]="w(it.ms)" [style.top.px]="3 + it.row * rowPx"
                   (mousemove)="showTip($event, it)" (mouseleave)="tip.set(null)" (mousedown)="$event.stopPropagation()" (click)="jumpTo.emit(it.jump)">
                @if (it.label && w(it.ms) > labelMin) {<span class="lb">{{ it.label }}</span>}
              </div>
            }
            @if (brush(); as b) {
              @if (b.track === lane.name) {<div class="dbt-brush" [style.left.px]="b.from" [style.width.px]="b.width"></div>}
            }
          </div>
        </div>
      }
      <div class="dbt-legend">
        @for (k of legend(); track k) {<span><i [class]="'k-' + k"></i>{{ labels[k] }}</span>}
      </div>
      @if (zoomed()) {
        <div class="dbt-zoom">Zoomed to {{ fmt(view()[0]) }} - {{ fmt(view()[1]) }}
          <button type="button" (click)="resetZoom()">Show all {{ fmt(overview().totalMs) }}</button></div>
      }
    </div>
    @if (tip(); as t) {
      <div class="dbt-tip" [style.left.px]="t.x" [style.top.px]="t.y">
        <b>{{ t.item.title }}</b>
        @for (l of t.item.lines; track $index) {@if (l) {<div class="k">{{ l }}</div>}}
        <div class="go">click to open</div>
      </div>
    }
  `,
})
export class DbTimelineComponent {
  readonly overview = input.required<DbOverview>();
  readonly statements = input.required<readonly CapturedStatement[]>();
  /** Items a hovered finding or chip lights up - the rest dim. */
  readonly highlight = input<ReadonlySet<string> | null>(null);
  readonly jumpTo = output<number>();

  protected readonly rowPx = ROW_PX;
  protected readonly labelMin = LABEL_MIN_PCT;
  protected readonly labels = ITEM_LABELS;
  protected readonly fmt = fmtMs;

  readonly zoom = signal<readonly [number, number] | null>(null);
  readonly view = computed<readonly [number, number]>(() => this.zoom() ?? [0, Math.max(1, this.overview().totalMs)]);
  readonly zoomed = computed(() => this.zoom() != null);
  readonly tip = signal<{ x: number; y: number; item: Item } | null>(null);
  readonly brush = signal<{ track: string; from: number; width: number } | null>(null);
  private drag: { track: string; rect: DOMRect; from: number } | null = null;

  readonly ticks = computed(() => {
    const [a, b] = this.view();
    const span = b - a;
    const step = span > 20000 ? 5000 : span > 10000 ? 2000 : span > 4000 ? 1000 : span > 1500 ? 250 : span > 400 ? 100 : 25;
    const out: number[] = [];
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) out.push(t);
    return out;
  });

  readonly lanes = computed(() => {
    const o = this.overview();
    const db: Item[] = this.statements().map((s) => {
      const kind = o.kinds.get(s.seq) ?? 'ok';
      const ms = s.durationMicros / 1000;
      const rows = s.outcome.rowsRead ?? s.outcome.affected;
      return {
        key: `s${s.seq}`, kind, atMs: s.offsetMicros / 1000, ms: Math.max(ms, 0.5), jump: s.seq, row: 0,
        label: `#${s.seq} ${s.table ?? s.kind}`, title: `#${s.seq} ${s.kind} ${s.table ?? ''}`.trim(),
        lines: [`${fmtMs(ms)}${rows != null ? ` · ${rows.toLocaleString()} rows` : ''} · at ${fmtMs(s.offsetMicros / 1000)}`,
          s.outcome.kind === 'FAILED' ? `✕ ${s.outcome.message?.split('\n')[0] ?? 'failed'}` : '', ITEM_LABELS[kind], s.callers?.[0] ?? s.codeLocation ?? ''],
      };
    });
    const sup: Item[] = o.suppliers.map((c) => ({
      key: `c${c.seq}`, kind: 'sup' as const, atMs: c.atMs, ms: Math.max(c.ms, 0.5), jump: c.seq, row: c.row,
      label: `${c.host} · ${fmtMs(c.ms)} · ${c.status ?? '-'}`, title: `#${c.seq} ${c.method} ${c.host}`,
      lines: [`${c.path} · ${c.status ?? 'no answer'} · ${fmtMs(c.ms)} · at ${fmtMs(c.atMs)}`, 'Supplier call - click to open it in the list'],
    }));
    const idle: Item[] = o.idle.map((g) => ({
      key: idleKey(g), kind: 'idle' as const, atMs: g.atMs, ms: g.ms, jump: (g.beforeSeq ?? g.afterSeq)!, row: 0,
      label: `${fmtMs(g.ms)} idle`, title: `${fmtMs(g.ms)} with nothing running`,
      lines: [`from ${fmtMs(g.atMs)} to ${fmtMs(g.atMs + g.ms)} - no SQL, no supplier call`,
        g.beforeSeq != null ? `next: #${g.beforeSeq} - what the application did in between is not captured` : 'until the call answered'],
    })).filter((it) => it.jump != null);
    const [a, b] = this.view();
    const visible = (items: Item[]) => items.filter((it) => it.atMs + it.ms >= a && it.atMs <= b);
    const lanes = [
      { name: 'Database', items: visible(db), rows: 1 },
      { name: 'Supplier calls', items: visible(sup), rows: Math.max(1, ...o.suppliers.map((c) => c.row + 1)) },
      { name: 'Idle (app only)', items: visible(idle), rows: 1 },
    ];
    return lanes.filter((l) => l.name === 'Database' || l.items.length || (l.name === 'Supplier calls' && o.suppliers.length));
  });

  /** Only the kinds this call has. */
  readonly legend = computed(() => {
    const o = this.overview();
    const have = new Set<ItemKind>(o.kinds.values());
    if (o.suppliers.length) have.add('sup');
    if (o.idle.length) have.add('idle');
    return KINDS.filter((k) => have.has(k));
  });

  x(ms: number): number {
    const [a, b] = this.view();
    return ((ms - a) / (b - a)) * 100;
  }

  w(ms: number): number {
    const [a, b] = this.view();
    return (ms / (b - a)) * 100;
  }

  showTip(event: MouseEvent, item: Item): void {
    this.tip.set({ x: Math.min(event.clientX + 14, window.innerWidth - 400), y: event.clientY + 14, item });
  }

  dragStart(event: MouseEvent): void {
    const track = event.currentTarget as HTMLElement;
    const name = track.previousElementSibling?.textContent?.trim() ?? '';
    this.drag = { track: name, rect: track.getBoundingClientRect(), from: event.clientX };
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onMove(event: MouseEvent): void {
    if (!this.drag) return;
    const a = Math.min(this.drag.from, event.clientX) - this.drag.rect.left;
    const b = Math.max(this.drag.from, event.clientX) - this.drag.rect.left;
    this.brush.set({ track: this.drag.track, from: Math.max(0, a), width: Math.min(this.drag.rect.width, b) - Math.max(0, a) });
  }

  @HostListener('document:mouseup', ['$event'])
  onUp(event: MouseEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.brush.set(null);
    if (Math.abs(event.clientX - drag.from) < 6) return;
    const [a, b] = this.view();
    const toMs = (px: number) => a + ((px - drag.rect.left) / drag.rect.width) * (b - a);
    const from = Math.max(0, toMs(Math.min(drag.from, event.clientX)));
    const to = Math.min(this.overview().totalMs, toMs(Math.max(drag.from, event.clientX)));
    if (to - from >= 1) this.zoom.set([from, to]);
  }

  resetZoom(): void {
    this.zoom.set(null);
  }
}
