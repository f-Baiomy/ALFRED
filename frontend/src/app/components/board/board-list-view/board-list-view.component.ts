import { Component, input, output } from '@angular/core';
import { CardSummary, FLAG_LABELS, RESOLUTION_LABELS, STATUS_LABELS, ageText } from '../../../core/models/board.models';

/** The same cards as a dense table (FR-010): for long boards and sorting at a glance. */
@Component({
  selector: 'app-board-list-view',
  standalone: true,
  template: `
    <table class="board-list">
      <thead><tr><th></th><th>#</th><th>Kind</th><th>Title</th><th>Flags</th><th>Status</th><th>Cycle</th><th>By</th><th>Age</th></tr></thead>
      <tbody>
        @for (c of cards(); track c.id) {
          <tr [class.focused]="focusedId() === c.id" (click)="opened.emit(c)">
            <td>
              @if (editable()) {
                <button type="button" class="board-card-check" [class.on]="selected().has(c.id)" (click)="$event.stopPropagation(); toggled.emit(c)">
                  {{ selected().has(c.id) ? '✓' : '' }}</button>
              }
            </td>
            <td class="board-dim">#{{ c.number }}</td>
            <td><span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ c.kind }}</span></td>
            <td>{{ c.title }}</td>
            <td>@for (f of c.flags; track f) { <span class="board-flag" [class]="'board-flag board-flag-' + f">{{ flagLabels[f] }}</span> }</td>
            <td>@if (c.resolution) { <span class="board-res" [class]="'board-res board-res-' + c.resolution">{{ resolutionLabels[c.resolution] }}</span> } @else { {{ statusLabels[c.status] }} }</td>
            <td class="board-cyc">{{ c.cycleId ? (c.cycleDeleted ? 'cycle deleted' : '◷ ' + c.cycleId) : '' }}</td>
            <td>@if (c.author === 'CLAUDE') { <span class="board-ai">✦ Claude</span> } @else { You }</td>
            <td class="board-dim">{{ age(c.updatedAt) }}</td>
          </tr>
        } @empty {
          <tr><td colspan="9" class="board-empty">No cards match.</td></tr>
        }
      </tbody>
    </table>`,
})
export class BoardListViewComponent {
  readonly cards = input.required<readonly CardSummary[]>();
  readonly editable = input(true);
  readonly selected = input<ReadonlySet<string>>(new Set());
  readonly focusedId = input<string | null>(null);
  readonly now = input(Date.now());
  readonly opened = output<CardSummary>();
  readonly toggled = output<CardSummary>();

  readonly flagLabels = FLAG_LABELS;
  readonly resolutionLabels = RESOLUTION_LABELS;
  readonly statusLabels = STATUS_LABELS;

  age(iso: string): string {
    return ageText(iso, this.now());
  }
}
