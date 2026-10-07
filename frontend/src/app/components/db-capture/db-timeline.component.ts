import { ChangeDetectionStrategy, Component, HostListener, computed, input, output, signal } from '@angular/core';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { DbOverview, ITEM_LABELS, ItemKind, TimelineSupplier, fmtMs, idleKey } from '../../shared/utils/db-findings';
import { logLevelClass } from '../../shared/utils/call-log-rows';

/** One log line on the Logs lane (specs/008-logs-call-link): its offset from the call's start and level. */
export interface LogTick {
  readonly key: string;
  readonly atMs: number;
  readonly level: string | null;
  readonly message: string;
}

/** One Redis command on the Redis lane (specs/011-redis-capture): offset from the call's start, its time, how it went. */
export interface RedisTick {
  readonly key: string;
  readonly seq: number;
  readonly atMs: number;
  readonly ms: number;
  readonly outcome: string;
  readonly title: string;
  readonly lines: readonly string[];
}

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
/** Supplier calls are thinner and stacked at most this deep; the rest sit behind "+N parallel" until expanded. */
const SUP_ROW_PX = 14;
const SUP_SEG_PX = 12;
const SUP_MAX_ROWS = 4;
/** Strip mode: thin lanes, every supplier call in one 20 px lane. */
const STRIP_ROW_PX = 11;
const STRIP_SEG_PX = 9;
const STRIP_SUP_PX = 20;
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
    <div class="dbt" [class.dimmed]="highlight()?.size" [class.strip]="strip()">
      <div class="dbt-axis">
        @for (t of ticks(); track t) {<span [style.left.%]="x(t)">{{ fmt(t) }}</span>}
      </div>
      @for (lane of lanes(); track lane.name) {
        <div class="dbt-lane">
          <div class="dbt-name">{{ lane.name }}</div>
          <div class="dbt-track" [style.height.px]="6 + lane.rows * lane.rowPx" (mousedown)="dragStart($event)">
            @for (t of ticks(); track t) {<div class="dbt-grid" [style.left.%]="x(t)"></div>}
            @for (it of lane.items; track it.key) {
              <div class="dbt-seg" [class]="'dbt-seg k-' + it.kind" [class.hl]="highlight()?.has(it.key)"
                   [style.left.%]="x(it.atMs)" [style.width.%]="w(it.ms)" [style.top.px]="3 + it.row * lane.rowPx" [style.height.px]="lane.segPx"
                   (mousemove)="showTip($event, it)" (mouseleave)="tip.set(null)" (mousedown)="$event.stopPropagation()" (click)="jumpTo.emit(it.jump)">
                @if (it.label && w(it.ms) > labelMin && lane.segPx >= 9 && (!strip() || it.kind === 'idle')) {<span class="lb" [style.line-height.px]="lane.segPx">{{ it.label }}</span>}
              </div>
            }
            @if (lane.note) {<span class="dbt-note">{{ lane.note }}</span>}
            @if (lane.hidden.length) {
              <span class="dbt-more" [style.top.px]="3 + (lane.rows - 1) * lane.rowPx" (mousedown)="$event.stopPropagation()"
                    (mousemove)="showMore($event, lane.hidden)" (mouseleave)="tip.set(null)" (click)="supExpanded.set(true); tip.set(null)">+{{ lane.hidden.length }} parallel</span>
            } @else if (lane.name === 'Supplier calls' && supExpanded() && !strip()) {
              <span class="dbt-more" style="top:3px" (mousedown)="$event.stopPropagation()" (click)="supExpanded.set(false)">fewer rows</span>
            }
            @if (brush(); as b) {
              @if (b.track === lane.name) {<div class="dbt-brush" [style.left.px]="b.from" [style.width.px]="b.width"></div>}
            }
          </div>
        </div>
      }
      @if (logLanes().length) {
        <div class="dbt-lane">
          <div class="dbt-name lg">Logs</div>
          <div class="dbt-track lg" [style.height.px]="strip() ? 6 + STRIP_ROW : 6 + ROW" (mousedown)="dragStart($event)">
            @for (t of ticks(); track t) {<div class="dbt-grid" [style.left.%]="x(t)"></div>}
            @for (l of logLanes(); track l.key) {
              <div class="dbt-tick" [class]="'dbt-tick lv-' + lv(l.level)" [style.left.%]="x(l.atMs)" [style.height.px]="strip() ? STRIP_SEG : 16"
                   (mousemove)="showLogTip($event, l)" (mouseleave)="tip.set(null)" (mousedown)="$event.stopPropagation()" (click)="logsClicked.emit()"></div>
            }
          </div>
        </div>
      }
      @if (redisLane().length) {
        <div class="dbt-lane">
          <div class="dbt-name" style="color:var(--redis)">Redis</div>
          <div class="dbt-track" [style.height.px]="strip() ? 6 + STRIP_ROW : 6 + ROW" (mousedown)="dragStart($event)">
            @for (t of ticks(); track t) {<div class="dbt-grid" [style.left.%]="x(t)"></div>}
            @for (r of redisLane(); track r.key) {
              <div class="dbt-seg" [class]="'dbt-seg ' + (r.outcome === 'FAILED' ? 'k-redis-fail' : r.outcome === 'MISS' ? 'k-redis-miss' : 'k-redis')"
                   [class.hl]="highlight()?.has(r.key)"
                   [style.left.%]="x(r.atMs)" [style.width.%]="w(r.ms)" style="top:3px" [style.height.px]="strip() ? STRIP_SEG : 16"
                   (mousemove)="showRedisTip($event, r)" (mouseleave)="tip.set(null)" (mousedown)="$event.stopPropagation()" (click)="redisClicked.emit(r.seq)"></div>
            }
          </div>
        </div>
      }
      @if (!strip()) {
        <div class="dbt-legend">
          @for (k of legend(); track k) {<span><i [class]="'k-' + k"></i>{{ labels[k] }}</span>}
        </div>
      }
      @if (zoomed()) {
        <div class="dbt-zoom">Zoomed to {{ fmt(view()[0]) }} - {{ fmt(view()[1]) }}
          <button type="button" (click)="resetZoom()">Show all {{ fmt(overview().totalMs) }}</button></div>
      }
    </div>
    @if (tip(); as t) {
      <div class="dbt-tip" [style.left.px]="t.x" [style.top.px]="t.y">
        <b>{{ t.item.title }}</b>
        @for (l of t.item.lines; track $index) {@if (l) {<div class="k">{{ l }}</div>}}
        @if (t.item.jump >= 0) {<div class="go">click to open</div>}
      </div>
    }
  `,
})
export class DbTimelineComponent {
  readonly overview = input.required<DbOverview>();
  readonly statements = input.required<readonly CapturedStatement[]>();
  /** Items a hovered finding or chip lights up - the rest dim. */
  readonly highlight = input<ReadonlySet<string> | null>(null);
  /** Thin lanes: every supplier call in one lane as stacked slivers, no labels or legend - hover tells. */
  readonly strip = input(false);
  readonly jumpTo = output<number>();
  /** The call's linked log lines - a lane of their own, one tick per line coloured by level. */
  readonly logs = input<readonly LogTick[]>([]);
  /** A log tick was clicked: the window shows its Logs view. */
  readonly logsClicked = output<void>();
  /** The call's Redis commands - a lane of their own (specs/011-redis-capture). */
  readonly redis = input<readonly RedisTick[]>([]);
  /** A Redis command was clicked: the window opens it in its Redis view. */
  readonly redisClicked = output<number>();

  readonly redisLane = computed(() => {
    const [a, b] = this.view();
    return this.redis().filter((r) => r.atMs + r.ms >= a && r.atMs <= b);
  });

  showRedisTip(event: MouseEvent, r: RedisTick): void {
    this.showTip(event, { key: r.key, kind: 'ok', atMs: r.atMs, ms: r.ms, jump: r.seq, row: 0, label: '', title: r.title, lines: r.lines });
  }
  protected readonly ROW = ROW_PX;
  protected readonly STRIP_ROW = STRIP_ROW_PX;
  protected readonly STRIP_SEG = STRIP_SEG_PX;

  readonly logLanes = computed(() => {
    const [a, b] = this.view();
    return this.logs().filter((l) => l.atMs >= a && l.atMs <= b);
  });

  lv(level: string | null): string {
    return logLevelClass(level);
  }

  showLogTip(event: MouseEvent, l: LogTick): void {
    this.showTip(event, { key: l.key, kind: 'ok', atMs: l.atMs, ms: 0, jump: -1, row: 0, label: '', title: `▤ ${l.level ?? 'LOG'} at ${fmtMs(l.atMs)}`,
      lines: [l.message.length > 200 ? l.message.slice(0, 200) + '…' : l.message, 'click for the call’s log lines'] });
  }

  protected readonly labelMin = LABEL_MIN_PCT;
  protected readonly labels = ITEM_LABELS;
  protected readonly fmt = fmtMs;

  readonly zoom = signal<readonly [number, number] | null>(null);
  /** Every supplier row shown, not only the first four. */
  readonly supExpanded = signal(false);
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
    const supRows = Math.max(1, ...o.suppliers.map((c) => c.row + 1));
    const none: TimelineSupplier[] = [];
    if (this.strip()) {
      // every supplier call in one 20 px lane, a row of slivers per call running at the same time
      const per = Math.max(1, Math.min(STRIP_SUP_PX / 2, Math.floor(STRIP_SUP_PX / supRows)));
      return [
        { name: 'Database', items: visible(db), rows: 1, rowPx: STRIP_ROW_PX, segPx: STRIP_SEG_PX, hidden: none, note: '' },
        { name: 'Suppliers', items: visible(sup), rows: Math.ceil(STRIP_SUP_PX / per), rowPx: per, segPx: Math.max(1, per - 1), hidden: none,
          note: o.suppliers.length > 1 ? `${o.suppliers.length} calls${supRows > 1 ? `, up to ${supRows} at once` : ''}` : '' },
        { name: 'Idle', items: visible(idle), rows: 1, rowPx: STRIP_ROW_PX, segPx: STRIP_SEG_PX, hidden: none, note: '' },
      ].filter((l) => l.name === 'Database' || l.items.length || (l.name === 'Suppliers' && o.suppliers.length));
    }
    const capped = !this.supExpanded() && supRows > SUP_MAX_ROWS;
    const hidden = capped ? o.suppliers.filter((c) => c.row >= SUP_MAX_ROWS) : [];
    const lanes = [
      { name: 'Database', items: visible(db), rows: 1, rowPx: ROW_PX, segPx: 16, hidden: none, note: '' },
      { name: 'Supplier calls', items: visible(sup.filter((it) => !capped || it.row < SUP_MAX_ROWS)), rows: capped ? SUP_MAX_ROWS : supRows,
        rowPx: SUP_ROW_PX, segPx: SUP_SEG_PX, hidden, note: '' },
      { name: 'Idle (app only)', items: visible(idle), rows: 1, rowPx: ROW_PX, segPx: 16, hidden: none, note: '' },
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

  /** The calls behind "+N parallel", listed on hover. */
  showMore(event: MouseEvent, hidden: readonly TimelineSupplier[]): void {
    this.showTip(event, { key: 'more', kind: 'sup', atMs: 0, ms: 0, jump: -1, row: 0, label: '', title: `${hidden.length} more calls in parallel`,
      lines: [...hidden.map((c) => `#${c.seq} ${c.host} · ${fmtMs(c.ms)} · ${c.status ?? 'no answer'}`), 'click to show every row'] });
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
