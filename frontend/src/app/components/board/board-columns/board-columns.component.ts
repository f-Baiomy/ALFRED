import { Component, computed, input, output } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ALL_STATUSES, CardStatus, CardSummary, STATUS_LABELS } from '../../../core/models/board.models';
import { BoardCardComponent, CardAction } from '../board-card/board-card.component';

/** A move a drop asks for. Dropping on Closed is not a move - closing needs a resolution, so it opens the card. */
export interface CardDrop {
  readonly card: CardSummary;
  readonly to: CardStatus;
}

/** The board's columns (FR-004): drag a card to another open column to move it (FR-007). */
@Component({
  selector: 'app-board-columns',
  standalone: true,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, BoardCardComponent],
  template: `
    <div class="board-columns" cdkDropListGroup>
      @for (col of columns(); track col.status) {
        <div class="board-col" [class.side]="col.status === 'CLOSED'" cdkDropList [cdkDropListData]="col.status"
             [cdkDropListDisabled]="!editable()" (cdkDropListDropped)="onDrop($event)">
          <div class="board-col-head">
            <span>{{ col.label }}</span>
            <span class="board-col-count">
              @if (col.status === 'INBOX' && col.cards.length && editable()) {
                <button type="button" class="board-triage-btn" (click)="triage.emit()">Triage {{ col.cards.length }} ›</button>
              }
              {{ col.cards.length }}
            </span>
          </div>
          @for (c of col.cards; track c.id) {
            <app-board-card cdkDrag [cdkDragData]="c" [cdkDragDisabled]="!editable()" [card]="c" [editable]="editable()"
                            [selected]="selected().has(c.id)" [focused]="focusedId() === c.id" [showCycle]="showCycle()" [now]="now()"
                            (opened)="opened.emit(c)" (toggled)="toggled.emit(c)" (action)="action.emit({ card: c, action: $event })" />
          } @empty {
            <div class="board-empty">{{ col.status === 'INBOX' ? 'Inbox clear ✓ - new findings land here' : 'Drop cards here' }}</div>
          }
        </div>
      }
    </div>`,
})
export class BoardColumnsComponent {
  readonly cards = input.required<readonly CardSummary[]>();
  readonly editable = input(true);
  readonly selected = input<ReadonlySet<string>>(new Set());
  readonly focusedId = input<string | null>(null);
  readonly showCycle = input(true);
  readonly now = input(Date.now());
  readonly moved = output<CardDrop>();
  readonly opened = output<CardSummary>();
  readonly toggled = output<CardSummary>();
  readonly action = output<{ card: CardSummary; action: CardAction }>();
  readonly triage = output<void>();

  readonly columns = computed(() => ALL_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    cards: this.cards().filter((c) => c.status === status),
  })));

  onDrop(event: CdkDragDrop<CardStatus, CardStatus, CardSummary>): void {
    const card = event.item.data;
    const to = event.container.data;
    if (!card || to === card.status) return;
    if (to === 'CLOSED') {
      this.opened.emit(card);
      return;
    }
    if (card.status === 'CLOSED') return;
    this.moved.emit({ card, to });
  }
}
