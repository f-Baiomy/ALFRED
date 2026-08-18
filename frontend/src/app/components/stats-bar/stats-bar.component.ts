import { Component, inject, input } from '@angular/core';
import { CallStats, CallStatusFilter } from '../../core/state/calls-state.service';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';

/**
 * Each pill is clickable - clicking it narrows the visible call list down to exactly the calls in
 * that bucket, via CALL_LIST_CONTROLS_STATE.setStatusFilter (see call-list-view.ts). Clicking the
 * same pill again clears the filter back to "all". This never touches selection - it's purely
 * "show me these", not "select these for bulk actions".
 */
@Component({
  selector: 'app-stats-bar',
  standalone: true,
  templateUrl: './stats-bar.component.html',
})
export class StatsBarComponent {
  readonly controlsState = inject(CALL_LIST_CONTROLS_STATE);

  readonly stats = input.required<CallStats>();

  showFilter(filter: CallStatusFilter): void {
    this.controlsState.setStatusFilter(filter);
  }
}
