import { Component, DestroyRef, ElementRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { Subject, debounceTime, switchMap, catchError, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Histogram, Pill } from '../../core/models/logs.model';
import { LogsApiService } from '../../core/services/logs-api.service';
import { clockText, fullText, lengthText, wallClock } from '../../shared/utils/logs-time-range';

interface Stack {
  readonly e: number;
  readonly w: number;
  readonly n: number;
  readonly total: number;
}

const MAIN_BUCKETS = 90;
const OVERVIEW_BUCKETS = 140;
const MIN_SCOPE = 2 * 60_000;

/**
 * "Your data over time" in the time panel: a thin overview of all the source's lines (with the part in
 * view boxed), and a main view that zooms to the selection - a third of its length either side - so a
 * 10-minute range is wide, not a sliver. Bars are stacked by level like the explorer's histogram. Drag
 * empty space to select, the edges to resize, the middle to slide; double-click a bar to take its slice;
 * the wheel zooms around the pointer.
 */
@Component({
  selector: 'app-log-timeline',
  standalone: true,
  template: `
    <div class="lg-tl-h">
      <span>Your data over time</span>
      <span class="lg-faint">drag to select · edges resize · middle slides · wheel zooms · double-click a bar</span>
      <span class="lg-sp"></span>
      <span class="lg-faint">showing {{ scopeLength() }}</span>
      <button class="lg-btn xs" (click)="zoom(0.5)" title="Zoom in">+</button>
      <button class="lg-btn xs" (click)="zoom(2)" title="Zoom out">−</button>
      <button class="lg-btn xs" (click)="fit()" title="Zoom to the selection">⤢ Fit</button>
      <button class="lg-btn xs" (click)="showAll()" title="Show all your data">All data</button>
    </div>
    <div #ov class="lg-tl-ov" (pointerdown)="ovDown($event)" (pointermove)="ovMove($event)" (pointerup)="ovDrag = null" title="All your data - drag the box to move the view">
      <div class="bars">@for (b of overview(); track $index) {<i [style.height.%]="b.h"></i>}</div>
      @if (selection(); as s) { <div class="sel" [style.left.%]="ofr(s.from) * 100" [style.width.%]="Math.max(0.3, (ofr(s.to) - ofr(s.from)) * 100)"></div> }
      <div class="win" [style.left.%]="Math.max(0, ofr(scope().a)) * 100" [style.width.%]="Math.max(1, (Math.min(1, ofr(scope().b)) - Math.max(0, ofr(scope().a))) * 100)"></div>
    </div>
    <div #track class="lg-tl-track" (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up()" (pointerleave)="tip.set(null)"
         (dblclick)="dbl($event)" (wheel)="wheel($event)">
      <div class="bars">
        @for (b of main(); track $index) {
          <i [style.height.%]="b.total ? Math.max(8, (b.total / mainMax()) * 100) : 0" [title]="b.total + ' lines: ' + b.e + ' error, ' + b.w + ' warn, ' + b.n + ' other'">
            @if (b.e) { <b class="e" [style.height.%]="(b.e / b.total) * 100"></b> }
            @if (b.w) { <b class="w" [style.height.%]="(b.w / b.total) * 100"></b> }
            @if (b.n) { <b class="n" [style.height.%]="(b.n / b.total) * 100"></b> }
          </i>
        }
      </div>
      @if (brush(); as br) {
        <div class="brush" [style.left.%]="br.left" [style.width.%]="br.width">
          <div class="handle l" data-h="l"></div><div class="handle r" data-h="r"></div>
          <span class="hlab l">{{ label(selection()!.from) }}</span><span class="hlab r">{{ label(selection()!.to) }}</span>
          @if (count() !== null) { <span class="bcount">{{ count() }} lines</span> }
        </div>
      }
      @if (tip(); as t) { <div class="tip" [style.left.%]="t.x * 100">{{ t.text }}</div> }
    </div>
    <div class="lg-tl-axis">@for (a of axis(); track $index) {<span>{{ a }}</span>}</div>
    <div class="lg-tl-legend"><span class="e">ERROR</span><span class="w">WARN</span><span class="n">INFO and other</span></div>
  `,
})
export class LogTimelineComponent {
  private readonly api = inject(LogsApiService);
  readonly Math = Math;

  readonly sourceId = input.required<string>();
  /** The bar's filters (time excluded): the timeline shows the lines they keep. */
  readonly pills = input<readonly Pill[]>([]);
  readonly oldest = input.required<number>();
  readonly newest = input.required<number>();
  readonly selection = input<{ from: number; to: number } | null>(null);
  readonly zone = input('UTC');
  /** Lines in the selection, shown inside it (from the panel's count). */
  readonly count = input<number | null>(null);
  readonly selectionChange = output<{ from: number; to: number }>();

  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  private readonly ov = viewChild.required<ElementRef<HTMLElement>>('ov');

  readonly scope = signal({ a: 0, b: 1 });
  readonly overview = signal<{ h: number }[]>([]);
  readonly main = signal<Stack[]>([]);
  readonly tip = signal<{ x: number; text: string } | null>(null);
  private dragMode: 'l' | 'r' | 'move' | 'new' | null = null;
  private x0 = 0;
  private f0 = 0;
  private t0 = 0;
  private anchor = 0;
  ovDrag: { x: number; a: number; len: number } | null = null;
  private readonly mainReq = new Subject<{ a: number; b: number }>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.mainReq.pipe(
      debounceTime(80),
      switchMap((s) => this.api.histogram(this.sourceId(), this.q(s.a, s.b), MAIN_BUCKETS).pipe(catchError(() => of(null)))),
      takeUntilDestroyed(destroyRef),
    ).subscribe((h) => this.main.set(this.stacks(h)));
    // Overview: all the data, whenever the filters or the data's span change.
    effect(() => {
      const a = this.oldest();
      const b = Math.max(this.newest(), a + 1000);
      this.pills();
      untracked(() => this.api.histogram(this.sourceId(), this.q(a, b), OVERVIEW_BUCKETS).subscribe((h) => {
        const st = this.stacks(h);
        const max = Math.max(1, ...st.map((x) => x.total));
        this.overview.set(st.map((x) => ({ h: x.total ? Math.max(10, (x.total / max) * 100) : 0 })));
      }));
    });
    // The main view follows the selection from outside (calendar, times, words) - not while dragging on it.
    effect(() => {
      this.selection();
      this.pills();
      untracked(() => {
        if (!this.dragMode) this.fit(false);
        this.mainReq.next(this.scope());
      });
    });
  }

  private q(a: number, b: number) {
    return { pills: this.pills().filter((p) => !p.off), from: Math.floor(a), to: Math.ceil(b), limit: 1 };
  }

  private stacks(h: Histogram | null): Stack[] {
    return (h?.buckets ?? []).map((bk) => {
      let e = 0, w = 0, n = 0;
      for (const [lv, c] of Object.entries(bk.byLevel)) {
        if (lv === 'ERROR') e += c;
        else if (lv === 'WARN') w += c;
        else n += c;
      }
      return { e, w, n, total: e + w + n };
    });
  }

  readonly mainMax = computed(() => Math.max(1, ...this.main().map((b) => b.total)));
  readonly scopeLength = computed(() => lengthText(this.scope().b - this.scope().a));

  readonly axis = computed(() => {
    const { a, b } = this.scope();
    const long = b - a > 2 * 3_600_000;
    return [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const t = a + f * (b - a);
      return long ? fullText(t, this.zone()).slice(5, 16) : clockText(t, this.zone());
    });
  });

  readonly brush = computed(() => {
    const s = this.selection();
    if (!s) return null;
    const l = this.fr(s.from);
    const r = this.fr(s.to);
    if (r <= 0 || l >= 1) return null;
    const cl = Math.max(-0.02, l);
    const cr = Math.min(1.02, r);
    return { left: cl * 100, width: Math.max(0.4, (cr - cl) * 100) };
  });

  label(ms: number): string {
    const s = this.selection();
    const sameDay = s && wallClock(s.from, this.zone()).D === wallClock(s.to, this.zone()).D && s.to - s.from < 86_400_000;
    return sameDay ? clockText(ms, this.zone()) : fullText(ms, this.zone()).slice(5, 16);
  }

  fr(ms: number): number {
    const { a, b } = this.scope();
    return (ms - a) / (b - a);
  }

  ofr(ms: number): number {
    return (ms - this.oldest()) / Math.max(1, this.newest() - this.oldest());
  }

  private at(f: number): number {
    const { a, b } = this.scope();
    return a + f * (b - a);
  }

  /** The selection plus a third of its length either side (never below MIN_SCOPE); all the data without one. */
  fit(fetch = true): void {
    const s = this.selection();
    if (!s) {
      this.scope.set({ a: this.oldest(), b: Math.max(this.newest(), this.oldest() + MIN_SCOPE) });
    } else {
      const len = Math.max(s.to - s.from, MIN_SCOPE / 3);
      const pad = Math.max(len / 3, (MIN_SCOPE - len) / 2);
      this.scope.set({ a: s.from - pad, b: s.to + pad });
    }
    if (fetch) this.mainReq.next(this.scope());
  }

  showAll(): void {
    const span = Math.max(this.newest() - this.oldest(), MIN_SCOPE);
    this.scope.set({ a: this.oldest() - span * 0.01, b: this.oldest() + span * 1.01 });
    this.mainReq.next(this.scope());
  }

  zoom(k: number, center = 0.5): void {
    const c = this.at(center);
    const len = Math.max(MIN_SCOPE, (this.scope().b - this.scope().a) * k);
    this.scope.set({ a: c - len * center, b: c + len * (1 - center) });
    this.mainReq.next(this.scope());
  }

  private fx(e: MouseEvent, el: HTMLElement): number {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }

  private snap(ms: number): number {
    return Math.round(ms / 1000) * 1000;
  }

  down(e: PointerEvent): void {
    const el = this.track().nativeElement;
    el.setPointerCapture?.(e.pointerId);
    this.x0 = this.fx(e, el);
    const target = e.target as HTMLElement;
    const s = this.selection();
    if (target.dataset['h'] && s) this.dragMode = target.dataset['h'] as 'l' | 'r';
    else if (target.closest('.brush') && s) this.dragMode = 'move';
    else {
      this.dragMode = 'new';
      this.anchor = this.snap(this.at(this.x0));
      this.selectionChange.emit({ from: this.anchor, to: this.anchor });
    }
    this.f0 = s?.from ?? this.anchor;
    this.t0 = s?.to ?? this.anchor;
  }

  move(e: PointerEvent): void {
    const el = this.track().nativeElement;
    const x = this.fx(e, el);
    const k = Math.min(MAIN_BUCKETS - 1, Math.floor(x * MAIN_BUCKETS));
    const b = this.main()[k];
    this.tip.set({ x, text: `${fullText(this.at(x), this.zone())} · ${b?.total ?? 0} line${b?.total === 1 ? '' : 's'}` });
    if (!this.dragMode) return;
    const d = (x - this.x0) * (this.scope().b - this.scope().a);
    let from = this.f0;
    let to = this.t0;
    if (this.dragMode === 'move') {
      from = this.f0 + d;
      to = this.t0 + d;
    } else if (this.dragMode === 'l') from = Math.min(this.t0, this.f0 + d);
    else if (this.dragMode === 'r') to = Math.max(this.f0, this.t0 + d);
    else {
      const t = this.snap(this.at(x));
      from = Math.min(this.anchor, t);
      to = Math.max(this.anchor, t);
    }
    this.selectionChange.emit({ from: this.snap(from), to: this.snap(to) });
  }

  up(): void {
    const was = this.dragMode;
    this.dragMode = null;
    if (was && was !== 'move') this.fit();
  }

  dbl(e: MouseEvent): void {
    const x = this.fx(e, this.track().nativeElement);
    const { a, b } = this.scope();
    const w = (b - a) / MAIN_BUCKETS;
    const k = Math.min(MAIN_BUCKETS - 1, Math.floor(x * MAIN_BUCKETS));
    this.selectionChange.emit({ from: this.snap(a + k * w), to: this.snap(a + (k + 1) * w) });
  }

  wheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoom(e.deltaY > 0 ? 1.25 : 0.8, this.fx(e, this.track().nativeElement));
  }

  ovDown(e: PointerEvent): void {
    const el = this.ov().nativeElement;
    el.setPointerCapture?.(e.pointerId);
    const len = this.scope().b - this.scope().a;
    if (!(e.target as HTMLElement).classList.contains('win')) {
      const c = this.oldest() + this.fx(e, el) * (this.newest() - this.oldest());
      this.scope.set({ a: c - len / 2, b: c + len / 2 });
      this.mainReq.next(this.scope());
    }
    this.ovDrag = { x: this.fx(e, el), a: this.scope().a, len };
  }

  ovMove(e: PointerEvent): void {
    if (!this.ovDrag) return;
    const a = this.ovDrag.a + (this.fx(e, this.ov().nativeElement) - this.ovDrag.x) * (this.newest() - this.oldest());
    this.scope.set({ a, b: a + this.ovDrag.len });
    this.mainReq.next(this.scope());
  }
}
