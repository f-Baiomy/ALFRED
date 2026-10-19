import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { BoardSummary, CardSummary, defaultBoardId } from '../../../core/models/board.models';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { SelectOption, SelectPickerComponent } from '../../select-picker/select-picker.component';

/**
 * A card's place (specs/027 US2, mock §Card): its one home board (Move home keeps its number and status) and the session
 * cycles it is related to besides its origin - a card related to a re-test cycle shows on every board that cycle is on.
 */
@Component({
  selector: 'app-card-home',
  standalone: true,
  imports: [SelectPickerComponent],
  template: `
    <div class="card-home">
      <span class="cd-prop"><span class="cd-k">Home board</span>
        <app-select-picker class="select-compact" [disabled]="!editable() || busy()" [options]="homeOptions()" [value]="homeId()"
                           ariaLabel="Home board" (valueChange)="moveHome($event)" /></span>
      <span class="card-home-cycles">
        <span class="cd-k">Related cycles</span>
        @for (id of related(); track id) {
          <span class="related-chip cyc">◷ {{ cycleName(id) }}
            @if (editable()) { <button type="button" class="related-x" title="Unrelate this cycle" (click)="relate(id, false)">✕</button> }
          </span>
        } @empty { <span class="card-home-none">none</span> }
        @if (editable() && addOptions().length) {
          <app-select-picker class="select-compact" [options]="addOptions()" value="" placeholder="＋ relate a cycle" ariaLabel="Relate a cycle"
                             (valueChange)="relate($event, true)" />
        }
      </span>
      @if (error()) { <span class="card-home-error">{{ error() }}</span> }
    </div>`,
  styles: [`
    .card-home { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; margin: .3rem 0 .5rem; font-size: .8rem; }
    .card-home-cycles { display: inline-flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
    .card-home .related-chip { display: inline-flex; gap: .3rem; align-items: center; padding: .05rem .5rem; border: 1px solid var(--border-strong);
      border-radius: 999px; background: var(--card-inner); }
    .card-home .related-x { border: 0; background: none; color: var(--text-faint); cursor: pointer; padding: 0; }
    .card-home-none { color: var(--text-faint); }
    .card-home-error { color: var(--red); }
  `],
})
export class CardHomeComponent {
  private readonly api = inject(BoardApiService);
  private readonly cyclesApi = inject(SessionCyclesApiService);

  readonly card = input.required<CardSummary>();
  readonly editable = input(true);

  readonly boards = signal<BoardSummary[]>([]);
  readonly cycles = signal<SessionCycle[]>([]);
  readonly related = signal<string[]>([]);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly homeId = computed(() => this.card().boardId ?? defaultBoardId(this.card().project));
  /** The home board's name when it is not one of this Alfred's boards (another Alfred's, specs/035). */
  readonly homeName = input<string | null>(null);
  readonly homeOptions = computed<SelectOption[]>(() => {
    const opts = this.boards().filter((b) => b.board.state !== 'ARCHIVED' || b.board.id === this.homeId())
      .map((b) => ({ value: b.board.id, label: b.board.isDefault ? `${b.board.name} (default)` : b.board.name }));
    return opts.some((o) => o.value === this.homeId()) ? opts : [{ value: this.homeId(), label: this.homeName() || this.homeId() }, ...opts];
  });
  readonly addOptions = computed<SelectOption[]>(() => {
    const on = new Set(this.related());
    return this.cycles().filter((c) => !on.has(c.id) && c.id !== this.card().cycleId).map((c) => ({ value: c.id, label: c.name }));
  });

  constructor() {
    effect(() => {
      const c = this.card();
      untracked(() => this.load(c.id, c.project));
    });
  }

  cycleName(id: string): string {
    return this.cycles().find((c) => c.id === id)?.name ?? id.slice(0, 8);
  }

  moveHome(boardId: string): void {
    if (!boardId || boardId === this.homeId()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.moveHome(this.card().id, boardId).subscribe({
      next: () => this.busy.set(false),
      error: (e) => this.fail(e),
    });
  }

  relate(cycleId: string, on: boolean): void {
    if (!cycleId) return;
    this.error.set(null);
    this.api.relateCardCycle(this.card().id, cycleId, on).subscribe({
      next: () => this.related.set(on ? [...this.related(), cycleId] : this.related().filter((x) => x !== cycleId)),
      error: (e) => this.fail(e),
    });
  }

  private load(cardId: string, project: string): void {
    this.api.boards(project || null).subscribe({ next: (b) => this.boards.set(b), error: () => undefined });
    this.api.cardCycles(cardId).subscribe({ next: (ids) => this.related.set(ids), error: () => this.related.set([]) });
    if (!this.cycles().length) this.cyclesApi.list().subscribe({ next: (c) => this.cycles.set(c), error: () => undefined });
  }

  private fail(e: { error?: { message?: string } }): void {
    this.busy.set(false);
    this.error.set(e?.error?.message || 'That did not work');
  }
}
