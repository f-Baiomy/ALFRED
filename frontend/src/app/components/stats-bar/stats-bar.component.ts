import { Component, inject, input } from '@angular/core';
import { CallStats } from '../../core/state/calls-state.service';
import { CALL_LIST_CONTROLS_STATE, BULK_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { isInProgress } from '../../shared/utils/call-utils';

/**
 * Each pill is clickable - selecting it replaces the current bulk selection with exactly the
 * calls in that bucket (not adding to whatever was already selected), so "click 4xx, then bulk
 * export" is a one-step way to act on just those calls. Bucket membership is recomputed here from
 * the same currently-loaded call list (CALL_LIST_CONTROLS_STATE.matchingCalls) using the exact
 * same rules call-list-view.ts's own `stats` computed already uses to produce the counts shown -
 * the two must never disagree about which calls count as "ok"/"4xx"/etc.
 */
@Component({
  selector: 'app-stats-bar',
  standalone: true,
  templateUrl: './stats-bar.component.html',
})
export class StatsBarComponent {
  private readonly controlsState = inject(CALL_LIST_CONTROLS_STATE);
  private readonly bulkSelection = inject(BULK_SELECTION_STATE);

  readonly stats = input.required<CallStats>();

  selectTotal(): void {
    this.bulkSelection.selectOnly(this.controlsState.matchingCalls());
  }

  selectInProgress(): void {
    this.bulkSelection.selectOnly(this.controlsState.matchingCalls().filter(isInProgress));
  }

  selectOk(): void {
    this.bulkSelection.selectOnly(this.controlsState.matchingCalls().filter((c) => c.response && c.response.status < 400));
  }

  selectClientError(): void {
    this.bulkSelection.selectOnly(
      this.controlsState.matchingCalls().filter((c) => c.response && c.response.status >= 400 && c.response.status < 500)
    );
  }

  selectFailed(): void {
    this.bulkSelection.selectOnly(
      this.controlsState.matchingCalls().filter((c: CallRecord) => c.error || (c.response && c.response.status >= 500))
    );
  }
}
