import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { filter } from 'rxjs';
import { BoardState, BoardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';

/**
 * The Board tab's board picker (specs/027 FR-006, mock §Board): the project's default board first, then its task boards,
 * archived ones behind "Show archived", and "All cards" (every card of the project). "New board…" opens a board here.
 * Refetches on the /ws/board "boards" signal - never on a timer.
 */
@Component({
  selector: 'app-board-picker',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="board-pick">
      <button type="button" class="board-picker-btn" (click)="open.set(!open())" [attr.aria-expanded]="open()" aria-haspopup="listbox">
        <span aria-hidden="true">▦</span>
        <b>{{ label() }}</b>
        <span class="board-picker-sub">{{ project() || 'No project' }}{{ current()?.board?.isDefault ? ' · default' : '' }} ▾</span>
      </button>
      @if (open()) {
        <div class="board-picker-menu" role="listbox" aria-label="Boards">
          <div class="board-picker-group">Project</div>
          <button type="button" class="board-picker-item" [class.on]="!selected()" (click)="pick(null)">
            All cards <small>every card of {{ project() || 'this project' }}</small>
          </button>
          @for (b of defaults(); track b.board.id) {
            <button type="button" class="board-picker-item" [class.on]="b.board.id === selected()" (click)="pick(b.board.id)">
              {{ b.board.name }} <small>default · {{ b.cards }} cards</small>
            </button>
          }
          <div class="board-picker-group">Task boards</div>
          @for (b of tasks(); track b.board.id) {
            <button type="button" class="board-picker-item" [class.on]="b.board.id === selected()" (click)="pick(b.board.id)">
              {{ b.board.name }}
              <small>{{ stateLabel(b.board.state) }}{{ b.linkedItem ? '◆ ' + b.linkedItem + ' · ' : '' }}{{ b.cycleIds.length }} cycles · {{ b.cards }} cards</small>
            </button>
          } @empty {
            <div class="board-picker-empty">No task boards yet</div>
          }
          <label class="board-picker-archived"><input type="checkbox" [ngModel]="showArchived()" (ngModelChange)="showArchived.set($event)" /> Show archived</label>
          @if (editable()) {
            @if (!creating()) {
              <button type="button" class="board-picker-add" (click)="creating.set(true)">＋ New board…</button>
            } @else {
              <form class="board-picker-new" (submit)="$event.preventDefault(); create()">
                <input [(ngModel)]="newName" name="name" maxlength="120" placeholder="e.g. Login lockout" aria-label="New board name" />
                <label><input type="checkbox" [(ngModel)]="newRecording" name="rec" /> Start a first recording</label>
                <span class="board-picker-new-actions">
                  <button type="button" class="action-btn" (click)="creating.set(false)">Cancel</button>
                  <button type="submit" class="action-btn primary" [disabled]="!newName.trim() || busy()">Create</button>
                </span>
                @if (error()) { <span class="board-picker-error">{{ error() }}</span> }
              </form>
            }
          }
        </div>
      }
    </div>`,
  styles: [`
    /* not .board-picker: that global class is the mention picker's popover (overflow: hidden) and cut this menu off */
    .board-pick { position: relative; display: inline-block; }
    .board-picker-btn { display: inline-flex; gap: .45rem; align-items: center; padding: .3rem .7rem; border: 1px solid var(--border-strong);
      border-radius: 7px; background: var(--card-inner); color: inherit; cursor: pointer; }
    .board-picker-sub { color: var(--text-dim); font-size: .82rem; }
    .board-picker-menu { position: absolute; z-index: 30; top: 2.4rem; left: 0; min-width: 320px; max-height: 70vh; overflow: auto; padding: .4rem;
      border: 1px solid var(--border-strong); border-radius: 8px; background: var(--popover-solid); box-shadow: 0 10px 30px rgba(0,0,0,.4); }
    .board-picker-group { margin: .4rem .4rem .15rem; font-size: .68rem; letter-spacing: .05em; text-transform: uppercase; color: var(--text-dim); }
    .board-picker-item { display: flex; justify-content: space-between; gap: .8rem; width: 100%; padding: .3rem .5rem; border: 0; border-radius: 5px;
      background: none; color: inherit; text-align: left; cursor: pointer; }
    .board-picker-item:hover, .board-picker-item.on { background: rgba(139,92,246,.18); }
    .board-picker-item small, .board-picker-empty { color: var(--text-dim); }
    .board-picker-empty { padding: .3rem .5rem; font-size: .82rem; }
    .board-picker-archived { display: flex; gap: .35rem; align-items: center; margin: .4rem .5rem 0; font-size: .8rem; color: var(--text-dim); }
    .board-picker-add { margin-top: .4rem; border: 0; background: none; color: var(--purple-light); cursor: pointer; padding: .3rem .5rem; }
    .board-picker-new { display: grid; gap: .35rem; margin-top: .4rem; padding: .4rem .5rem; border-top: 1px solid var(--border); }
    .board-picker-new label { display: flex; gap: .35rem; align-items: center; font-size: .8rem; }
    .board-picker-new-actions { display: flex; gap: .3rem; justify-content: flex-end; }
    .board-picker-error { color: var(--red); font-size: .78rem; }
  `],
})
export class BoardPickerComponent {
  private readonly api = inject(BoardApiService);
  private readonly socket = inject(BoardSocketService);

  readonly project = input('');
  /** The selected board id; null = All cards. */
  readonly selected = input<string | null>(null);
  readonly editable = input(true);
  readonly picked = output<string | null>();
  /** The selected board's summary, for the page (name, state, relations). */
  readonly current = computed(() => this.boards().find((b) => b.board.id === this.selected()) ?? null);

  readonly open = signal(false);
  readonly creating = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly showArchived = signal(false);
  readonly boards = signal<BoardSummary[]>([]);
  newName = '';
  newRecording = true;

  readonly defaults = computed(() => this.boards().filter((b) => b.board.isDefault));
  readonly tasks = computed(() => this.boards().filter((b) => !b.board.isDefault && (this.showArchived() || b.board.state !== 'ARCHIVED')));
  readonly label = computed(() => (this.selected() ? this.current()?.board.name ?? '…' : 'All cards'));

  constructor() {
    effect(() => {
      const project = this.project();
      untracked(() => this.load(project));
    });
    const sub = this.socket.events$
      .pipe(filter((e) => e.type === 'board-changed' && (e.what === 'boards' || e.what === 'deleted' || e.what === 'card')))
      .subscribe(() => this.load(this.project()));
    const again = this.socket.reconnected$.subscribe(() => this.load(this.project()));
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      again.unsubscribe();
    });
  }

  stateLabel(state: BoardState): string {
    return state === 'OPEN' ? '' : state === 'DONE' ? 'done · ' : 'archived · ';
  }

  pick(id: string | null): void {
    this.open.set(false);
    this.picked.emit(id);
  }

  create(): void {
    const name = this.newName.trim();
    if (!name) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.createBoard({ project: this.project(), name, startRecording: this.newRecording }).subscribe({
      next: (b) => {
        this.busy.set(false);
        this.creating.set(false);
        this.newName = '';
        this.load(this.project());
        this.pick(b.id);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.message || 'Could not create the board');
      },
    });
  }

  private asked = 0;

  private load(project: string): void {
    const mine = ++this.asked; // a slow answer for the project before must not overwrite this one's
    this.api.boards(project || null).subscribe({ next: (b) => { if (mine === this.asked) this.boards.set(b); }, error: () => undefined });
  }
}
