import { Component, OnDestroy, effect, input, output, signal } from '@angular/core';
import { RESOLUTION_LABELS } from '../../../core/models/board.models';
import { PendingUndo } from '../../../core/state/board-state.service';

/** How long the toast offers Undo and Add reason (FR-016: at least 6 s; the server allows 60 s). */
export const UNDO_TOAST_MS = 7000;

/**
 * "#9 closed: Fine - not an issue · Add reason · Undo" after a close (FR-016). One timer per close that hides it -
 * a single delay, not a refresh.
 */
@Component({
  selector: 'app-undo-toast',
  standalone: true,
  template: `
    @if (pending(); as p) {
      <div class="board-toast" role="status">
        <span>#{{ p.number }} closed: {{ labels[p.resolution] }}</span>
        @if (askingReason()) {
          <input #reason type="text" placeholder="Why? Claude reads this before it reports something similar" maxlength="2000"
                 (keydown.enter)="saveReason(reason.value)" (keydown.escape)="askingReason.set(false)" />
          <button type="button" class="action-btn primary" (click)="saveReason(reason.value)">Save</button>
        } @else {
          <button type="button" class="action-btn" (click)="askReason()">Add reason</button>
          <button type="button" class="action-btn" (click)="undo.emit()">Undo</button>
        }
        <button type="button" class="board-toast-x" title="Dismiss" (click)="dismissed.emit()">✕</button>
      </div>
    }`,
})
export class UndoToastComponent implements OnDestroy {
  readonly pending = input<PendingUndo | null>(null);
  readonly undo = output<void>();
  readonly reason = output<string>();
  readonly dismissed = output<void>();

  readonly labels = RESOLUTION_LABELS;
  readonly askingReason = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const p = this.pending();
      this.clear();
      this.askingReason.set(false);
      if (p) this.arm();
    }, { allowSignalWrites: true });
  }

  askReason(): void {
    this.clear(); // writing a reason keeps the toast open
    this.askingReason.set(true);
  }

  saveReason(text: string): void {
    if (text.trim()) this.reason.emit(text.trim());
    this.dismissed.emit();
  }

  ngOnDestroy(): void {
    this.clear();
  }

  private arm(): void {
    this.timer = setTimeout(() => this.dismissed.emit(), UNDO_TOAST_MS);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
