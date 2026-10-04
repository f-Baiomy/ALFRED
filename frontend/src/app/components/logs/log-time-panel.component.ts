import { Component, DestroyRef, computed, effect, inject, input, OnInit, output, signal, untracked } from '@angular/core';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Pill } from '../../core/models/logs.model';
import { LogsApiService } from '../../core/services/logs-api.service';
import {
  DAY, HOUR, clockText, dayText, endOfDay, fromWallClock, fullText, lengthText, monthName, pad, parseRangeWords, startOfDay,
  stepSpan, wallClock,
} from '../../shared/utils/logs-time-range';
import { ClockTime, LogClockDialComponent } from './log-clock-dial.component';
import { LogTimelineComponent } from './log-timeline.component';

/**
 * What the time panel applies: a preset relative to the newest line ("1h", "24h", ...), or a span;
 * `to` null with a `from` = up to now, still moving (live).
 */
export interface TimeRange {
  readonly preset?: string | null;
  readonly from?: number | null;
  readonly to?: number | null;
}

export const TIME_PRESETS: Record<string, { label: string; ms: number }> = {
  '15m': { label: 'Last 15 minutes', ms: 15 * 60_000 },
  '1h': { label: 'Last 1 hour', ms: HOUR },
  '6h': { label: 'Last 6 hours', ms: 6 * HOUR },
  '24h': { label: 'Last 24 hours', ms: DAY },
  '7d': { label: 'Last 7 days', ms: 7 * DAY },
};

type Side = 'from' | 'to';

/**
 * The explorer's time range panel (design B++): quick ranges and the recent ones; a range typed in words;
 * a calendar (days with lines are dotted); From / To with ▲▼ per hour, minute and second, typing, the
 * mouse wheel or a clock dial; "around From"; the length, which can be kept while either side moves;
 * To follows From until To is set; "To = now, keep moving"; the lines the range holds before applying;
 * ◀ ▶ to the previous / next window; and the timeline. All times are read and typed in `zone`.
 */
@Component({
  selector: 'app-log-time-panel',
  standalone: true,
  imports: [LogClockDialComponent, LogTimelineComponent],
  templateUrl: './log-time-panel.component.html',
})
export class LogTimePanelComponent implements OnInit {
  private readonly api = inject(LogsApiService);

  readonly sourceId = input.required<string>();
  readonly zone = input('UTC');
  /** The other clock (local when picking in UTC and the reverse), shown under each time. */
  readonly otherZone = input('UTC');
  readonly zoneLabel = input('UTC');
  readonly otherLabel = input('local');
  readonly oldest = input.required<number>();
  readonly newest = input.required<number>();
  readonly pills = input<readonly Pill[]>([]);
  readonly current = input<TimeRange | null>(null);
  readonly apply = output<TimeRange | null>();
  readonly cancel = output<void>();

  readonly from = signal<number | null>(null);
  readonly to = signal<number | null>(null);
  readonly preset = signal<string | null>(null);
  readonly follows = signal(true);
  readonly locked = signal(false);
  readonly live = signal(false);
  readonly words = signal('');
  readonly calY = signal(2026);
  readonly calM = signal(0);
  private picking: 'start' | 'end' = 'start';
  readonly calHint = signal('Click a start day, then an end day. • = has log lines.');
  readonly dayDots = signal<ReadonlySet<number>>(new Set());
  readonly count = signal<number | null>(null);
  readonly clockSide = signal<Side | null>(null);
  readonly recent = signal<{ from: number; to: number }[]>([]);
  readonly presets = Object.entries(TIME_PRESETS).map(([k, v]) => ({ k, label: v.label }));
  private readonly countReq = new Subject<void>();

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.countReq.pipe(
      debounceTime(150),
      switchMap(() => {
        const s = this.span();
        return this.api.lines(this.sourceId(), { pills: this.pills().filter((p) => !p.off), from: s.from ?? null, to: this.live() ? null : s.to ?? null, limit: 1 })
          .pipe(catchError(() => of(null)));
      }),
      takeUntilDestroyed(destroyRef),
    ).subscribe((p) => this.count.set(p ? p.total : null));
    effect(() => {
      this.from();
      this.to();
      this.live();
      untracked(() => this.countReq.next());
    });
    // Day dots: one histogram bucket per day of the month shown, in the zone being picked in.
    effect(() => {
      const y = this.calY();
      const m = this.calM();
      const z = this.zone();
      untracked(() => {
        const first = fromWallClock(y, m, 1, 0, 0, 0, z);
        const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const last = fromWallClock(y, m, days, 23, 59, 59, z) + 999;
        this.api.histogram(this.sourceId(), { pills: [], from: first, to: last, limit: 1 }, days).subscribe((h) => {
          const set = new Set<number>();
          h.buckets.forEach((b, i) => {
            if (Object.values(b.byLevel).some((c) => c > 0)) set.add(i + 1);
          });
          this.dayDots.set(set);
        });
      });
    });
  }

  ngOnInit(): void {
    const c = this.current();
    if (c?.preset && TIME_PRESETS[c.preset]) {
      this.preset.set(c.preset);
      this.from.set(this.newest() - TIME_PRESETS[c.preset].ms);
      this.to.set(this.newest());
      this.follows.set(false);
    } else if (c) {
      this.from.set(c.from ?? null);
      this.to.set(c.to ?? null);
      this.live.set(c.from != null && c.to == null);
      this.follows.set(false);
    }
    const p = wallClock(this.from() ?? this.newest(), this.zone());
    this.calY.set(p.Y);
    this.calM.set(p.M);
    this.recent.set(this.readRecent());
  }

  /** The draft as a span (null sides = the oldest / newest line). */
  span(): { from: number | null; to: number | null } {
    return { from: this.from(), to: this.to() };
  }

  // ---- display
  readonly bad = computed(() => this.from() !== null && this.to() !== null && this.from()! > this.to()!);
  readonly lengthWords = computed(() => (this.from() !== null && this.to() !== null ? lengthText(this.to()! - this.from()!) : ''));
  readonly selection = computed(() => {
    const f = this.from();
    const t = this.live() ? this.newest() : this.to();
    return f === null && t === null ? null : { from: f ?? this.oldest(), to: t ?? this.newest() };
  });
  readonly searchNote = computed(() => {
    const f = this.from();
    const t = this.to();
    if (f === null && t === null) return null;
    return {
      from: f !== null ? fullText(f, 'UTC') : 'the oldest line',
      to: this.live() ? 'now (keeps moving)' : t !== null ? fullText(t, 'UTC') : 'the newest line',
    };
  });

  day(ms: number | null): string {
    return ms === null ? '' : dayText(ms, this.zone());
  }

  twin(ms: number | null): string {
    return ms === null ? '' : `${fullText(ms, this.otherZone())} ${this.otherLabel()}`;
  }

  parts(ms: number | null): { h: string; m: string; s: string } | null {
    if (ms === null) return null;
    const p = wallClock(ms, this.zone());
    return { h: pad(p.h), m: pad(p.m), s: pad(p.s) };
  }

  readonly monthTitle = computed(() => `${monthName(this.calM())} ${this.calY()}`);

  readonly cells = computed(() => {
    const y = this.calY();
    const m = this.calM();
    const z = this.zone();
    const first = fromWallClock(y, m, 1, 12, 0, 0, z);
    const lead = (wallClock(first, z).dow + 6) % 7; // weeks start on Monday
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const fk = this.from() !== null ? startOfDay(this.from()!, z) : null;
    const tk = this.to() !== null ? startOfDay(this.to()!, z) : null;
    const out: { d: number | null; sel: boolean; inr: boolean; dot: boolean }[] = [];
    for (let i = 0; i < lead; i++) out.push({ d: null, sel: false, inr: false, dot: false });
    for (let d = 1; d <= days; d++) {
      const k = fromWallClock(y, m, d, 0, 0, 0, z);
      out.push({ d, sel: k === fk || k === tk, inr: fk !== null && tk !== null && k > fk && k < tk, dot: this.dayDots().has(d) });
    }
    return out;
  });

  // ---- changes
  /** Sets one side; with the length kept the other side moves too; To follows From until To is set. */
  set(side: Side, ms: number, byUser = true): void {
    const len = this.from() !== null && this.to() !== null ? this.to()! - this.from()! : 0;
    this.preset.set(null);
    if (side === 'from') {
      this.from.set(ms);
      if (this.locked()) this.to.set(ms + len);
      else if (this.follows()) this.to.set(ms);
    } else {
      this.to.set(ms);
      if (this.locked()) this.from.set(ms - len);
      else if (byUser) this.follows.set(false);
    }
  }

  quick(k: string): void {
    const p = TIME_PRESETS[k];
    this.preset.set(k);
    this.from.set(this.newest() - p.ms);
    this.to.set(this.newest());
    this.follows.set(false);
    this.live.set(false);
  }

  today(back: number): void {
    const start = startOfDay(Date.now() - back * DAY, this.zone());
    this.preset.set(null);
    this.from.set(start);
    this.to.set(endOfDay(start, this.zone()));
    this.follows.set(false);
  }

  allTime(): void {
    this.preset.set(null);
    this.from.set(null);
    this.to.set(null);
    this.live.set(false);
    this.follows.set(true);
  }

  useRecent(r: { from: number; to: number }): void {
    this.preset.set(null);
    this.from.set(r.from);
    this.to.set(r.to);
    this.follows.set(false);
    this.live.set(false);
  }

  month(d: number): void {
    let m = this.calM() + d;
    let y = this.calY();
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    this.calM.set(m);
    this.calY.set(y);
  }

  dayClick(d: number): void {
    const z = this.zone();
    if (this.picking === 'start' || (this.from() !== null && fromWallClock(this.calY(), this.calM(), d, 0, 0, 0, z) < startOfDay(this.from()!, z))) {
      const keep = this.from() !== null ? wallClock(this.from()!, z) : { h: 0, m: 0, s: 0 };
      const start = fromWallClock(this.calY(), this.calM(), d, keep.h, keep.m, keep.s, z);
      if (this.locked()) this.set('from', start);
      else {
        this.preset.set(null);
        this.from.set(start);
        this.to.set(fromWallClock(this.calY(), this.calM(), d, 23, 59, 59, z));
        this.follows.set(true);
      }
      this.picking = 'end';
      this.calHint.set('Now click the end day (or the same day again for one day).');
    } else {
      const keep = this.to() !== null ? wallClock(this.to()!, z) : { h: 23, m: 59, s: 59 };
      this.set('to', fromWallClock(this.calY(), this.calM(), d, keep.h, keep.m, keep.s, z));
      this.picking = 'start';
      this.calHint.set('Click a start day, then an end day. • = has log lines.');
    }
  }

  shortcut(side: Side, what: 'sod' | 'eod' | 'now' | 'oldest' | 'newest'): void {
    const base = (side === 'from' ? this.from() : this.to()) ?? this.newest();
    const v = what === 'sod' ? startOfDay(base, this.zone()) : what === 'eod' ? endOfDay(base, this.zone())
      : what === 'now' ? Math.floor(Date.now() / 1000) * 1000 : what === 'newest' ? this.newest() : this.oldest();
    this.set(side, v);
  }

  step(side: Side, unit: 'h' | 'm' | 's', delta: number): void {
    const cur = (side === 'from' ? this.from() : this.to()) ?? this.newest();
    this.set(side, cur + delta * (unit === 'h' ? HOUR : unit === 'm' ? 60_000 : 1000));
  }

  typed(side: Side, unit: 'h' | 'm' | 's', raw: string): void {
    const cur = (side === 'from' ? this.from() : this.to()) ?? this.newest();
    const p = wallClock(cur, this.zone());
    const n = Math.max(0, Math.min(unit === 'h' ? 23 : 59, parseInt(raw, 10) || 0));
    const t = { h: p.h, m: p.m, s: p.s, [unit]: n };
    this.set(side, fromWallClock(p.Y, p.M, p.D, t.h, t.m, t.s, this.zone()));
  }

  wheelStep(e: WheelEvent, side: Side, unit: 'h' | 'm' | 's'): void {
    e.preventDefault();
    this.step(side, unit, e.deltaY < 0 ? 1 : -1);
  }

  around(min: number): void {
    const c = this.from() ?? this.newest();
    this.preset.set(null);
    this.from.set(c - min * 60_000);
    this.to.set(c + min * 60_000);
    this.follows.set(false);
  }

  toggleLock(): void {
    if (this.from() === null || this.to() === null) return;
    this.locked.update((v) => !v);
  }

  stepWindow(dir: number): void {
    if (this.from() === null || this.to() === null) return;
    const s = stepSpan({ from: this.from()!, to: this.to()! }, dir);
    this.preset.set(null);
    this.from.set(s.from);
    this.to.set(s.to);
  }

  readonly wordsResult = computed(() => {
    const r = parseRangeWords(this.words(), this.zone(), this.newest());
    if (r === null) return null;
    if (r === undefined) return { ok: false, text: 'not understood yet' };
    return { ok: true, text: `✓ ${fullText(r.from, this.zone())} → ${fullText(r.to, this.zone())} - Enter to use` };
  });

  useWords(): void {
    const r = parseRangeWords(this.words(), this.zone(), this.newest());
    if (!r) return;
    this.preset.set(null);
    this.from.set(r.from);
    this.to.set(r.to);
    this.follows.set(false);
    const p = wallClock(r.from, this.zone());
    this.calY.set(p.Y);
    this.calM.set(p.M);
  }

  fromTimeline(s: { from: number; to: number }): void {
    this.preset.set(null);
    this.from.set(s.from);
    this.to.set(s.to);
    this.follows.set(false);
    this.live.set(false);
  }

  openClock(side: Side): void {
    this.clockSide.set(this.clockSide() === side ? null : side);
  }

  clockTime(side: Side): ClockTime {
    const p = wallClock((side === 'from' ? this.from() : this.to()) ?? this.newest(), this.zone());
    return { h: p.h, m: p.m, s: p.s };
  }

  readonly nowInZone = (): ClockTime => {
    const p = wallClock(Date.now(), this.zone());
    return { h: p.h, m: p.m, s: p.s };
  };

  clockOk(side: Side, t: ClockTime): void {
    const base = (side === 'from' ? this.from() : this.to()) ?? (side === 'from' ? this.to() : this.from()) ?? Date.now();
    const p = wallClock(base, this.zone());
    this.clockSide.set(null);
    this.set(side, fromWallClock(p.Y, p.M, p.D, t.h, t.m, t.s, this.zone()));
  }

  // ---- apply
  doApply(): void {
    if (this.bad()) return;
    const f = this.from();
    const t = this.to();
    let r: TimeRange | null;
    if (this.preset()) r = { preset: this.preset() };
    else if (f === null && t === null) r = null;
    else r = { from: f, to: this.live() ? null : t };
    if (r && !r.preset && r.from != null && r.to != null) this.remember({ from: r.from, to: r.to });
    this.apply.emit(r);
  }

  private recentKey(): string {
    return `alfred.logs.recentRanges.${this.sourceId()}`;
  }

  private readRecent(): { from: number; to: number }[] {
    try {
      const v = JSON.parse(localStorage.getItem(this.recentKey()) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x?.from === 'number' && typeof x?.to === 'number').slice(0, 5) : [];
    } catch {
      return [];
    }
  }

  private remember(r: { from: number; to: number }): void {
    const list = [r, ...this.readRecent().filter((x) => x.from !== r.from || x.to !== r.to)].slice(0, 5);
    try {
      localStorage.setItem(this.recentKey(), JSON.stringify(list));
    } catch {
      // Recent ranges are a convenience only.
    }
  }

  recentText(r: { from: number; to: number }): string {
    const same = dayText(r.from, this.zone()) === dayText(r.to, this.zone());
    return `${fullText(r.from, this.zone()).slice(5, 16)} → ${same ? clockText(r.to, this.zone()).slice(0, 5) : fullText(r.to, this.zone()).slice(5, 16)}`;
  }
}
