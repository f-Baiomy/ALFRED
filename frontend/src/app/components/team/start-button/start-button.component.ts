import { Component, computed, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { BoardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { StartTarget, TeamItem } from '../../../core/team/team.models';

/**
 * Start (specs/027 US8): opens the item's Alfred board by posting /alfred-setup to the mapped board's chat - the
 * terminal holding that board, or the project's runner, does the setup. Waiting can be cancelled; once the board exists
 * this is "Open task ▾". An unmapped item asks where its board goes (and can remember it).
 */
@Component({
  selector: 'app-team-start-button',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (board(); as b) {
      <span class="tsb-menu">
        <button type="button" class="action-btn primary" (click)="menu.set(!menu())" aria-haspopup="menu" [attr.aria-expanded]="menu()">Open task ▾</button>
        @if (menu()) {
          <span class="tsb-pop" role="menu">
            <button type="button" role="menuitem" (click)="openBoard(b)">Open board</button>
            <button type="button" role="menuitem" (click)="retest(b)">New re-test cycle</button>
            <button type="button" role="menuitem" (click)="copyResume(b)">Copy /alfred-resume {{ b }}</button>
          </span>
        }
      </span>
    } @else if (waiting()) {
      <span class="tsb-wait">⏳ Waiting for /alfred-setup in the board chat…</span>
      <button type="button" class="action-btn" (click)="cancel()">Cancel</button>
    } @else {
      <button type="button" class="action-btn primary" [disabled]="busy()" (click)="start(null)"
              title="Opens an Alfred board for this item: /alfred-setup runs in the mapped board's chat">▶ Start</button>
    }
    @if (message()) { <span class="tsb-msg" [class.err]="error()">{{ message() }}</span> }

    @if (asking()) {
      <div class="tsb-backdrop" (click)="asking.set(false)"></div>
      <form class="tsb-dialog" role="dialog" aria-modal="true" aria-label="Where does this board go?" (submit)="$event.preventDefault(); pick()">
        <h4>Where does the board for {{ item().extId }} go?</h4>
        <p class="tsb-dim">No mapping names an Alfred project for its {{ state.ui().word('sprint').toLowerCase() }},
          {{ state.ui().word('squad').toLowerCase() }}, area or project.</p>
        <label>Alfred project
          <select [(ngModel)]="project" name="project" (ngModelChange)="loadBoards($event)" required>
            <option value="" disabled>Pick a project</option>
            @for (p of projects(); track p) { <option [value]="p">{{ p }}</option> }
          </select>
        </label>
        <label>Board
          <select [(ngModel)]="boardId" name="board">
            <option value="">A new board (in the project chat)</option>
            @for (b of boards(); track b.board.id) { <option [value]="b.board.id">{{ b.board.name }}</option> }
          </select>
        </label>
        <label class="tsb-check"><input type="checkbox" [(ngModel)]="remember" name="remember" />
          Remember for {{ item().squad ? state.ui().word('squad').toLowerCase() + ' ' + item().squad : 'this area' }}</label>
        <div class="tsb-actions">
          <button type="submit" class="action-btn primary" [disabled]="!project">Start</button>
          <button type="button" class="action-btn" (click)="asking.set(false)">Cancel</button>
        </div>
      </form>
    }`,
  styles: [`
    :host { display: inline-flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .tsb-menu { position: relative; }
    .tsb-pop { position: absolute; z-index: 60; right: 0; top: 110%; display: grid; min-width: 220px; padding: .25rem;
      background: var(--popover-solid); border: 1px solid var(--border-strong); border-radius: 8px; }
    .tsb-pop button { border: 0; background: none; color: inherit; text-align: left; padding: .35rem .5rem; cursor: pointer; border-radius: 5px; }
    .tsb-pop button:hover { background: rgba(139,92,246,.15); }
    .tsb-wait { font-size: .82rem; color: var(--amber); }
    .tsb-msg { font-size: .8rem; color: var(--green); }
    .tsb-msg.err { color: var(--red); }
    .tsb-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,.4); }
    .tsb-dialog { position: fixed; z-index: 71; top: 20vh; left: 50%; transform: translateX(-50%); width: min(440px, 92vw); display: grid; gap: .5rem;
      padding: 1rem; background: var(--popover-solid); border: 1px solid var(--border-strong); border-radius: 10px; }
    .tsb-dialog h4 { margin: 0; }
    .tsb-dialog label { display: grid; gap: .2rem; font-size: .82rem; }
    .tsb-dialog select { padding: .3rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: inherit; }
    .tsb-check { display: flex !important; gap: .4rem; align-items: center; }
    .tsb-dim { color: var(--text-dim); font-size: .8rem; margin: 0; }
    .tsb-actions { display: flex; gap: .4rem; }
  `],
  host: { '(document:keydown.escape)': 'menu.set(false); asking.set(false)' },
})
export class TeamStartButtonComponent {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly boardApi = inject(BoardApiService);
  private readonly db = inject(DbCaptureApiService);
  private readonly router = inject(Router);

  readonly item = input.required<TeamItem>();
  /** The connection the item is read from. */
  readonly conn = input.required<string>();
  /** The item's board (from its detail), or null. */
  readonly linkedBoard = input<string | null>(null);
  /** WAITING while a start waits for /alfred-setup. */
  readonly startState = input<string | null>(null);
  readonly changed = output<void>();

  readonly menu = signal(false);
  readonly asking = signal(false);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly error = signal(false);
  private readonly started = signal<'WAITING' | 'CANCELLED' | null>(null);
  readonly boards = signal<BoardSummary[]>([]);
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => ps.map((p) => p.project)), catchError(() => of([] as string[]))),
    { initialValue: [] as string[] });

  readonly board = computed(() => this.linkedBoard());
  readonly waiting = computed(() => this.started() === 'WAITING' || (this.started() !== 'CANCELLED' && this.startState() === 'WAITING'));

  project = '';
  boardId = '';
  remember = true;

  private say(m: string | null, err = false): void {
    this.message.set(m);
    this.error.set(err);
  }

  start(target: StartTarget | null): void {
    const i = this.item();
    this.busy.set(true);
    this.say(null);
    this.api.start(this.conn(), i.extId, target).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.asking.set(false);
        this.started.set('WAITING');
        const fetched = r.attachmentsFetched ? `${r.attachmentsFetched} attachment(s) fetched for the board` : '';
        const who = r.answeredBy ? `Set up by ${r.answeredBy}` : r.message || '';
        this.say([who, fetched].filter(Boolean).join(' · ') || null);
        this.changed.emit();
      },
      error: (e) => {
        this.busy.set(false);
        const code = e?.error?.error;
        if (code === 'NEEDS_TARGET') {
          this.project = this.project || this.projects()[0] || '';
          if (this.project) this.loadBoards(this.project);
          this.asking.set(true);
          return;
        }
        if (code === 'ALREADY_STARTED') {
          this.changed.emit();
          return this.say('This item already has a board');
        }
        this.say(e?.error?.message || 'Could not start - Settings may be read-only from here', true);
      },
    });
  }

  pick(): void {
    if (!this.project) return;
    this.start({ project: this.project, boardId: this.boardId || null, remember: this.remember });
  }

  loadBoards(project: string): void {
    this.boardId = '';
    this.boardApi.boards(project, ['OPEN']).subscribe({ next: (b) => this.boards.set(b), error: () => this.boards.set([]) });
  }

  cancel(): void {
    const i = this.item();
    this.api.cancelStart(this.conn(), i.extId).subscribe({
      next: () => {
        this.started.set('CANCELLED');
        this.changed.emit();
      },
      error: (e) => this.say(e?.error?.message || 'Nothing is waiting any more - it may have started', true),
    });
  }

  openBoard(boardId: string): void {
    this.menu.set(false);
    // the board page shows one project at a time: open it in the board's own
    this.boardApi.board(boardId).subscribe({
      next: (s) => void this.router.navigate(['/board'], { queryParams: { project: s.board.project, board: boardId } }),
      error: () => void this.router.navigate(['/board'], { queryParams: { board: boardId } }),
    });
  }

  retest(boardId: string): void {
    this.menu.set(false);
    this.boardApi.recordForBoard(boardId, 'RETEST', 'ASK').subscribe({
      next: (r) => this.say(r.message || 'Re-test cycle recording'),
      error: (e) => this.say(e?.error?.error === 'RECORDING_CONFLICT' ? 'Another cycle records this project - start the re-test from the board'
        : e?.error?.message || 'Could not start a re-test', true),
    });
  }

  copyResume(boardId: string): void {
    this.menu.set(false);
    const text = `/alfred-resume ${boardId}`;
    navigator.clipboard?.writeText(text).then(() => this.say(`Copied ${text}`), () => this.say(text));
  }
}
