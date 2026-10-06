import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, effect, inject, input, untracked } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CALL_ORIGIN } from '../../core/state/call-origin.token';
import { CallLogCountsService } from '../../core/state/call-log-counts.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { DbWindowService } from './db-window.service';

/**
 * "▤ Logs 11 · 1 error · 2 warn" beside ◆ on a call card (specs/008-logs-call-link, walkthrough "Call list"): the
 * application log lines written during the call. Counts are fetched only while the card is on screen, batched by
 * CallLogCountsService; nothing shows when the call has no linked line. A click opens the window on its Logs view.
 */
@Component({
  standalone: true,
  selector: 'app-log-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host { display: inline-flex; min-width: 1px; min-height: 1px; }'],
  template: `
    @if (counts(); as c) {
      <button type="button" class="db-chip log-chip" [class.failed]="c.errors > 0" [title]="title()" (click)="open($event)">
        ▤ Logs {{ c.lines.toLocaleString() }}
        @if (c.errors) {<span class="sep">·</span> <span class="x">{{ c.errors }} {{ c.errors === 1 ? 'error' : 'errors' }}</span>}
        @if (c.warnings) {<span class="sep">·</span> <span class="w">{{ c.warnings }} warn</span>}
        @if (c.matchedBy === 'EXACT') {<span class="pill exact">exact</span>}
      </button>
    }
  `,
})
export class LogChipComponent implements OnInit {
  private readonly countsState = inject(CallLogCountsService);
  private readonly dbState = inject(DbCaptureStateService);
  private readonly window = inject(DbWindowService);
  private readonly origin = inject(CALL_ORIGIN, { optional: true });
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly call = input.required<CallRecord>();

  readonly counts = computed(() => this.countsState.counts().get(this.call().id) ?? null);
  readonly title = computed(() => {
    const c = this.counts();
    if (!c) return '';
    return `${c.lines} log line${c.lines === 1 ? '' : 's'} written during this call, matched ${c.matchedBy === 'EXACT' ? 'exactly by its call id' : 'by request thread and time'} - click to see them`;
  });

  constructor() {
    // ▤ turned on or off for the call's project: its numbers follow.
    let was: boolean | null = null;
    effect(() => {
      const on = !!this.dbState.projectStatus(this.call().service_name)?.logsOn;
      untracked(() => {
        if (was !== null && was !== on && this.visible) this.countsState.refresh(this.call().id);
        was = on;
      });
    });
  }

  private visible = false;

  ngOnInit(): void {
    const id = this.call().id;
    if (typeof IntersectionObserver === 'undefined') {
      this.countsState.show(id);
      this.visible = true;
      this.destroyRef.onDestroy(() => this.countsState.hide(id));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const on = entries.some((e) => e.isIntersecting);
      if (on === this.visible) return;
      this.visible = on;
      if (on) this.countsState.show(id);
      else this.countsState.hide(id);
    }, { rootMargin: '200px 0px' });
    observer.observe(this.host.nativeElement);
    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      if (this.visible) this.countsState.hide(id);
    });
  }

  open(event: Event): void {
    event.stopPropagation();
    this.window.openCall(this.call(), 'logs', this.origin?.cycleId() ?? null);
  }
}
