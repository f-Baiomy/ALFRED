import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, OnInit, computed, inject, input } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CALL_ORIGIN } from '../../core/state/call-origin.token';
import { CallStoreCountsService } from '../../core/state/call-store-counts.service';
import { msText } from '../../shared/utils/db-statement-display';
import { DbWindowService } from './db-window.service';

/**
 * "⬢ Redis 22 · 5 miss · 1 failed" beside ▤ on a call card (specs/011-redis-capture FR-013, mock section 2): the Redis
 * commands the call sent. Numbers are fetched only while the card is on screen (CallStoreCountsService, batched); no
 * chip when ⬢ was off for the call, a muted "⬢ Redis 0" when the agent saw none. A click opens the window on Redis.
 */
@Component({
  standalone: true,
  selector: 'app-redis-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host { display: inline-flex; min-width: 1px; min-height: 1px; }'],
  template: `
    @if (summary(); as s) {
      @if (s.commands === 0 && !s.live && !s.dropped) {
        <span class="db-chip redis-chip off" title="The agent was attached and saw no Redis command for this call">⬢ Redis 0</span>
      } @else {
        <button type="button" class="db-chip redis-chip" [class.failed]="s.failed > 0" [class.live]="s.live" [title]="title()" (click)="open($event)">
          ⬢ Redis {{ s.commands.toLocaleString() }}
          @if (s.misses) {<span class="sep">·</span> <span [class.m]="!s.failed">{{ s.misses }} miss</span>}
          @if (s.failed) {<span class="sep">·</span> <span class="x">{{ s.failed }} failed</span>}
          @if (!s.misses && !s.failed && s.commands) {<span class="sep">·</span> {{ ms(s.micros) }}}
          @if (s.live) {<span class="sep">·</span> live}
          @if (s.endedEarly) {<span class="sep">·</span> <span class="x">capture ended early</span>}
          @if (s.dropped) {<span class="sep">·</span> <span class="x">{{ s.dropped }} not kept</span>}
        </button>
      }
    }
  `,
})
export class RedisChipComponent implements OnInit {
  private readonly counts = inject(CallStoreCountsService);
  private readonly window = inject(DbWindowService);
  private readonly origin = inject(CALL_ORIGIN, { optional: true });
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly destroyRef = inject(DestroyRef);

  readonly call = input.required<CallRecord>();
  readonly summary = computed(() => this.counts.summaries().get(this.call().id) ?? null);
  readonly title = computed(() => {
    const s = this.summary();
    if (!s) return '';
    return `${s.commands} Redis command${s.commands === 1 ? '' : 's'} sent during this call` +
      (s.misses || s.failed ? ` - ${s.misses} missed, ${s.failed} failed` : '') + ' - click to see them';
  });

  protected ms(micros: number): string {
    return msText(micros);
  }

  private visible = false;

  ngOnInit(): void {
    const id = this.call().id;
    if (typeof IntersectionObserver === 'undefined') {
      this.counts.show(id);
      this.visible = true;
      this.destroyRef.onDestroy(() => this.counts.hide(id));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const on = entries.some((e) => e.isIntersecting);
      if (on === this.visible) return;
      this.visible = on;
      if (on) this.counts.show(id);
      else this.counts.hide(id);
    }, { rootMargin: '200px 0px' });
    observer.observe(this.host.nativeElement);
    this.destroyRef.onDestroy(() => {
      observer.disconnect();
      if (this.visible) this.counts.hide(id);
    });
  }

  open(event: Event): void {
    event.stopPropagation();
    this.window.openCall(this.call(), 'redis', this.origin?.cycleId() ?? null);
  }
}
