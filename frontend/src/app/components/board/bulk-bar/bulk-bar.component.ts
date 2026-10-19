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
        @if (questions()) {
          <button type="button" class="action-btn" title="One offline HTML file with the selected cards' open questions - for someone outside Alfred"
                  (click)="questionsForm.emit()">⇩ Questions form ({{ questions() }})</button>
        }
        <button type="button" class="action-btn danger" title="Delete the selected cards with their history" (click)="action.emit('DELETE')">🗑 Delete…</button>
        @if (total() > count()) {
          <button type="button" class="board-link" (click)="selectAll.emit()">Select all {{ total() }}</button>
        }
        <button type="button" class="action-btn" title="Clear the selection" (click)="cleared.emit()">✕</button>
      </div>
    }`,
})
export class BulkBarComponent {
  readonly count = input(0);
  /** Cards on the board as filtered now - "Select all" picks them. */
  readonly total = input(0);
  /** Open questions on the selected cards (specs/037): the questions form counts these, not the cards. */
  readonly questions = input(0);
  readonly action = output<BulkAction>();
  readonly questionsForm = output<void>();
  readonly selectAll = output<void>();
  readonly cleared = output<void>();
}
