import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { msText } from '../../shared/utils/db-statement-display';
import { DbWindowService } from './db-window.service';

/**
 * The one thing database capture adds to a call card (mock: "◆ DB 49 · 9 writes · 1 failed · 10 flags"). No chip when
 * the call was not captured; a dimmed "◆ DB 0" when it was and nothing ran; pulsing "live" while the call is still
 * running. Summaries are batched by DbCaptureStateService - a page of cards costs one request.
 */
@Component({
  standalone: true,
  selector: 'app-db-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (dbState.showChips() && summary(); as s) {
      @if (s.statementCount === 0 && !live()) {
        <span class="db-chip off" title="The agent was attached and saw no statements for this call">◆ DB 0</span>
      } @else {
        <button type="button" class="db-chip" [class.live]="live()" title="Open this call's database statements" (click)="open($event)">
          ◆ DB {{ s.statementCount.toLocaleString() }}
          @if (s.writeCount) {<span class="sep">·</span> <span class="w">{{ s.writeCount }} writes</span>}
          @if (s.failedCount) {<span class="sep">·</span> <span class="x">{{ s.failedCount }} failed</span>}
          @if (s.flags.length) {<span class="sep">·</span> {{ s.flags.length }} flags}
          @if (!s.writeCount && !s.failedCount && !s.flags.length) {<span class="sep">·</span> {{ ms(s.dbMicros) }}}
          @if (live()) {<span class="sep">·</span> live}
          @if (s.endedEarly) {<span class="sep">·</span> <span class="x">capture ended early</span>}
        </button>
      }
    }
  `,
})
export class DbChipComponent implements OnInit {
  protected readonly dbState = inject(DbCaptureStateService);
  private readonly window = inject(DbWindowService);

  readonly call = input.required<CallRecord>();

  readonly summary = computed(() => this.dbState.summaries().get(this.call().id) ?? null);
  readonly live = computed(() => this.call().state === 'IN_PROGRESS' || (!!this.summary() && !this.summary()!.complete && !this.call().response && !this.call().error));

  ngOnInit(): void {
    this.dbState.requestSummary(this.call().id);
  }

  ms(micros: number): string {
    return msText(micros);
  }

  open(event: Event): void {
    event.stopPropagation();
    this.window.openCall(this.call());
  }
}
