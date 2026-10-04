import { Component, ElementRef, computed, input, OnInit, output, signal, viewChild } from '@angular/core';

export interface ClockTime {
  readonly h: number;
  readonly m: number;
  readonly s: number;
}

interface DialMark {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly inner: boolean;
  readonly sel: boolean;
}

/**
 * A clock dial for one time of day: the hour first (outer ring 1-12, inner ring 13-00), then minutes,
 * then seconds - click or drag around the dial; HH / MM / SS at the top go back to a step.
 */
@Component({
  selector: 'app-log-clock-dial',
  standalone: true,
  template: `
    <div class="lg-clock" (click)="$event.stopPropagation()" (keydown.escape)="cancel.emit()">
      <div class="lg-clock-h">
        <button [class.on]="stage() === 'h'" (click)="stage.set('h')">{{ two(h()) }}</button>:<button [class.on]="stage() === 'm'" (click)="stage.set('m')">{{ two(m()) }}</button>:<button [class.on]="stage() === 's'" (click)="stage.set('s')">{{ two(s()) }}</button>
      </div>
      <svg #dial viewBox="-110 -110 220 220" width="220" height="220" (pointerdown)="down($event)" (pointermove)="move($event)" (pointerup)="up()" role="slider"
           [attr.aria-label]="stage() === 'h' ? 'Hour' : stage() === 'm' ? 'Minute' : 'Second'" [attr.aria-valuenow]="current()">
        <circle r="104" class="face" />
        <line x1="0" y1="0" [attr.x2]="hand().x" [attr.y2]="hand().y" class="hand" />
        <circle r="3" class="pivot" />
        <circle [attr.cx]="hand().x" [attr.cy]="hand().y" r="14" class="knob" />
        @if (stage() !== 'h' && current() % 5) { <circle [attr.cx]="hand().x" [attr.cy]="hand().y" r="3" class="dot" /> }
        @for (k of marks(); track k.text + k.inner) {
          <text [attr.x]="k.x" [attr.y]="k.y" [class.in]="k.inner" [class.sel]="k.sel">{{ k.text }}</text>
        }
      </svg>
      <div class="lg-clock-f">
        <button class="lg-link" (click)="now()">Now</button>
        <span class="lg-sp"></span>
        <button class="lg-btn sm" (click)="cancel.emit()">Cancel</button>
        <button class="lg-btn sm primary" (click)="ok.emit({ h: h(), m: m(), s: s() })">OK</button>
      </div>
    </div>
  `,
})
export class LogClockDialComponent implements OnInit {
  readonly time = input<ClockTime>({ h: 0, m: 0, s: 0 });
  /** "Now" in the zone the picker works in. */
  readonly nowTime = input<() => ClockTime>(() => {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
  });
  readonly ok = output<ClockTime>();
  readonly cancel = output<void>();

  private readonly dial = viewChild.required<ElementRef<SVGSVGElement>>('dial');
  readonly stage = signal<'h' | 'm' | 's'>('h');
  readonly h = signal(0);
  readonly m = signal(0);
  readonly s = signal(0);
  private dragging = false;

  ngOnInit(): void {
    const t = this.time();
    this.h.set(t.h);
    this.m.set(t.m);
    this.s.set(t.s);
  }

  readonly current = computed(() => (this.stage() === 'h' ? this.h() : this.stage() === 'm' ? this.m() : this.s()));

  private pos(frac: number, r: number): { x: number; y: number } {
    return { x: Math.sin(frac * 2 * Math.PI) * r, y: -Math.cos(frac * 2 * Math.PI) * r };
  }

  readonly hand = computed(() => {
    if (this.stage() === 'h') {
      const h = this.h();
      return this.pos((h % 12) / 12, h >= 1 && h <= 12 ? 86 : 58);
    }
    return this.pos(this.current() / 60, 86);
  });

  readonly marks = computed<DialMark[]>(() => {
    const out: DialMark[] = [];
    if (this.stage() === 'h') {
      for (let i = 1; i <= 12; i++) out.push({ ...this.pos(i / 12, 86), text: String(i), inner: false, sel: this.h() === i });
      for (let i = 13; i <= 24; i++) {
        const v = i % 24;
        out.push({ ...this.pos((i - 12) / 12, 58), text: this.two(v), inner: true, sel: this.h() === v });
      }
    } else {
      for (let i = 0; i < 60; i += 5) out.push({ ...this.pos(i / 60, 86), text: this.two(i), inner: false, sel: this.current() === i });
    }
    return out;
  });

  two(n: number): string {
    return String(n).padStart(2, '0');
  }

  down(e: PointerEvent): void {
    this.dragging = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this.pick(e);
  }

  move(e: PointerEvent): void {
    if (this.dragging) this.pick(e);
  }

  /** Letting go moves on: hour → minutes → seconds. */
  up(): void {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.stage() === 'h') this.stage.set('m');
    else if (this.stage() === 'm') this.stage.set('s');
  }

  now(): void {
    const t = this.nowTime()();
    this.h.set(t.h);
    this.m.set(t.m);
    this.s.set(t.s);
  }

  private pick(e: PointerEvent): void {
    const r = this.dial().nativeElement.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 220 - 110;
    const y = ((e.clientY - r.top) / r.height) * 220 - 110;
    let f = Math.atan2(x, -y) / (2 * Math.PI);
    if (f < 0) f += 1;
    if (this.stage() === 'h') {
      const n = Math.round(f * 12) % 12;
      this.h.set(Math.hypot(x, y) < 72 ? (n === 0 ? 0 : n + 12) : n === 0 ? 12 : n);
    } else {
      const v = Math.round(f * 60) % 60;
      (this.stage() === 'm' ? this.m : this.s).set(v);
    }
  }
}
