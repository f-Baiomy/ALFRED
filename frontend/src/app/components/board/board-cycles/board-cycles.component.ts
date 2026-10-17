import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { filter } from 'rxjs';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';

/**
 * A board's Cycles (specs/028 US7 FR-095..097): the recordings this board holds - a cycle only holds calls; the board is
 * where the task lives. Record a cycle starts one for this board (one recording per project).
 */
@Component({
  selector: 'app-board-cycles',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="bc">
      <div class="bc-head">
        <span class="board-dim">{{ cycles().length }} cycle(s) on this board</span>
        <span class="bc-grow"></span>
        @if (editable()) {
          <button type="button" class="action-btn primary" [disabled]="busy()" (click)="record('REC')">● Record a cycle</button>
          <button type="button" class="action-btn" [disabled]="busy()" (click)="record('RETEST')">Re-test cycle</button>
        }
      </div>
      @if (message()) { <div class="bc-msg" [class.err]="isError()">{{ message() }}</div> }
      <table class="bc-table">
        <thead><tr><th>Cycle</th><th>Status</th><th>Created</th></tr></thead>
        <tbody>
          @for (c of cycles(); track c.id) {
            <tr>
              <td><a [routerLink]="['/cycles', c.id]">{{ c.name }}</a></td>
              <td>@if (c.status === 'RECORDING') { <span class="bc-rec">● recording</span> } @else { {{ c.status.toLowerCase() }} }</td>
              <td class="board-dim">{{ c.createdAt.slice(0, 16).replace('T', ' ') }}</td>
            </tr>
          } @empty { <tr><td colspan="3" class="board-dim">No cycle yet - Record a cycle while you test the task.</td></tr> }
        </tbody>
      </table>
    </div>`,
  styles: [`
    .bc { display: grid; gap: .5rem; }
    .bc-head { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
    .bc-grow { flex: 1; }
    .bc-msg { font-size: .8rem; color: var(--green); }
    .bc-msg.err { color: var(--red); }
    .bc-rec { color: var(--red); }
    .bc-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
    .bc-table th, .bc-table td { padding: .3rem .45rem; border-bottom: 1px solid var(--border); text-align: left; }
    .bc-table th { color: var(--text-dim); font-weight: 500; font-size: .74rem; }
  `],
})
export class BoardCyclesComponent {
  private readonly board = inject(BoardApiService);
  private readonly cyclesApi = inject(SessionCyclesApiService);

  readonly boardId = input.required<string>();
  readonly editable = input(true);

  private readonly ids = signal<readonly string[]>([]);
  private readonly all = signal<SessionCycle[]>([]);
  readonly cycles = computed(() => this.all().filter((c) => this.ids().includes(c.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly isError = signal(false);

  constructor() {
    effect(() => {
      const id = this.boardId();
      untracked(() => this.load(id));
    });
    const sub = inject(BoardSocketService).events$.pipe(filter((e) => e.type === 'board-changed' && (e.what === 'boards' || e.what === 'deleted')))
      .subscribe(() => this.load(this.boardId()));
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private load(id: string): void {
    this.board.board(id).subscribe({ next: (b) => this.boardId() === id && this.ids.set(b.cycleIds), error: () => this.ids.set([]) });
    this.cyclesApi.list().subscribe({ next: (c) => this.all.set(c), error: () => undefined });
  }

  record(kind: 'REC' | 'RETEST'): void {
    this.busy.set(true);
    this.board.recordForBoard(this.boardId(), kind, 'ASK').subscribe({
      next: (r) => {
        this.busy.set(false);
        this.message.set(r.message || 'Recording');
        this.isError.set(false);
        this.load(this.boardId());
      },
      error: (e) => {
        this.busy.set(false);
        this.isError.set(true);
        this.message.set(e?.error?.error === 'RECORDING_CONFLICT' ? 'Another cycle records this project - pause it first, or join it from Session Cycles'
          : e?.error?.message || 'Could not start recording');
      },
    });
  }
}
