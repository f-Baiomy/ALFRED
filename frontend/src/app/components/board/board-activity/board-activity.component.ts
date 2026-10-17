import { Component, DestroyRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { filter } from 'rxjs';
import { BoardActivity } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';

/**
 * A board's own history (specs/027 FR-004): relations made and undone, card homes moved in and out, state changes, the
 * migration. Claude's reversible changes carry Undo. Folded by default; refetched on the "boards" signal, never polled.
 */
@Component({
  selector: 'app-board-activity',
  standalone: true,
  imports: [DatePipe],
  template: `
    <details class="board-activity" [open]="flat() || open()" (toggle)="toggled($event)">
      <summary [hidden]="flat()">Board activity @if (items().length) { <span class="board-activity-n">{{ items().length }}</span> }</summary>
      @for (a of items(); track a.id) {
        <div class="board-activity-row" [class.undone]="a.undoneAt">
          <span class="board-activity-at" [title]="a.at">{{ a.at | date: 'd MMM HH:mm' }}</span>
          <span><b>{{ a.actor === 'CLAUDE' ? 'Claude' : 'You' }}</b> {{ a.text }}</span>
          @if (a.undo && !a.undoneAt && editable()) {
            <button type="button" class="action-btn" (click)="undo(a)">Undo</button>
          } @else { <span></span> }
        </div>
      } @empty {
        <div class="board-activity-empty">Nothing yet.</div>
      }
    </details>`,
  styles: [`
    .board-activity { margin: .2rem 0 .5rem; font-size: .8rem; }
    .board-activity summary { cursor: pointer; color: var(--text-dim); }
    .board-activity-n { margin-left: .3rem; padding: 0 .35rem; border-radius: 8px; background: var(--card-inner); font-size: .7rem; }
    .board-activity-row { display: grid; grid-template-columns: 90px 1fr auto; gap: .5rem; align-items: center; padding: .2rem 0;
      border-bottom: 1px solid var(--border); }
    .board-activity-row.undone { color: var(--text-faint); text-decoration: line-through; }
    .board-activity-at, .board-activity-empty { color: var(--text-faint); }
  `],
})
export class BoardActivityComponent {
  private readonly api = inject(BoardApiService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);
  /** On the board page's Activity tab (specs/029): always open, no fold. */
  readonly flat = input(false);
  /** How many entries, for the tab's count. */
  readonly count = output<number>();
  readonly items = signal<BoardActivity[]>([]);
  readonly open = signal(false);

  constructor() {
    effect(() => {
      const id = this.boardId();
      untracked(() => this.load(id));
    });
    const socket = inject(BoardSocketService);
    const sub = socket.events$.pipe(filter((e) => e.type === 'board-changed' && e.what === 'boards'))
      .subscribe(() => this.load(this.boardId()));
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  toggled(e: Event): void {
    this.open.set((e.target as HTMLDetailsElement).open);
  }

  undo(a: BoardActivity): void {
    this.api.undoBoardActivity(a.boardId, a.id).subscribe({ next: () => this.load(this.boardId()), error: () => undefined });
  }

  private load(id: string): void {
    this.api.boardActivity(id).subscribe({
      next: (a) => { this.items.set(a); this.count.emit(a.length); },
      error: () => { this.items.set([]); this.count.emit(0); },
    });
  }
}
