import { Component, ElementRef, computed, output, signal, viewChild } from '@angular/core';
import { FLAG_LABELS } from '../../../core/models/board.models';
import { parseQuickAdd } from '../../../shared/utils/quick-add-parser';

/** One-line card entry (FR-008) with a live preview of what the line will make. Enter adds; `/` on the board focuses it. */
@Component({
  selector: 'app-quick-add',
  standalone: true,
  template: `
    <div class="board-quick">
      <input #box type="text" placeholder="Quick add:  bug! discount not saved #urgent #risk   (Enter)" [value]="text()"
             (input)="text.set(box.value)" (keydown.enter)="add()" (keydown.escape)="box.blur()" />
      <button type="button" class="action-btn primary" [disabled]="!parsed().title" (click)="add()">Add</button>
      @if (text().trim()) {
        <span class="board-quick-preview">
          @if (parsed().title; as t) {
            {{ parsed().kind }} “{{ t }}”@for (f of parsed().flags; track f) { · {{ flagLabels[f] }} }
          } @else { <span class="board-dim">Write a title after the prefix</span> }
        </span>
      }
    </div>`,
})
export class QuickAddComponent {
  readonly added = output<string>();
  readonly text = signal('');
  readonly parsed = computed(() => parseQuickAdd(this.text()));
  readonly flagLabels = FLAG_LABELS;
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  focus(): void {
    this.box().nativeElement.focus();
  }

  add(): void {
    if (!this.parsed().title) return;
    this.added.emit(this.text().trim());
    this.text.set('');
    this.box().nativeElement.value = '';
  }
}
