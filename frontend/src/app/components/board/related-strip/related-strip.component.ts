import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Observable } from 'rxjs';
import { BoardSummary } from '../../../core/models/board.models';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { CycleVerdictsDialogComponent } from '../cycle-verdicts-dialog/cycle-verdicts-dialog.component';

/**
 * On the board's Cycles tab (specs/027 FR-003/006, moved there by specs/032 D11): the cycles and boards this board is related
 * to, as chips with ✕ to unrelate (the cycle and its calls stay), "＋ relate" for any cycle or board of any project, and the
 * "migrated from cycle" banner. The board's state and Record are in the header now (board-state-menu, record-line).
 */
@Component({
  selector: 'app-related-strip',
  standalone: true,
  imports: [CycleVerdictsDialogComponent],
  template: `
    @if (summary(); as s) {
      <div class="related-strip">
        @if (showCycles()) {
        <span class="related-label">Cycles:</span>
        @for (c of relatedCycles(); track c.id) {
          <span class="related-chip cyc" [class.rec]="c.status === 'RECORDING'">
            <button type="button" class="related-open" title="Every board's verdicts on this cycle's calls" (click)="verdictsOf.set(c)">{{ c.name }}</button>
            @if (c.status === 'RECORDING') { <span class="related-rec">REC</span> }
            @if (sharedWith(c.id); as others) { @if (others.length) { <span class="related-shared" [title]="'Also on ' + others.join(', ')">shared · {{ others.length }}</span> } }
            @if (editable()) { <button type="button" class="related-x" title="Unrelate (the cycle and its calls stay)" (click)="unrelateCycle(c.id)">✕</button> }
          </span>
        } @empty { <span class="related-none">none</span> }
        }
        <span class="related-label">Related boards:</span>
        @for (b of relatedBoards(); track b.board.id) {
          <span class="related-chip brd">
            {{ b.board.name }}
            @if (editable()) { <button type="button" class="related-x" title="Unrelate" (click)="unrelateBoard(b.board.id)">✕</button> }
          </span>
        } @empty { <span class="related-none">none</span> }
        @if (editable()) {
          <button type="button" class="related-chip plus" (click)="relating.set(!relating())">＋ relate cycle or board</button>
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

  readonly summary = input<BoardSummary | null>(null);
  /** Every session cycle (names, recording state). */
  readonly cycles = input<readonly SessionCycle[]>([]);
  /** Every board of every project, for relating boards. */
  readonly allBoards = input<readonly BoardSummary[]>([]);
  readonly editable = input(true);
  /** specs/033: the Cycles tab lists the cycles itself - the strip then shows only the related boards. */
  readonly showCycles = input(true);
  readonly changed = output<void>();

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
