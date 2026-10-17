import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { BoardState, BoardSummary } from '../../../core/models/board.models';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { recordingConflict } from '../../../shared/utils/recording-conflict';
import { CycleVerdictsDialogComponent } from '../cycle-verdicts-dialog/cycle-verdicts-dialog.component';

/**
 * Under the board picker (specs/027 FR-003/006, mock §Board): the cycles and boards this board is related to, as chips with
 * ✕ to unrelate (the cycle and its calls stay), "＋ relate" for any cycle or board of any project, the board's state
 * (Open / Done / Archive) and Delete for task boards, and the "migrated from cycle" banner.
 */
@Component({
  selector: 'app-related-strip',
  standalone: true,
  imports: [CycleVerdictsDialogComponent],
  template: `
    @if (summary(); as s) {
      <div class="related-strip">
        <span class="related-label">Cycles:</span>
        @for (c of relatedCycles(); track c.id) {
          <span class="related-chip cyc" [class.rec]="c.status === 'RECORDING'">
            <button type="button" class="related-open" title="Every board's verdicts on this cycle's calls" (click)="verdictsOf.set(c)">{{ c.name }}</button>
            @if (c.status === 'RECORDING') { <span class="related-rec">REC</span> }
            @if (sharedWith(c.id); as others) { @if (others.length) { <span class="related-shared" [title]="'Also on ' + others.join(', ')">shared · {{ others.length }}</span> } }
            @if (editable()) { <button type="button" class="related-x" title="Unrelate (the cycle and its calls stay)" (click)="unrelateCycle(c.id)">✕</button> }
          </span>
        } @empty { <span class="related-none">none</span> }
        <span class="related-label">Boards:</span>
        @for (b of relatedBoards(); track b.board.id) {
          <span class="related-chip brd">
            {{ b.board.name }}
            @if (editable()) { <button type="button" class="related-x" title="Unrelate" (click)="unrelateBoard(b.board.id)">✕</button> }
          </span>
        } @empty { <span class="related-none">none</span> }
        @if (editable()) {
          <button type="button" class="related-chip plus" (click)="relating.set(!relating())">＋ relate cycle or board</button>
          <button type="button" class="related-chip plus" title="Record this board's calls: joins or replaces a recording of the same project" (click)="record('REC')">● Record</button>
          @if (!s.board.isDefault) {
            <span class="related-state">
              @for (st of states; track st) {
                <button type="button" class="related-state-btn" [class.on]="s.board.state === st" (click)="setState(st)">{{ stateName(st) }}</button>
              }
              <button type="button" class="related-state-btn danger" (click)="remove()">Delete…</button>
            </span>
          }
        }
      </div>
      @if (s.board.migratedFrom) {
        <div class="related-banner">ⓘ Made on the first start after the update from cycle "<b>{{ s.board.migratedFrom }}</b>": its brief, spec,
          requirements, chat and cards now live on this board, and the cycle only holds the calls.</div>
      }
      @if (relating()) {
        <div class="related-pick">
          <div class="related-pick-col">
            <b>Cycles</b>
            @for (c of cycles(); track c.id) {
              <div class="related-pick-row">
                <span>{{ c.name }} @if (c.status === 'RECORDING') { <span class="related-rec">● REC</span> }</span>
                @if (s.cycleIds.includes(c.id)) { <span class="related-none">related</span> }
                @else { <button type="button" class="action-btn" (click)="relateCycle(c.id)">Relate</button> }
              </div>
            }
          </div>
          <div class="related-pick-col">
            <b>Boards</b>
            @for (b of otherBoards(); track b.board.id) {
              <div class="related-pick-row">
                <span>{{ b.board.name }} <small>{{ b.board.project }}</small></span>
                @if (s.boardIds.includes(b.board.id)) { <span class="related-none">related</span> }
                @else { <button type="button" class="action-btn" (click)="relateBoard(b.board.id)">Relate</button> }
              </div>
            }
          </div>
        </div>
      }
      @if (error()) { <div class="related-error">{{ error() }}</div> }
      @if (verdictsOf(); as v) {
        <app-cycle-verdicts-dialog [cycleId]="v.id" [cycleName]="v.name" [project]="s.board.project" [forBoard]="s.board.id" (closed)="verdictsOf.set(null)" />
      }
    }`,
  styles: [`
    .related-strip { display: flex; flex-wrap: wrap; gap: .35rem; align-items: center; margin: .5rem 0 .3rem; font-size: .8rem; }
    .related-label { color: var(--text-dim); }
    .related-none { color: var(--text-faint); font-size: .76rem; }
    .related-chip { display: inline-flex; gap: .3rem; align-items: center; padding: .05rem .55rem; border: 1px solid var(--border-strong);
      border-radius: 999px; background: var(--card-inner); color: inherit; font: inherit; }
    .related-chip.cyc::before { content: '●'; color: var(--amber); font-size: .6rem; }
    .related-chip.cyc.rec::before { color: var(--red); }
    .related-chip.brd::before { content: '▦'; color: var(--purple-light); }
    .related-chip.plus { border-style: dashed; color: var(--purple-light); cursor: pointer; }
    .related-x { border: 0; background: none; color: var(--text-faint); cursor: pointer; padding: 0; }
    .related-x:hover { color: var(--red); }
    .related-state { display: inline-flex; gap: .2rem; margin-left: auto; }
    .related-state-btn { padding: .05rem .5rem; border: 1px solid var(--border-strong); border-radius: 6px; background: none; color: var(--text-dim);
      font: inherit; font-size: .76rem; cursor: pointer; }
    .related-state-btn.on { background: rgba(139,92,246,.25); color: var(--text); }
    .related-state-btn.danger { color: var(--red); }
    .related-banner { margin: .3rem 0; padding: .4rem .7rem; border: 1px solid var(--border-strong); border-radius: 7px; font-size: .8rem; color: var(--text-dim); }
    .related-pick { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; margin: .3rem 0 .6rem; padding: .5rem .7rem;
      border: 1px solid var(--border); border-radius: 8px; background: var(--card-inner); font-size: .8rem; }
    .related-pick-row { display: flex; justify-content: space-between; gap: .5rem; align-items: center; padding: .15rem 0; }
    .related-pick-row small { color: var(--text-faint); }
    .related-rec { color: var(--red); font-size: .7rem; }
    .related-open { border: 0; background: none; color: inherit; font: inherit; padding: 0; cursor: pointer; }
    .related-open:hover { text-decoration: underline; }
    .related-shared { color: var(--text-faint); font-size: .7rem; }
    .related-error { color: var(--red); font-size: .78rem; }
    @media (max-width: 760px) { .related-pick { grid-template-columns: 1fr; } }
  `],
})
export class RelatedStripComponent {
  private readonly api = inject(BoardApiService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly summary = input<BoardSummary | null>(null);
  /** Every session cycle (names, recording state). */
  readonly cycles = input<readonly SessionCycle[]>([]);
  /** Every board of every project, for relating boards. */
  readonly allBoards = input<readonly BoardSummary[]>([]);
  readonly editable = input(true);
  readonly changed = output<void>();
  readonly deleted = output<string>();

  readonly states: readonly BoardState[] = ['OPEN', 'DONE', 'ARCHIVED'];
  readonly relating = signal(false);
  readonly error = signal<string | null>(null);
  readonly verdictsOf = signal<SessionCycle | null>(null);

  readonly relatedCycles = computed(() => {
    const ids = this.summary()?.cycleIds ?? [];
    const byId = new Map(this.cycles().map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id) ?? ({ id, name: id.slice(0, 8), status: 'PAUSED' } as unknown as SessionCycle));
  });
  readonly relatedBoards = computed(() => {
    const ids = new Set(this.summary()?.boardIds ?? []);
    return this.allBoards().filter((b) => ids.has(b.board.id));
  });
  /** The names of the other boards a cycle is related to (FR-003a: one cycle, several boards). */
  sharedWith(cycleId: string): string[] {
    const me = this.summary()?.board.id;
    return this.allBoards().filter((b) => b.board.id !== me && b.cycleIds.includes(cycleId)).map((b) => b.board.name);
  }

  readonly otherBoards = computed(() => this.allBoards().filter((b) => b.board.id !== this.summary()?.board.id));

  stateName(s: BoardState): string {
    return s === 'OPEN' ? 'Open' : s === 'DONE' ? 'Done' : 'Archive';
  }

  relateCycle(id: string): void {
    this.call(this.api.relateCycle(this.boardId(), id, true));
  }

  unrelateCycle(id: string): void {
    this.call(this.api.relateCycle(this.boardId(), id, false));
  }

  relateBoard(id: string): void {
    this.call(this.api.relateBoard(this.boardId(), id, true));
  }

  unrelateBoard(id: string): void {
    this.call(this.api.relateBoard(this.boardId(), id, false));
  }

  /**
   * Records for this board (FR-008). When another cycle records the project: join it, or pause it and start a new one -
   * asked in two steps so Esc never does either.
   */
  record(kind: 'REC' | 'RETEST'): void {
    const id = this.boardId();
    this.error.set(null);
    this.api.recordForBoard(id, kind, 'ASK').subscribe({
      next: () => this.changed.emit(),
      error: async (e) => {
        const running = recordingConflict(e);
        if (!running) return this.fail(e);
        if (await this.confirmDialog.confirm(`"${running.name}" is recording this project. Record into it for this board too?`, 'Join it', 'Other options')) {
          this.call(this.api.recordForBoard(id, kind, 'JOIN'));
        } else if (await this.confirmDialog.confirm(`Pause "${running.name}" and start a new recording for this board?`, 'Pause and start', 'Cancel')) {
          this.call(this.api.recordForBoard(id, kind, 'NEW'));
        }
      },
    });
  }

  setState(state: BoardState): void {
    this.call(this.api.updateBoard(this.boardId(), { state }));
  }

  async remove(): Promise<void> {
    const s = this.summary();
    if (!s || !(await this.confirmDialog.confirm(`Delete board "${s.board.name}"? Its cycles and their calls stay and its cards move to `
      + "the project's default board. Its brief, spec files, requirements and chat are deleted."))) return;
    this.api.deleteBoard(s.board.id).subscribe({ next: () => this.deleted.emit(s.board.id), error: (e) => this.fail(e) });
  }

  private boardId(): string {
    return this.summary()?.board.id ?? '';
  }

  private call(request: Observable<unknown>): void {
    this.error.set(null);
    request.subscribe({ next: () => this.changed.emit(), error: (e) => this.fail(e) });
  }

  private fail(e: { error?: { message?: string } }): void {
    this.error.set(e?.error?.message || 'That did not work');
  }
}
