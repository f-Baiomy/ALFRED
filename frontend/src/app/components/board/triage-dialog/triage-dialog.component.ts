import { Component, HostListener, computed, input, output, signal } from '@angular/core';
import { CardSummary, FLAG_LABELS, RESOLUTION_LABELS, Resolution } from '../../../core/models/board.models';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';

/** One decision on one Inbox card. */
export type TriageDecision =
  | { readonly card: CardSummary; readonly kind: 'close'; readonly resolution: Resolution; readonly reason: string }
  | { readonly card: CardSummary; readonly kind: 'todo' };

/**
 * Triage mode (FR-017): the Inbox one card at a time, decided by button or key - F Fine, N Not in this flow, T To do,
 * S Skip - with an optional reason Claude reads later. Ends on "Inbox clear".
 */
@Component({
  selector: 'app-triage-dialog',
  standalone: true,
  imports: [MentionChipComponent],
  template: `
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog-card board-triage" (click)="$event.stopPropagation()">
        @if (current(); as c) {
          <div class="board-triage-top"><span>Triage Inbox · {{ index() + 1 }} of {{ queue().length }}</span><span>Esc to stop</span></div>
          <div class="board-triage-bar"><i [style.width.%]="(index() / queue().length) * 100"></i></div>
          <div class="board-card-row">
            <span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ c.kind }}</span>
            @for (f of c.flags; track f) { <span class="board-flag" [class]="'board-flag board-flag-' + f">{{ flagLabels[f] }}</span> }
            @if (c.author === 'CLAUDE') { <span class="board-ai">✦ Claude</span> }
          </div>
          <h2>#{{ c.number }} {{ c.title }}</h2>
          <div class="board-card-row">
            @for (m of c.mentionChips ?? []; track m.type + m.ref) { <app-mention-chip [mention]="m" /> }
          </div>
          @if (c.similarClosed; as s) {
            <div class="board-sim">⚠ Looks like #{{ s.number }}, closed as {{ resolutionLabels[s.resolution] }}{{ s.reason ? ': ' + s.reason : '' }}</div>
          }
          <input #reason class="board-triage-reason" type="text" maxlength="2000" placeholder="Reason (optional - Claude learns from it)"
                 [value]="reasonText()" (input)="reasonText.set(reason.value)" />
          <div class="board-triage-btns">
            <button type="button" class="ok" (click)="decide('F')">✓ Fine<kbd>F</kbd></button>
            <button type="button" (click)="decide('N')">⊘ Not in flow<kbd>N</kbd></button>
            <button type="button" (click)="decide('T')">→ To do<kbd>T</kbd></button>
            <button type="button" (click)="decide('S')">Skip<kbd>S</kbd></button>
          </div>
        } @else {
          <h2>Inbox clear ✓</h2>
          <p class="board-dim">{{ queue().length }} cards sorted. Claude reads your reasons before it reports something similar.</p>
          <button type="button" class="action-btn primary" (click)="closed.emit()">Back to the board</button>
        }
      </div>
    </div>`,
})
export class TriageDialogComponent {
  /** The Inbox when Triage opened - fixed for the run, so sorting a card does not reshuffle what comes next. */
  readonly queue = input.required<readonly CardSummary[]>();
  readonly decided = output<TriageDecision>();
  readonly closed = output<void>();

  readonly flagLabels = FLAG_LABELS;
  readonly resolutionLabels = RESOLUTION_LABELS;
  readonly index = signal(0);
  readonly reasonText = signal('');
  readonly current = computed(() => this.queue()[this.index()] ?? null);

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const key = event.key.toUpperCase();
    if (['F', 'N', 'T', 'S'].includes(key)) {
      event.preventDefault();
      this.decide(key as 'F' | 'N' | 'T' | 'S');
    }
  }

  decide(key: 'F' | 'N' | 'T' | 'S'): void {
    const card = this.current();
    if (!card) return;
    const reason = this.reasonText().trim();
    if (key === 'F') this.decided.emit({ card, kind: 'close', resolution: 'FINE', reason });
    else if (key === 'N') this.decided.emit({ card, kind: 'close', resolution: 'NOT_IN_FLOW', reason });
    else if (key === 'T') this.decided.emit({ card, kind: 'todo' });
    this.reasonText.set('');
    this.index.update((i) => i + 1);
  }
}
