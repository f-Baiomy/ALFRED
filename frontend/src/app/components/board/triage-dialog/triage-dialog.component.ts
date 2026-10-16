import { Component, HostListener, computed, input, output, signal } from '@angular/core';
import { CardSummary, FLAG_LABELS, RESOLUTION_LABELS, Resolution } from '../../../core/models/board.models';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import {
  TriageAction, actionText, adviceAction, confidenceLabel, confidenceOf, highCards, worstFirst,
} from '../../../shared/utils/triage-advice';

/** One decision on one Inbox card. */
export type TriageDecision =
  | { readonly card: CardSummary; readonly kind: 'close'; readonly resolution: Resolution; readonly reason: string }
  | { readonly card: CardSummary; readonly kind: 'todo' }
  | { readonly card: CardSummary; readonly kind: 'merge'; readonly into: number; readonly reason: string }
  | { readonly card: CardSummary; readonly kind: 'mergeGroup'; readonly group: readonly number[] };

/** The decision Claude's advice on a card stands for. */
export function decisionOf(card: CardSummary, a: TriageAction, reason = ''): TriageDecision {
  if (a.kind === 'move') return { card, kind: 'todo' };
  if (a.kind === 'close') return { card, kind: 'close', resolution: a.resolution, reason };
  if (a.kind === 'merge') return { card, kind: 'merge', into: a.into, reason };
  return { card, kind: 'mergeGroup', group: a.group };
}

/**
 * Triage mode (FR-017): the Inbox one card at a time, decided by button or key - F Fine, N Not in this flow, T To do,
 * M Merge, S Skip - with an optional reason Claude reads later. When Claude triaged first (/alfred-triage) the Inbox is
 * worst first, each card shows Claude's advice with its confidence, what it checked and its root-cause group, the
 * advised key is marked, and "Accept all High" takes every High-confidence advice at once. Ends on "Inbox clear".
 */
@Component({
  selector: 'app-triage-dialog',
  standalone: true,
  imports: [MentionChipComponent],
  template: `
    <div class="dialog-backdrop" (click)="closed.emit()">
      <div class="dialog-card board-triage" (click)="$event.stopPropagation()">
        @if (current(); as c) {
          <div class="board-triage-top"><span>Triage Inbox · {{ position() }} of {{ order().length }}{{ ranked() ? ' · worst first (Claude)' : '' }}</span><span>Esc to stop</span></div>
          <div class="board-triage-bar"><i [style.width.%]="(index() / order().length) * 100"></i></div>
          <div class="board-card-row">
            <span class="board-kind" [class]="'board-kind board-kind-' + c.kind">{{ c.kind }}</span>
            @for (f of c.flags; track f) { <span class="board-flag" [class]="'board-flag board-flag-' + f">{{ flagLabels[f] }}</span> }
            @if (c.author === 'CLAUDE') { <span class="board-ai">✦ Claude</span> }
            @if (c.adviceDetail?.rank; as r) {
              <span class="board-sev" [title]="c.adviceDetail?.note ?? ''">▲ {{ r }}{{ c.adviceDetail?.of ? ' of ' + c.adviceDetail?.of : '' }}{{ c.adviceDetail?.note ? ' · ' + c.adviceDetail?.note : '' }}</span>
            }
          </div>
          <h2>#{{ c.number }} {{ c.title }}</h2>
          <div class="board-card-row">
            @for (m of c.mentionChips ?? []; track m.type + m.ref) { <app-mention-chip [mention]="m" /> }
          </div>
          @if (advice(); as a) {
            <div class="board-triage-advice">
              <div>✦ Claude advises: <b>{{ actionLabel(a) }}</b>
                @if (confidence(); as cf) { <span class="board-conf" [class]="'board-conf board-conf-' + cf.toLowerCase()">{{ confidenceText(cf) }}</span> }</div>
              @if (c.adviceDetail?.reason; as why) { <div><b>Why:</b> {{ why }}</div> }
              @if (c.adviceDetail?.checked; as ch) { <div class="board-dim"><b>Checked:</b> {{ ch }}</div> }
              @if (a.kind === 'mergeGroup') { <div class="board-dim">Same root cause: @for (n of a.group; track n) { #{{ n }} } - merge them into #{{ c.number }}</div> }
              @else if (c.adviceDetail?.group?.length) { <div class="board-dim">Same root cause: @for (n of c.adviceDetail?.group; track n) { #{{ n }} } - their cards advise merging into #{{ c.number }}</div> }
            </div>
          }
          @if (c.similarClosed; as s) {
            <div class="board-sim">⚠ Looks like #{{ s.number }}, closed as {{ resolutionLabels[s.resolution] }}{{ s.reason ? ': ' + s.reason : '' }}</div>
          }
          <input #reason class="board-triage-reason" type="text" maxlength="2000" placeholder="Reason (optional - Claude learns from it)"
                 [value]="reasonText()" (input)="reasonText.set(reason.value)" />
          @if (merging()) {
            <div class="board-triage-merge">
              <label>Merge #{{ c.number }} into #
                <input #into type="number" min="1" class="board-triage-into" [value]="mergeInto() ?? ''" (input)="mergeInto.set(+into.value || null)"
                       (keydown.enter)="mergeTo()" (keydown.escape)="$event.stopPropagation(); merging.set(false)" /></label>
              <button type="button" class="ok" [disabled]="!mergeInto() || mergeInto() === c.number" (click)="mergeTo()">Merge</button>
              <button type="button" (click)="merging.set(false)">Cancel</button>
            </div>
          }
          <div class="board-triage-btns">
            <button type="button" class="ok" [class.advised]="advisedKey() === 'F'" (click)="decide('F')">✓ Fine<kbd>F</kbd></button>
            <button type="button" [class.advised]="advisedKey() === 'N'" (click)="decide('N')">⊘ Not in flow<kbd>N</kbd></button>
            <button type="button" [class.advised]="advisedKey() === 'T'" (click)="decide('T')">→ To do<kbd>T</kbd></button>
            <button type="button" [class.advised]="advisedKey() === 'M'" [title]="mergeTitle()" (click)="decide('M')">⇢ Merge<kbd>M</kbd></button>
            <button type="button" (click)="decide('S')">Skip<kbd>S</kbd></button>
          </div>
          @if (high().length) {
            <div class="board-triage-high">
              <button type="button" class="action-btn" [title]="highTitle()" (click)="acceptHigh()">Accept all High ({{ high().length }})</button>
              <span class="board-dim">applies Claude's High-confidence advice; Medium and Low stay yours</span>
            </div>
          }
        } @else {
          <h2>Inbox clear ✓</h2>
          <p class="board-dim">{{ order().length }} cards sorted. Claude reads your reasons before it reports something similar.</p>
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
  readonly confidenceText = confidenceLabel;
  readonly index = signal(0);
  readonly reasonText = signal('');
  readonly merging = signal(false);
  readonly mergeInto = signal<number | null>(null);
  /** Cards already decided by "Accept all High" - skipped when their turn comes. */
  private readonly done = signal<ReadonlySet<string>>(new Set());

  /** Worst first when Claude ranked the Inbox, else as the board showed it. */
  readonly order = computed(() => worstFirst(this.queue()));
  readonly ranked = computed(() => this.queue().some((c) => c.adviceDetail?.rank != null));
  readonly current = computed(() => this.order()[this.index()] ?? null);
  readonly position = computed(() => Math.min(this.index() + 1, this.order().length));
  readonly advice = computed(() => (this.current() ? adviceAction(this.current()!) : null));
  readonly confidence = computed(() => (this.current() && this.advice() ? confidenceOf(this.current()) : null));
  readonly advisedKey = computed(() => {
    const a = this.advice();
    if (!a) return null;
    if (a.kind === 'move') return 'T';
    if (a.kind === 'close') return a.resolution === 'FINE' ? 'F' : a.resolution === 'NOT_IN_FLOW' ? 'N' : null;
    return 'M';
  });
  /** High-confidence advice still to decide in this run (the current card and after). */
  readonly high = computed(() => highCards(this.order().slice(this.index())).filter((c) => !this.done().has(c.id)));
  readonly highTitle = computed(() => this.high().map((c) => `#${c.number} → ${actionText(adviceAction(c)!)}`).join('\n'));
  readonly mergeTitle = computed(() => {
    const a = this.advice();
    return a && (a.kind === 'merge' || a.kind === 'mergeGroup') ? `Claude advises: ${actionText(a)}` : 'Merge this card into another one (a duplicate)';
  });

  actionLabel(a: TriageAction): string {
    return actionText(a);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
      return;
    }
    if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const key = event.key.toUpperCase();
    if (['F', 'N', 'T', 'M', 'S'].includes(key)) {
      event.preventDefault();
      this.decide(key as 'F' | 'N' | 'T' | 'M' | 'S');
    }
  }

  decide(key: 'F' | 'N' | 'T' | 'M' | 'S'): void {
    const card = this.current();
    if (!card) return;
    const reason = this.reasonText().trim();
    if (key === 'M') {
      const a = this.advice();
      if (a && (a.kind === 'merge' || a.kind === 'mergeGroup')) {
        this.emit(decisionOf(card, a, reason));
        this.next();
      } else {
        this.mergeInto.set(null);
        this.merging.set(true);
      }
      return;
    }
    if (key === 'F') this.decided.emit({ card, kind: 'close', resolution: 'FINE', reason });
    else if (key === 'N') this.decided.emit({ card, kind: 'close', resolution: 'NOT_IN_FLOW', reason });
    else if (key === 'T') this.decided.emit({ card, kind: 'todo' });
    this.next();
  }

  /** Merge the current card into the number typed. */
  mergeTo(): void {
    const card = this.current();
    const into = this.mergeInto();
    if (!card || !into || into === card.number) return;
    this.decided.emit({ card, kind: 'merge', into, reason: this.reasonText().trim() });
    this.next();
  }

  /** Every High-confidence advice left in this run, as if decided one by one; the run goes on with the rest. */
  acceptHigh(): void {
    const picked = this.high();
    this.done.set(new Set([...this.done(), ...picked.map((c) => c.id)]));
    for (const c of picked) this.emit(decisionOf(c, adviceAction(c)!));
    if (this.current() && this.done().has(this.current()!.id)) this.next(false);
  }

  /** Emits a decision; a group merge also takes the merged cards out of this run. */
  private emit(d: TriageDecision): void {
    if (d.kind === 'mergeGroup') {
      const ids = this.order().filter((c) => d.group.includes(c.number)).map((c) => c.id);
      this.done.set(new Set([...this.done(), ...ids]));
    }
    this.decided.emit(d);
  }

  private next(advance = true): void {
    this.reasonText.set('');
    this.merging.set(false);
    let i = this.index() + (advance ? 1 : 0);
    while (this.order()[i] && this.done().has(this.order()[i].id)) i++;
    this.index.set(i);
  }
}
