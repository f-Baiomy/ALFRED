import { Component, computed, input, output } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup } from '@angular/cdk/drag-drop';
import { ALL_STATUSES, CardStatus, CardSummary, RetestCheck, STATUS_LABELS } from '../../../core/models/board.models';
import { BoardCardComponent, CardAction } from '../board-card/board-card.component';
import type { WaitingAnchor } from '../waiting-bar/waiting-bar.component';
import { highCards, worstFirst } from '../../../shared/utils/triage-advice';

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
                @if (high().length) {
                  <button type="button" class="board-triage-btn" title="Accept all High: take every advice Claude gave with High confidence - Medium and Low stay yours"
                          (click)="acceptHigh.emit(high())">✓ High {{ high().length }}</button>
                }
                <button type="button" class="board-triage-btn" (click)="triage.emit()">Triage {{ col.cards.length }} ›</button>
              }
              @if (col.status === 'FIXED' && col.cards.length && editable()) {
                @if (selectedFixed().length) {
                  <button type="button" class="board-triage-btn" title="Record a re-test of the selected Fixed cards"
                          (click)="retest.emit(selectedFixed())">▶ Re-test {{ selectedFixed().length }} selected</button>
                }
                <button type="button" class="board-triage-btn" title="Record a re-test of every Fixed card - their steps show on the strip"
                        (click)="retest.emit(numbersOf(col.cards))">▶ Re-test all {{ col.cards.length }}</button>
              }
              {{ col.cards.length }}
            </span>
          </div>
          @for (c of col.cards; track c.id) {
            <app-board-card cdkDrag [cdkDragData]="c" [cdkDragDisabled]="!editable()" [card]="c" [editable]="editable()"
                            [selected]="selected().has(c.id)" [focused]="focusedId() === c.id" [showCycle]="showCycle()" [now]="now()" [retest]="retests().get(c.number) ?? null" [viewBoard]="viewBoard()" [boardNames]="boardNames()"
                            (opened)="opened.emit(c)" (toggled)="toggled.emit(c)" (action)="$event.kind === 'retest' ? retest.emit([c.number]) : action.emit({ card: c, action: $event })" (answer)="answer.emit(c)"
                            (waitingOpen)="waiting.emit({ card: c, anchor: $event })" />
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
  readonly retests = input<ReadonlyMap<number, RetestCheck>>(new Map());
  readonly viewBoard = input<string | null>(null);
  readonly boardNames = input<ReadonlyMap<string, string>>(new Map());
  readonly moved = output<CardDrop>();
  /** ▶ Re-test for these card numbers (specs/016): one card, the selected ones or every Fixed card. */
  readonly retest = output<readonly number[]>();
  readonly opened = output<CardSummary>();
  readonly toggled = output<CardSummary>();
  readonly action = output<{ card: CardSummary; action: CardAction }>();
  readonly triage = output<void>();
  readonly answer = output<CardSummary>();
  /** A tile's waiting pill was clicked: the host opens the waiting bar under it. */
  readonly waiting = output<{ card: CardSummary; anchor: WaitingAnchor }>();
  /** "Accept all High" (triage): the Inbox cards whose advice Claude gave with High confidence. */
  readonly acceptHigh = output<readonly CardSummary[]>();

  readonly high = computed(() => highCards(this.cards()));

  readonly columns = computed(() => ALL_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    // The Inbox worst first when Claude ranked it (/alfred-triage); the other columns as the board orders them
    cards: status === 'INBOX' ? worstFirst(this.cards().filter((c) => c.status === status)) : this.cards().filter((c) => c.status === status),
  })));

  readonly selectedFixed = computed(() => this.cards().filter((c) => c.status === 'FIXED' && this.selected().has(c.id)).map((c) => c.number));

  numbersOf(cards: readonly CardSummary[]): number[] {
    return cards.map((c) => c.number);
  }

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
