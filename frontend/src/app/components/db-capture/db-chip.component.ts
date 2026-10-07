import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, input, untracked } from '@angular/core';
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
        <button type="button" class="db-chip" [class.live]="live()" [class.failed]="s.failedCount > 0" [title]="tooltip()" (click)="open($event)">
          {{ s.failedCount ? '✖' : '◆' }} DB {{ s.statementCount.toLocaleString() }}
          @if (s.writeCount) {<span class="sep">·</span> <span class="w">{{ s.writeCount }} writes</span>}
          @if (s.failedCount) {<span class="sep">·</span> <span class="x">{{ s.failedCount }} failed</span>}
          @if (swallowed()) {<span class="sep">·</span> <span class="x">swallowed</span>}
          @if (s.flags.length) {<span class="sep">·</span> {{ s.flags.length }} flags}
          <span class="sep">·</span> {{ ms(s.dbMicros) }}
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
  /** Failed statements the call carried on past - it answered under 500 as if nothing happened. */
  readonly swallowed = computed(() => !!this.summary()?.flags.some((f) => f.type === 'FAILED_SWALLOWED'));

  /**
   * Names the failed statements on hover (mock: "#42 CALL LOG_… failed (42000) and was swallowed - the call still
   * answered 200"), from the flags the summary already carries - no extra request.
   */
  readonly tooltip = computed(() => {
    const s = this.summary();
    if (!s?.failedCount) return "Open this call's database statements";
    const status = this.call().response?.status;
    const lines = s.flags.filter((f) => f.type === 'FAILED' || f.type === 'FAILED_SWALLOWED').slice(0, 5).map((f) =>
      `#${f.seqs.join(', #')}${f.detail?.['table'] ? ` ${f.detail['table']}` : ''} failed${f.detail?.['error'] ? ` (${f.detail['error']})` : ''}`
      + (f.type === 'FAILED_SWALLOWED' ? ` and was swallowed - the call still answered ${status ?? 'normally'}` : ''));
    const more = s.failedCount > lines.length ? `\n…and ${s.failedCount - lines.length} more` : '';
    const what = lines.join('\n') || `${s.failedCount} statement${s.failedCount > 1 ? 's' : ''} failed`;
    return `${what}${more}\nClick to open the database window.`;
  });

  readonly live = computed(() => this.call().state === 'IN_PROGRESS' || (!!this.summary() && !this.summary()!.complete && !this.call().response && !this.call().error));

  constructor() {
    // The card can come on screen before the agent's first batch for the call has arrived (or while backend was
    // restarting): when the call finishes and there is still no summary, ask once more instead of showing no chip.
    effect(() => {
      const call = this.call();
      const done = call.state !== 'IN_PROGRESS' && (!!call.response || !!call.error);
      if (done && untracked(() => !this.summary())) this.dbState.refreshSummary(call.id);
    });
  }

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
