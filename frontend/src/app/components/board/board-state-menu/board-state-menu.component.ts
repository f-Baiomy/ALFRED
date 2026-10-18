import { Component, computed, inject, input, output, signal } from '@angular/core';
import { BoardState, BoardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { BoardBannerService } from '../../../core/state/board-banner.service';
import { CloseOnOutsideDirective } from '../../../shared/directives/close-on-outside.directive';

/**
 * The board's state in the header (specs/032 T042): ● Open / Done / Archived, and a menu that says what each choice does -
 * Mark done, Archive, Reopen, Delete board… (the delete still confirms). Was the Open / Done / Archive buttons of the
 * related strip.
 */
@Component({
  selector: 'app-board-state-menu',
  standalone: true,
  imports: [CloseOnOutsideDirective],
  styles: [`
    :host { position: relative; display: inline-block; }
    .sel { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
      background: var(--bg-2, var(--card-inner)); color: var(--text); font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
    .sel:hover { border-color: var(--border-strong); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
    .dot.open { background: var(--green); }
    .car { color: var(--text-faint); font-size: 10px; }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 70; min-width: 260px; padding: 6px; background: var(--popover-solid);
      border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: 0 14px 34px rgba(0,0,0,.5); }
    .mi { display: flex; flex-direction: column; width: 100%; padding: 7px 10px; border: 0; border-radius: 6px; background: none; color: var(--text);
      font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
    .mi small { color: var(--text-dim); font-size: 11.5px; }
    .mi:hover { background: color-mix(in srgb, var(--purple) 14%, transparent); }
    .sep { height: 1px; margin: 5px 4px; background: var(--border); }
    .danger { color: var(--red); }
  `],
  template: `
    @if (summary(); as s) {
      <span [appCloseOnOutside]="open()" (closed)="open.set(false)">
        <button type="button" class="sel" [attr.aria-expanded]="open()" aria-haspopup="menu" [disabled]="!editable()" (click)="open.set(!open())"
                [title]="editable() ? 'The board\\'s state' : 'Read-only here'">
          <span class="dot" [class.open]="s.board.state === 'OPEN'"></span>{{ label() }} <span class="car">▼</span></button>
        @if (open()) {
          <div class="menu" role="menu">
            @if (s.board.state !== 'DONE') { <button type="button" role="menuitem" class="mi" (click)="set('DONE')">✓ Mark done<small>the task is finished; it stays in the board list</small></button> }
            @if (s.board.state !== 'ARCHIVED') { <button type="button" role="menuitem" class="mi" (click)="set('ARCHIVED')">⌂ Archive<small>out of the board list; reopen any time</small></button> }
            @if (s.board.state !== 'OPEN') { <button type="button" role="menuitem" class="mi" (click)="set('OPEN')">↺ Reopen<small>back to an open task</small></button> }
            <div class="sep"></div>
            <button type="button" role="menuitem" class="mi danger" (click)="remove()">✕ Delete board…<small>cards move to the project's default board; recordings stay</small></button>
          </div>
        }
      </span>
    }`,
})
export class BoardStateMenuComponent {
  private readonly api = inject(BoardApiService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly banner = inject(BoardBannerService);

  readonly summary = input<BoardSummary | null>(null);
  readonly editable = input(true);
  readonly changed = output<void>();
  readonly deleted = output<string>();

  readonly open = signal(false);
  readonly label = computed(() => ({ OPEN: 'Open', DONE: 'Done', ARCHIVED: 'Archived' } as Record<BoardState, string>)[this.summary()?.board.state ?? 'OPEN']);

  set(state: BoardState): void {
    const s = this.summary();
    this.open.set(false);
    if (!s) return;
    this.api.updateBoard(s.board.id, { state }).subscribe({
      next: () => this.changed.emit(),
      error: (e) => this.banner.show({ boardId: s.board.id, tone: 'error', text: 'The board\'s state did not change', detail: e?.error?.message ?? null }),
    });
  }

  async remove(): Promise<void> {
    const s = this.summary();
    this.open.set(false);
    if (!s || !(await this.confirmDialog.confirm(`Delete board "${s.board.name}"? Its cycles and their calls stay and its cards move to `
      + "the project's default board. Its brief, spec files, requirements and chat are deleted."))) return;
    this.api.deleteBoard(s.board.id).subscribe({
      next: () => this.deleted.emit(s.board.id),
      error: (e) => this.banner.show({ boardId: s.board.id, tone: 'error', text: 'The board was not deleted', detail: e?.error?.message ?? null }),
    });
  }
}
