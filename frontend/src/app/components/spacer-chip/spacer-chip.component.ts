import { Component, input, output, signal } from '@angular/core';
import { CycleSpacer } from '../../core/state/call-selection.tokens';

/**
 * The view/rename/delete pill for one spacer - dumb by design (no store access of its own) so it
 * renders identically in the flat, nested, and waterfall views, each of which wraps it with its own
 * drag handle and connecting lines - see CallListComponent/CallWaterfallComponent.
 */
@Component({
  selector: 'app-spacer-chip',
  standalone: true,
  template: `
    @if (editing()) {
      <div class="spacer-chip spacer-chip-editing">
        <input #renameInput type="text" [value]="spacer().label" (keydown.enter)="confirm(renameInput.value)" (keydown.escape)="cancel()" />
        <button type="button" class="spacer-icon-btn" (click)="confirm(renameInput.value)" aria-label="Save">&#10003;</button>
        <button type="button" class="spacer-icon-btn" (click)="cancel()" aria-label="Cancel">&#10005;</button>
      </div>
    } @else {
      <div class="spacer-chip">
        <span class="spacer-label">{{ spacer().label }}</span>
        <button type="button" class="spacer-icon-btn" (click)="editing.set(true)" aria-label="Rename spacer">&#9998;</button>
        <button type="button" class="spacer-icon-btn" (click)="remove.emit()" aria-label="Delete spacer">&#10005;</button>
      </div>
    }
  `,
})
export class SpacerChipComponent {
  readonly spacer = input.required<CycleSpacer>();
  readonly rename = output<string>();
  readonly remove = output<void>();

  readonly editing = signal(false);

  confirm(label: string): void {
    const trimmed = label.trim();
    if (trimmed) this.rename.emit(trimmed);
    this.editing.set(false);
  }

  cancel(): void {
    this.editing.set(false);
  }
}
