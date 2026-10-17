import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { CallVerdicts, CycleVerdicts } from '../../../core/models/board.models';
import { BoardApiService } from '../../../core/services/board-api.service';
import { VerdictCell, cellFor, columnsFor, rowsFor } from '../../../shared/utils/cycle-verdicts';
import { RunSkillComponent } from '../run-skill/run-skill.component';

/**
 * One cycle shared by several boards (specs/027 US3, mock §Shared cycle): its calls, each related board's verdict on
 * each, and the cards that mention them with their home. "All" or one board; ▶ /alfred-listen judges the cycle once.
 */
@Component({
  selector: 'app-cycle-verdicts-dialog',
  standalone: true,
  imports: [RunSkillComponent],
  template: `
    <div class="cv-backdrop" (click)="closed.emit()"></div>
    <div class="cv-dialog" role="dialog" aria-modal="true" [attr.aria-label]="'Verdicts of ' + (cycleName() || cycleId())">
      <div class="cv-head">
        <b>{{ cycleName() || cycleId() }}</b>
        <span class="cv-sub">{{ data()?.boards?.length ?? 0 }} board(s) judge this cycle</span>
        <span class="cv-grow"></span>
        <app-run-skill [command]="'/alfred-listen ' + cycleId()" [project]="project()" [cycleId]="cycleId()" [cycleName]="cycleName()" />
        <button type="button" class="cv-x" title="Close (Esc)" (click)="closed.emit()">✕</button>
      </div>
      <div class="cv-filter">
        <button type="button" class="board-pill" [class.on]="!board()" (click)="board.set(null)">All</button>
        @for (b of data()?.boards ?? []; track b.boardId) {
          <button type="button" class="board-pill" [class.on]="board() === b.boardId" (click)="board.set(b.boardId)">for {{ b.name }}</button>
        }
      </div>
      @if (error()) { <div class="cv-error">{{ error() }}</div> }
      <div class="cv-table-wrap">
        <table class="cv-table">
          <thead><tr><th>Call</th><th>Status</th>@for (col of columns(); track col.boardId) { <th>{{ col.name }}</th> }<th>Cards</th></tr></thead>
          <tbody>
            @for (c of rows(); track c.callId) {
              <tr>
                <td class="cv-call"><b>{{ c.method }}</b> {{ c.endpoint }}</td>
                <td>{{ c.status ?? '…' }}</td>
                @for (col of columns(); track col.boardId) {
                  <td><span [class]="'cv-cell cv-' + cell(c, col.boardId).tone">{{ cell(c, col.boardId).text }}</span></td>
                }
                <td>
                  @for (k of c.cards; track k.project + k.number) {
                    <span class="cv-card" [title]="k.title ?? ''">#{{ k.number }}@if (k.home) { <small> ⌂ {{ boardName(k.home) }}</small> }</span>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td [attr.colspan]="columns().length + 3" class="cv-empty">{{ loading() ? 'Loading…' : 'No calls' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>`,
  styles: [`
    .cv-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,.45); }
    .cv-dialog { position: fixed; z-index: 61; inset: 6vh 4vw; display: flex; flex-direction: column; gap: .5rem; padding: .8rem 1rem;
      border: 1px solid var(--border-strong); border-radius: 10px; background: var(--popover-solid); }
    .cv-head, .cv-filter { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
    .cv-sub { color: var(--text-dim); font-size: .8rem; }
    .cv-grow { flex: 1; }
    .cv-x { border: 0; background: none; color: var(--text-dim); cursor: pointer; font-size: 1rem; }
    .cv-table-wrap { overflow: auto; flex: 1; }
    .cv-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .cv-table th, .cv-table td { padding: .25rem .5rem; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
    .cv-call { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
    .cv-cell { padding: .05rem .45rem; border-radius: 999px; font-size: .74rem; }
    .cv-bad { background: rgba(239,68,68,.2); color: var(--red); }
    .cv-warn { background: rgba(245,158,11,.18); color: var(--amber); }
    .cv-ok { background: rgba(34,197,94,.18); color: var(--green); }
    .cv-card { margin-right: .4rem; }
    .cv-card small { color: var(--text-faint); }
    .cv-empty { color: var(--text-faint); text-align: center; }
    .cv-error { color: var(--red); font-size: .8rem; }
    @media (max-width: 760px) { .cv-dialog { inset: 2vh 2vw; } }
  `],
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class CycleVerdictsDialogComponent {
  private readonly api = inject(BoardApiService);

  readonly cycleId = input.required<string>();
  readonly cycleName = input<string | null>(null);
  readonly project = input('');
  /** The board it was opened from: shown first and picked. */
  readonly forBoard = input<string | null>(null);
  readonly closed = output<void>();

  readonly data = signal<CycleVerdicts | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly board = signal<string | null>(null);

  readonly columns = computed(() => columnsFor(this.data()?.boards ?? [], this.forBoard()));
  readonly rows = computed(() => rowsFor(this.data()?.calls ?? [], this.board()));

  constructor() {
    effect(() => {
      const id = this.cycleId();
      untracked(() => {
        this.board.set(this.forBoard());
        this.loading.set(true);
        this.api.cycleVerdicts(id).subscribe({
          next: (d) => {
            this.data.set(d);
            this.loading.set(false);
          },
          error: (e) => {
            this.loading.set(false);
            this.error.set(e?.error?.message || 'Could not read the verdicts');
          },
        });
      });
    });
  }

  cell(c: CallVerdicts, boardId: string): VerdictCell {
    return cellFor(c, boardId);
  }

  boardName(id: string): string {
    return this.data()?.boards.find((b) => b.boardId === id)?.name ?? (id.startsWith('default:') ? id.slice(8) : id.slice(0, 8));
  }
}
