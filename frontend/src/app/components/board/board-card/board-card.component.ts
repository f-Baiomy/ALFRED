import { Component, computed, input, output } from '@angular/core';
import {
  CardStatus, CardSummary, FLAG_LABELS, Proposal, RESOLUTION_BUTTONS, RESOLUTION_LABELS, Resolution, ageText, isStale,
} from '../../../core/models/board.models';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { proposalTarget } from '../../../shared/utils/board-activity';

/** What a card asks of its board: one sort action, a reopen, or a selection toggle. */
export type CardAction =
  | { readonly kind: 'close'; readonly resolution: Resolution }
  | { readonly kind: 'move'; readonly status: CardStatus }
  | { readonly kind: 'reopen' };

/**
 * One card on the board (mock-v2): kind, flags, title, the first mentions, number, author, cycle, comments, scope and
 * age. Inbox cards carry the one-click sort (Fine / Not in flow / To do), closed ones their resolution and Reopen.
 */
@Component({
  selector: 'app-board-card',
  standalone: true,
  imports: [MentionChipComponent],
  template: `
    <div class="board-card" [class.selected]="selected()" [class.focused]="focused()" [class.closed]="card().status === 'CLOSED'"
         [attr.data-card]="card().id" tabindex="-1" (click)="onClick($event)">
      @if (editable()) {
        <button type="button" class="board-card-check" [class.on]="selected()" title="Select (X or Shift+click)"
                (click)="$event.stopPropagation(); toggled.emit()">{{ selected() ? '✓' : '' }}</button>
      }
      <div class="board-card-row">
        <span class="board-kind" [class]="'board-kind board-kind-' + card().kind">{{ card().kind }}</span>
        @for (f of card().flags; track f) { <span class="board-flag" [class]="'board-flag board-flag-' + f">{{ flagLabel(f) }}</span> }
      </div>
      <div class="board-card-title">{{ card().title }}</div>
      @if (card().mentionChips?.length) {
        <div class="board-card-row">
          @for (m of card().mentionChips; track m.type + m.ref) { <app-mention-chip [mention]="m" [showPreview]="false" /> }
        </div>
      }
      <div class="board-card-foot">
        <span>#{{ card().number }}</span>
        @if (card().author === 'CLAUDE') { <span class="board-ai">✦ Claude</span> }
        @if (showCycle() && card().cycleId) {
          <span class="board-cyc" [class.gone]="card().cycleDeleted">◷ {{ card().cycleDeleted ? 'cycle deleted' : cycleLabel() }}</span>
        }
        @if (card().commentCount) { <span>💬 {{ card().commentCount }}</span> }
        @if (!card().resolution) {
          <span class="board-scope" [class.in]="card().scope === 'IN_SCOPE'" [class.out]="card().scope === 'OUT_OF_SCOPE'">{{ scopeText() }}</span>
        }
        <span class="board-age" [class.stale]="stale()" [title]="stale() ? 'No change for more than 5 days' : ''">{{ stale() ? '⏳ ' : '' }}{{ age() }}</span>
      </div>
      @if (card().resolution; as r) {
        <div class="board-card-row"><span class="board-res" [class]="'board-res board-res-' + r">{{ resolutionLabel(r) }}</span></div>
        @if (card().reason) { <div class="board-card-reason">“{{ card().reason }}”</div> }
      }
      @if (card().status === 'INBOX' && card().similarClosed; as s) {
        <div class="board-sim">⚠ Looks like #{{ s.number }}, closed as {{ resolutionLabel(s.resolution) }}{{ s.reason ? ': ' + s.reason : '' }}</div>
      }
      @if (card().proposal; as p) {
        <div class="board-card-proposal" title="Open the card to accept or dismiss">✦ Claude proposes {{ proposalText(p) }}</div>
      }
      @if (editable() && card().status === 'INBOX') {
        <div class="board-card-acts">
          <button type="button" class="ok" title="Fine - not an issue (F)" (click)="act($event, { kind: 'close', resolution: 'FINE' })">{{ buttons.FINE }}</button>
          <button type="button" title="Not in this flow (N)" (click)="act($event, { kind: 'close', resolution: 'NOT_IN_FLOW' })">{{ buttons.NOT_IN_FLOW }}</button>
          <button type="button" title="To do (T)" (click)="act($event, { kind: 'move', status: 'TO_DO' })">→ To do</button>
        </div>
      }
      @if (editable() && card().status === 'CLOSED') {
        <div class="board-card-acts"><button type="button" (click)="act($event, { kind: 'reopen' })">↺ Reopen</button></div>
      }
    </div>`,
})
export class BoardCardComponent {
  readonly card = input.required<CardSummary>();
  readonly selected = input(false);
  readonly focused = input(false);
  readonly editable = input(true);
  readonly showCycle = input(true);
  readonly cycleName = input<string | null>(null);
  readonly now = input(Date.now());
  readonly opened = output<void>();
  readonly toggled = output<void>();
  readonly action = output<CardAction>();

  readonly buttons = RESOLUTION_BUTTONS;
  readonly stale = computed(() => isStale(this.card(), this.now()));
  readonly age = computed(() => ageText(this.card().updatedAt, this.now()));
  readonly cycleLabel = computed(() => this.cycleName() ?? this.card().cycleId ?? '');
  readonly scopeText = computed(() => {
    const s = this.card().scope;
    return s === 'IN_SCOPE' ? 'in scope' : s === 'OUT_OF_SCOPE' ? 'out of scope' : 'scope?';
  });

  flagLabel(f: keyof typeof FLAG_LABELS): string {
    return FLAG_LABELS[f];
  }

  proposalText(p: Proposal): string {
    return proposalTarget(p.status === 'CLOSED' && p.resolution ? `CLOSED:${p.resolution}` : p.status);
  }

  resolutionLabel(r: Resolution): string {
    return RESOLUTION_LABELS[r];
  }

  onClick(event: MouseEvent): void {
    if (event.shiftKey && this.editable()) {
      this.toggled.emit();
      return;
    }
    this.opened.emit();
  }

  act(event: Event, action: CardAction): void {
    event.stopPropagation();
    this.action.emit(action);
  }
}
