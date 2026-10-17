import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BoardSummary, CardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';

export interface PickedTarget {
  readonly board: BoardSummary;
  readonly card: CardSummary | null;
  /** Card links: also tell the tracker (hyperlink, comment, tag) - asked as a consent bundle. */
  readonly markers: boolean;
}

/**
 * Pick an Alfred board - and with {@code card} a card on it - for a work item (specs/028 FR-060): open boards first,
 * searchable; the cards of the picked board below.
 */
@Component({
  selector: 'app-team-board-picker',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="tbp-backdrop" (click)="closed.emit()"></div>
    <form class="tbp" role="dialog" aria-modal="true" [attr.aria-label]="title()" (submit)="$event.preventDefault(); done()">
      <h4>{{ title() }}</h4>
      <input type="search" [(ngModel)]="q" name="q" (ngModelChange)="load()" placeholder="Find a board" aria-label="Find a board" />
      <div class="tbp-list" role="listbox" aria-label="Boards">
        @for (b of boards(); track b.board.id) {
          <button type="button" role="option" [class.on]="picked()?.board?.id === b.board.id" [attr.aria-selected]="picked()?.board?.id === b.board.id"
                  (click)="pick(b)">
            <b>{{ b.board.name }}</b> <span class="tbp-dim">{{ b.board.project }} · {{ b.cards }} cards{{ b.linkedItem ? ' · ★ ' + b.linkedItem : '' }}</span>
          </button>
        } @empty { <span class="tbp-dim">{{ loading() ? 'Loading…' : 'No open boards' }}</span> }
      </div>
      @if (card() && picked()) {
        <input type="search" [(ngModel)]="cq" name="cq" (ngModelChange)="loadCards()" placeholder="Find a card" aria-label="Find a card" />
        <div class="tbp-list" role="listbox" aria-label="Cards">
          @for (c of cards(); track c.id) {
            <button type="button" role="option" [class.on]="pickedCard()?.id === c.id" [attr.aria-selected]="pickedCard()?.id === c.id" (click)="pickedCard.set(c)">
              #{{ c.number }} {{ c.title }} <span class="tbp-dim">{{ c.kind.toLowerCase() }} · {{ c.status.toLowerCase().replace('_', ' ') }}</span>
            </button>
          } @empty { <span class="tbp-dim">No cards</span> }
        </div>
        <label class="tbp-check"><input type="checkbox" [(ngModel)]="markers" name="markers" />
          Also tell the tracker (hyperlink, comment, tag) - waits for your approval</label>
      }
      <div class="tbp-actions">
        <button type="submit" class="action-btn primary" [disabled]="!ready()">{{ action() }}</button>
        <button type="button" class="action-btn" (click)="closed.emit()">Cancel</button>
      </div>
    </form>`,
  styles: [`
    .tbp-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.4); }
    .tbp { position: fixed; z-index: 71; top: 12vh; left: 50%; transform: translateX(-50%); width: min(520px, 94vw); display: grid; gap: .5rem;
      padding: 1rem; background: var(--popover-solid); border: 1px solid var(--border-strong); border-radius: 10px; }
    h4 { margin: 0; }
    input[type=search] { padding: .3rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .tbp-list { display: grid; max-height: 30vh; overflow: auto; border: 1px solid var(--border); border-radius: 7px; }
    .tbp-list button { border: 0; border-bottom: 1px solid var(--border); background: none; color: inherit; text-align: left; padding: .35rem .5rem; cursor: pointer; font-size: .84rem; }
    .tbp-list button.on { background: rgba(139,92,246,.18); }
    .tbp-dim { color: var(--text-dim); font-size: .76rem; padding: .3rem .5rem; }
    .tbp-check { font-size: .8rem; display: flex; gap: .3rem; align-items: center; }
    .tbp-actions { display: flex; gap: .4rem; justify-content: flex-end; }
  `],
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class TeamBoardPickerComponent {
  private readonly api = inject(BoardApiService);

  readonly title = input('Pick a board');
  readonly action = input('Add');
  /** Pick a card on the board too. */
  readonly card = input(false);
  readonly picked$ = output<PickedTarget>({ alias: 'picked' });
  readonly closed = output<void>();

  readonly boards = signal<BoardSummary[]>([]);
  readonly cards = signal<CardSummary[]>([]);
  readonly loading = signal(true);
  readonly picked = signal<BoardSummary | null>(null);
  readonly pickedCard = signal<CardSummary | null>(null);
  readonly ready = computed(() => !!this.picked() && (!this.card() || !!this.pickedCard()));
  q = '';
  cq = '';
  markers = false;

  constructor() {
    this.load();
  }

  load(): void {
    this.api.boards(null, ['OPEN'], this.q).subscribe({
      next: (b) => {
        this.boards.set(b);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  pick(b: BoardSummary): void {
    this.picked.set(b);
    this.pickedCard.set(null);
    if (this.card()) this.loadCards();
  }

  loadCards(): void {
    const b = this.picked();
    if (!b) return;
    this.api.cards(b.board.project, b.board.id, { kinds: [], flags: [], author: null, scopeNotDecided: false, q: this.cq, ownOnly: true }, 0, 100)
      .subscribe({ next: (p) => this.picked()?.board.id === b.board.id && this.cards.set([...p.cards]), error: () => this.cards.set([]) });
  }

  done(): void {
    const b = this.picked();
    if (!b || !this.ready()) return;
    this.picked$.emit({ board: b, card: this.pickedCard(), markers: this.markers });
  }
}
