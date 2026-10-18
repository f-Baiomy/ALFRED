import { AfterViewInit, Component, ElementRef, Injector, afterNextRender, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { BoardSummary } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { DbCaptureApiService } from '../../../core/services/db-capture-api.service';
import { TeamApiService } from '../../../core/team/team-api.service';
import { TeamStateService } from '../../../core/team/team-state.service';
import { MAX_BOARD_NAME, NewBoardResult, boardNameFor } from '../../../core/team/team.models';

type FirstCycle = 'NEW' | 'RECORD' | 'NONE';

/**
 * "New board from this item…" (specs/029): a board named "#id_title" by default, the item its main, a first cycle that
 * does not record yet - made at once, with no Claude involved and nothing written to the tracker. ▶ Start instead asks
 * Claude to set a board up. A modal <dialog> (the top layer), made while it is open.
 */
@Component({
  selector: 'app-team-new-board-dialog',
  standalone: true,
  imports: [FormsModule],
  template: `
    <dialog #dlg class="tnb-dialog" aria-label="New board from this item" (close)="closed.emit()" (click)="$event.target === dlg && dlg.close()">
      @if (made(); as r) {
        <div class="tnb-form">
          <h4>✓ Board made</h4>
          <p class="tnb-done">{{ r.main ? '★ Main item of' : '∘ Related item of' }} <b>{{ r.name }}</b> · {{ r.project }}
            · {{ r.cycle === 'NONE' ? 'no cycle yet' : r.cycle === 'RECORD' ? 'cycle made, recording' : 'cycle made, not recording' }}</p>
          @if (r.note) { <p class="tnb-dim">{{ r.note }}</p> }
          @if (r.files?.attached?.length) { <p class="tnb-dim">{{ r.files!.attached.length }} attachment(s) on the board</p> }
          @for (f of r.files?.notAttached ?? []; track f) { <p class="tnb-warn">{{ f }}</p> }
          <div class="tnb-actions">
            <button type="button" class="action-btn" (click)="dlg.close()">Close</button>
            <button type="button" class="action-btn primary" (click)="openBoard(r.project, r.boardId)">Open board</button>
          </div>
        </div>
      } @else {
        <form class="tnb-form" (submit)="$event.preventDefault()">
          <div class="tnb-head">
            <h4>New board from {{ ref() }}</h4>
            <div class="tnb-dim tnb-title">{{ title() }}</div>
          </div>
          @if (itsBoard(); as b) {
            <!-- the item has its board already: say so first, or the dialog looks stuck behind a disabled Create -->
            <div class="tnb-have">
              <span>{{ ref() }} already has a board: <b>{{ b.board.name }}</b>. Open it, or make another one with a different name.</span>
              <button type="button" class="action-btn primary" (click)="openBoard(b.board.project, b.board.id)">Open board</button>
            </div>
          }
          <label>Board name
            <input #nameInput type="text" name="name" [(ngModel)]="name" [maxlength]="max" required (ngModelChange)="nameEdited()" (keydown.enter)="$event.preventDefault(); create()" />
            <span class="tnb-count">{{ name.length }} / {{ max }}</span>
            @if (taken(); as t) {
              <span class="tnb-warn">A board in {{ project }} is already called that.
                <a href="#" (click)="$event.preventDefault(); openBoard(project, t.board.id)">Open it</a> or change the name.</span>
            }
          </label>
          <div class="tnb-row">
            <label>Alfred project
              <select [(ngModel)]="project" name="project" (ngModelChange)="loadBoards($event)" required>
                <option value="" disabled>Pick a project</option>
                @for (p of projects(); track p) { <option [value]="p">{{ p }}</option> }
              </select>
              @if (mapped()) { <span class="tnb-dim">From the mapping for this item</span> }
            </label>
            <label class="tnb-check"><input type="checkbox" [(ngModel)]="remember" name="remember" />
              Remember for {{ squad() ? state.ui().word('squad').toLowerCase() + ' ' + squad() : 'this area' }}</label>
          </div>
          <label class="tnb-check"><input type="checkbox" [(ngModel)]="main" name="main" />
            <span>Make {{ ref() }} the board's main item
              <span class="tnb-sub">Kept in full and compared with the tracker on every sync, with its parent and children as related items.</span></span></label>
          <fieldset class="tnb-cycles">
            <legend>First cycle</legend>
            @for (o of cycles; track o.value) {
              <label class="tnb-opt" [class.on]="cycle === o.value">
                <input type="radio" name="cycle" [value]="o.value" [(ngModel)]="cycle" />
                <span>{{ o.label }}<span class="tnb-sub">{{ o.sub }}</span></span>
              </label>
            }
          </fieldset>
          <details>
            <summary class="tnb-dim">More (optional)</summary>
            <label class="tnb-check"><input type="checkbox" [(ngModel)]="attachments" name="attachments" />
              <span>Fetch its attachments to the board<span class="tnb-sub">Reads the tracker with the live token.</span></span></label>
          </details>
          <p class="tnb-note">Makes an empty board now, with no Claude involved. <b>▶ Start</b> instead asks Claude to set the board up,
            with a brief, cards and checks.</p>
          @if (error()) { <p class="tnb-warn">{{ error() }}</p> }
          <div class="tnb-actions">
            <span class="tnb-dim">Nothing is written to the tracker.</span>
            <button type="button" class="action-btn" (click)="dlg.close()">Cancel</button>
            <!-- a click, not a submit: a drawer around it may cancel the click's default, and then no submit is ever sent -->
            <button type="button" class="action-btn tnb-create" [class.primary]="!itsBoard()" [disabled]="busy() || !project || !name.trim() || !!taken()"
                    [title]="taken() ? 'A board is already called that - change the name' : ''" (click)="create()">{{ busy() ? 'Creating…' : 'Create board' }}</button>
          </div>
        </form>
      }
    </dialog>`,
  styles: [`
    .tnb-dialog { width: min(520px, 94vw); padding: 0; color: var(--text); background: var(--popover-solid); border: 1px solid var(--border-strong);
      border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
    .tnb-dialog::backdrop { background: rgba(0,0,0,.45); }
    .tnb-form { display: grid; gap: .7rem; padding: 1rem 1.1rem; }
    .tnb-form h4 { margin: 0; font-size: .95rem; }
    .tnb-title { margin-top: .2rem; }
    .tnb-form label { display: grid; gap: .25rem; font-size: .8rem; color: var(--text-dim); position: relative; }
    .tnb-form input[type=text], .tnb-form select { box-sizing: border-box; width: 100%; height: 2rem; padding: .25rem .5rem;
      border: 1px solid var(--border-strong); border-radius: 6px; background: var(--card-inner); color: var(--text); font: inherit; font-size: .84rem; }
    .tnb-count { justify-self: end; font-size: .72rem; color: var(--text-dim); }
    .tnb-row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: flex-start; }
    .tnb-row > label { flex: 1 1 200px; }
    .tnb-check { display: flex !important; gap: .45rem; align-items: flex-start; color: var(--text) !important; }
    .tnb-row .tnb-check { margin-top: 1.3rem; }
    .tnb-sub { display: block; color: var(--text-dim); font-size: .74rem; margin-top: .1rem; }
    .tnb-cycles { display: grid; gap: .35rem; margin: 0; padding: 0; border: 0; }
    .tnb-cycles legend { font-size: .8rem; color: var(--text-dim); margin-bottom: .3rem; padding: 0; }
    .tnb-opt { display: flex !important; gap: .45rem; align-items: flex-start; padding: .45rem .55rem; border: 1px solid var(--border);
      border-radius: 7px; color: var(--text) !important; cursor: pointer; }
    .tnb-opt.on { border-color: var(--accent, #8b5cf6); background: rgba(139,92,246,.1); }
    details summary { cursor: pointer; font-size: .8rem; margin-bottom: .4rem; }
    .tnb-dim { color: var(--text-dim); font-size: .8rem; margin: 0; }
    .tnb-note { margin: 0; font-size: .78rem; color: var(--text-dim); padding: .45rem .55rem; border-radius: 6px; background: var(--card-inner); }
    .tnb-warn { color: var(--amber); font-size: .78rem; margin: 0; }
    .tnb-warn a { color: var(--blue, #60a5fa); }
    .tnb-done { margin: 0; font-size: .86rem; }
    .tnb-have { display: flex; gap: .6rem; align-items: center; justify-content: space-between; padding: .5rem .6rem; border-radius: 7px;
      border: 1px solid var(--blue, #60a5fa); background: rgba(96,165,250,.08); font-size: .8rem; }
    .tnb-actions { display: flex; gap: .4rem; align-items: center; justify-content: flex-end; }
    .tnb-actions .tnb-dim { margin-right: auto; font-size: .74rem; }
  `],
})
export class TeamNewBoardDialogComponent implements AfterViewInit {
  readonly state = inject(TeamStateService);
  private readonly api = inject(TeamApiService);
  private readonly boardApi = inject(BoardApiService);
  private readonly db = inject(DbCaptureApiService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  /** The connection the item is read from. */
  readonly conn = input.required<string>();
  readonly extId = input.required<string>();
  readonly title = input<string>('');
  readonly squad = input<string | null>(null);
  readonly closed = output<void>();
  /** A board was made: badges change. */
  readonly changed = output<NewBoardResult>();

  readonly max = MAX_BOARD_NAME;
  readonly cycles: readonly { value: FirstCycle; label: string; sub: string }[] = [
    { value: 'NEW', label: 'New cycle, named like the board', sub: 'Empty and not recording. Record into it whenever you are ready.' },
    { value: 'RECORD', label: 'New cycle and start recording now', sub: 'The project\'s calls go into it from now on (a cycle recording there pauses).' },
    { value: 'NONE', label: 'No cycle yet', sub: 'Attach an existing cycle or make one later from the board.' },
  ];

  private readonly dlg = viewChild<ElementRef<HTMLDialogElement>>('dlg');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  readonly projects = toSignal(this.db.projects().pipe(map((ps) => ps.map((p) => p.project)), catchError(() => of([] as string[]))),
    { initialValue: [] as string[] });
  readonly boards = signal<BoardSummary[]>([]);
  readonly mapped = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly made = signal<NewBoardResult | null>(null);
  /** The board the tracker mapping says this item already has. */
  private readonly targetBoard = signal<string | null>(null);
  /** Bumped on every name edit so `taken` re-reads the plain field. */
  private readonly edits = signal(0);

  name = '';
  project = '';
  remember = true;
  main = true;
  cycle: FirstCycle = 'NEW';
  attachments = false;

  readonly ref = computed(() => `AB#${this.extId()}`);
  /** The open board this item is already the main item of (by the mapping, or by a board's linked item). */
  readonly itsBoard = computed(() => {
    const id = this.targetBoard();
    const linked = `${this.conn()}/${this.extId()}`;
    return this.boards().find((b) => !b.board.isDefault && (b.board.id === id || b.linkedItem === linked)) ?? null;
  });
  readonly taken = computed(() => {
    this.edits();
    const n = this.name.trim().replace(/\s+/g, ' ').toLowerCase();
    return n ? this.boards().find((b) => !b.board.isDefault && b.board.name.trim().toLowerCase() === n) ?? null : null;
  });

  /** Inputs and the <dialog> are there: fill the defaults and open it. */
  ngAfterViewInit(): void {
    {
      this.name = boardNameFor(this.extId(), this.title());
      this.edits.update((v) => v + 1);
      this.dlg()?.nativeElement.showModal?.();
      this.api.itemTarget(this.conn(), this.extId()).subscribe({
        next: (t) => {
          if (t?.boardId) this.targetBoard.set(t.boardId);
          if (t?.project) {
            this.mapped.set(true);
            this.remember = false;
            this.pickProject(t.project);
          } else this.pickProject(this.projects()[0] ?? '');
        },
        error: () => this.pickProject(this.projects()[0] ?? ''),
      });
      afterNextRender(() => this.nameInput()?.nativeElement.select(), { injector: this.injector });
    }
  }

  private pickProject(p: string): void {
    if (!this.project) this.project = p;
    if (this.project) this.loadBoards(this.project);
  }

  nameEdited(): void {
    this.error.set(null);
    this.edits.update((v) => v + 1);
  }

  loadBoards(project: string): void {
    this.boardApi.boards(project, ['OPEN']).subscribe({
      next: (b) => {
        this.boards.set(b);
        this.edits.update((v) => v + 1);
        if (this.itsBoard()) this.main = false; // it is the main item of its board already
      },
      error: () => this.boards.set([]),
    });
  }

  create(): void {
    this.edits.update((v) => v + 1);
    if (!this.project || !this.name.trim() || this.taken() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.newBoardFromItem(this.conn(), this.extId(), {
      project: this.project, name: this.name.trim(), main: this.main, cycle: this.cycle, attachments: this.attachments, remember: this.remember,
    }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.made.set(r);
        this.changed.emit(r);
      },
      error: (e) => {
        this.busy.set(false);
        if (e?.error?.error === 'CONFLICT') this.loadBoards(this.project);
        this.error.set(e?.error?.message || 'Could not make the board - Settings may be read-only from here');
      },
    });
  }

  openBoard(project: string, boardId: string): void {
    this.dlg()?.nativeElement.close();
    void this.router.navigate(['/board'], { queryParams: { project, board: boardId } });
  }
}
