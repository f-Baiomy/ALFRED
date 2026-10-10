import { Component, input, output } from '@angular/core';
import { BulkAction } from '../../../core/models/board.models';

/** One action on every selected card (FR-018). */
@Component({
  selector: 'app-bulk-bar',
  standalone: true,
  template: `
    @if (count()) {
      <div class="board-bulk" role="toolbar">
        <b>{{ count() }}</b> selected
        <button type="button" class="action-btn" (click)="action.emit('FINE')">✓ Fine</button>
        <button type="button" class="action-btn" (click)="action.emit('NOT_IN_FLOW')">⊘ Not in flow</button>
        <button type="button" class="action-btn" (click)="action.emit('TO_DO')">→ To do</button>
        <button type="button" class="action-btn" (click)="action.emit('MARK_URGENT')">Mark urgent</button>
        <button type="button" class="action-btn" title="Clear the selection" (click)="cleared.emit()">✕</button>
      </div>
    }`,
})
export class BulkBarComponent {
  readonly count = input(0);
  readonly action = output<BulkAction>();
  readonly cleared = output<void>();
}
