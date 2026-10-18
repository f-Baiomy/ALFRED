import { RecordSpec } from '../../../core/models/cycles-tab.models';
import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { debounceTime, filter, merge } from 'rxjs';
import { SessionCycle } from '../../../core/models/call.model';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { SessionCyclesApiService } from '../../../core/services/session-cycles-api.service';
import { BoardBannerService } from '../../../core/state/board-banner.service';
import { SessionCyclesStateService } from '../../../core/state/session-cycles-state.service';
import { recordingConflict } from '../../../shared/utils/recording-conflict';

/**
 * Records this board's calls (specs/027 FR-008) and asks when another cycle records the project: join it, or pause it and
 * start a new one - in two steps so Esc never does either. Shared by the recording line and the Next card's Record.
 */
export async function recordForBoard(api: BoardApiService, confirmDialog: ConfirmDialogService, boardId: string,
                                     kind: 'REC' | 'RETEST' = 'REC', spec?: RecordSpec): Promise<{ cycleId: string } | { error: string } | null> {
  const ask = (onRunning: 'ASK' | 'JOIN' | 'NEW') => new Promise<{ cycleId: string } | { error: string; e?: unknown }>((resolve) =>
    (spec ? api.recordForBoard(boardId, kind, onRunning, spec) : api.recordForBoard(boardId, kind, onRunning)).subscribe({ next: (r) => resolve(r), error: (e) => resolve({ error: e?.error?.message || 'Recording did not start', e }) }));
  const first = await ask('ASK');
  if (!('error' in first)) return first;
  const running = recordingConflict((first as { e?: unknown }).e);
  if (!running) return { error: first.error };
  if (await confirmDialog.confirm(`"${running.name}" is recording this project. Record into it for this board too?`, 'Join it', 'Other options')) return ask('JOIN');
  if (await confirmDialog.confirm(`Pause "${running.name}" and start a new recording for this board?`, 'Pause and start', 'Cancel')) return ask('NEW');
  return null;
}

/**
 * The recording line under the Next card (specs/032 T046): "● Record" with what it is for, or "● Recording · N calls" with
 * Stop while one of the board's cycles records. The cycles themselves (and related boards) are on the Cycles tab.
 */
@Component({
  selector: 'app-record-line',
  standalone: true,
  styles: [`
    .sub { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; font-size: 12.5px; color: var(--text-dim); }
    .rec { display: inline-flex; align-items: center; gap: 6px; padding: 3px 11px; border: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
      border-radius: 999px; background: transparent; color: var(--red); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .rec.on { background: color-mix(in srgb, var(--red) 15%, transparent); }
    .rec:disabled { opacity: .6; cursor: default; }
    .spacer { flex: 1; }
    .faint { color: var(--text-faint); }
  `],
  template: `
    <div class="sub">
      @if (recording(); as c) {
        <button type="button" class="rec on" [disabled]="!editable() || busy()" [title]="'Stop recording ' + c.name" (click)="stop(c)">
          ● Recording{{ calls() !== null ? ' · ' + calls() + ' call' + (calls() === 1 ? '' : 's') : '' }}</button>
        <span>Stop when you finish testing.</span>
      } @else {
        <button type="button" class="rec" [disabled]="!editable() || busy()" title="Record this board's calls: joins or replaces a recording of the same project"
                (click)="record()">● Record</button>
        <span>Record the calls while you test this task.</span>
        <span class="spacer"></span>
        <span class="faint">Recordings and related boards are on the Cycles tab.</span>
      }
    </div>`,
})
export class RecordLineComponent {
  private readonly api = inject(BoardApiService);
  private readonly cyclesApi = inject(SessionCyclesApiService);
  private readonly cycleState = inject(SessionCyclesStateService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly banner = inject(BoardBannerService);

  readonly boardId = input.required<string>();
  readonly cycles = input<readonly Pick<SessionCycle, 'id' | 'name' | 'status'>[]>([]);
  readonly editable = input(true);
  readonly changed = output<void>();

  readonly busy = signal(false);
  readonly calls = signal<number | null>(null);
  readonly recording = computed(() => this.cycles().find((c) => c.status === 'RECORDING') ?? null);

  constructor() {
    effect(() => {
      const c = this.recording();
      untracked(() => (c ? this.count(c.id) : this.calls.set(null)));
    });
    // re-counted when the cycle's contents change or the board hears of new calls (listen's cards) - never on a timer
    const sub = merge(this.cycleState.contentChanged$, inject(BoardSocketService).events$.pipe(filter((e) => e.type === 'board-changed')))
      .pipe(debounceTime(1000)).subscribe(() => { const c = this.recording(); if (c) this.count(c.id); });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private count(id: string): void {
    this.cyclesApi.listCalls(id, { search: '', supplier: '', sort: 'newest', offset: 0, limit: 1, sessionId: '', operationId: '', requestId: '' }, 'internal', undefined, true)
      .subscribe({ next: (p) => this.recording()?.id === id && this.calls.set(p.total ?? null), error: () => this.calls.set(null) });
  }

  async record(): Promise<void> {
    this.busy.set(true);
    const r = await recordForBoard(this.api, this.confirmDialog, this.boardId());
    this.busy.set(false);
    if (r && 'error' in r) this.banner.show({ boardId: this.boardId(), tone: 'error', text: 'Recording did not start', detail: r.error });
    else if (r) { this.cycleState.refreshNow(); this.changed.emit(); }
  }

  stop(c: Pick<SessionCycle, 'id' | 'name'>): void {
    this.busy.set(true);
    this.cycleState.pauseRecording(c.id).subscribe({
      next: () => { this.busy.set(false); this.changed.emit(); },
      error: (e) => {
        this.busy.set(false);
        this.banner.show({ boardId: this.boardId(), tone: 'error', text: `"${c.name}" is still recording`, detail: e?.error?.message ?? null });
      },
    });
  }
}
