import { Component, DestroyRef, OnDestroy, computed, effect, inject, input, output, signal } from '@angular/core';
import { LiveWorkStateService, currentStep } from '../../../core/state/live-work-state.service';
import { AgentStatus, LiveRunnerInfo, SkillRun, answererLabel } from '../../../core/models/board.models';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SkillRunsStateService, waiting } from '../../../core/state/skill-runs-state.service';
import { runDuration } from '../../../shared/utils/skill-prompt';

/** A status not updated for this long reads as "Claude stopped" (the backend reads it the same way). */
export const AGENT_EXPIRY_MS = 10 * 60 * 1000;

/**
 * What Claude is doing on this board (FR-044): watching (with what it checked and added), paused, or stopped - and
 * Pause / Resume / Stop. Driven by /ws/board agent-status messages; one timer to the expiry deadline flips it to
 * "stopped" when Claude goes quiet (a single delay, re-armed per message - not a refresh).
 */
@Component({
  selector: 'app-live-strip',
  standalone: true,
  template: `
    @if (answerer(); as a) {
      <div class="board-live live-strip-answerer" role="status">
        <span class="live-strip-dot"></span>
        <span>Answering you: <b>{{ who(a).name }}</b>{{ a.host ? ' · ' + a.host : '' }} · <span class="board-dim">stop it with {{ who(a).stop }}</span></span>
      </div>
    }
    @for (w of liveNow(); track w.id) {
      <div class="board-live live-strip-work" role="status">
        <span class="live-spinner"></span><b>✦ Live</b>
        <span class="board-live-step">{{ w.head }} · #{{ w.cardNumber }} · {{ step(w) }}</span>
        @if (editable()) { <button type="button" class="action-btn" [disabled]="w.stop" (click)="live.stop(w.id)">{{ w.stop ? 'Stopping…' : 'Stop' }}</button> }
      </div>
    }
    @if (cycleId()) {
      <div class="board-live live-strip-chat" [class.quiet]="chat() && !chat()!.chatAlive" [class.none]="!chat()" role="status">
        <span class="live-strip-dot"></span>
        @if (chat(); as c) {
          <span>▶ runs in: <b>chat on {{ c.host }}</b> · {{ kinds() }}
            @if (!c.chatAlive) { · <span class="live-strip-warn">the chat seems closed - open it again, or stop it there and start a new one</span> }
          </span>
        } @else {
          <span class="board-dim">○ No chat handles this cycle - ▶ shows how to start one</span>
        }
        @if (boardRuns().length) {
          <span class="board-live-step">
            @if (running().length) { · <b>{{ running().length }} running</b> ({{ runningText() }}) }
            @if (queued().length) { · <b>{{ queued().length }} waiting</b> ({{ queuedText() }}) }
          </span>
        }
        @if (editable() && queued().length) {
          <button type="button" class="action-btn" title="Cancel every request the chat has not taken yet" (click)="runs.stopAll(project() ?? '')">✕ Cancel all waiting</button>
        }
      </div>
    } @else if (boardRuns().length) {
      <div class="board-live live-strip-runs" role="status">
        <span class="live-spinner"></span><b>✦ Claude on the board</b>
        <span class="board-live-step">
          @if (running().length) { <b>{{ running().length }} running</b> ({{ runningText() }}) }
          @if (queued().length) { · <b>{{ queued().length }} waiting</b> ({{ queuedText() }}) }
        </span>
        @if (editable() && queued().length) {
          <button type="button" class="action-btn" title="Cancel every request a chat has not taken yet" (click)="runs.stopAll(project() ?? '')">✕ Cancel all waiting</button>
        }
      </div>
    }
    @if (status(); as s) {
      <div class="board-live" [class.paused]="state() === 'PAUSED'" [class.stopped]="state() === 'STOPPED'">
        <span class="board-pulse"></span>
        <b>{{ headline() }}</b>
        @if (s.step && state() !== 'STOPPED') { <span class="board-live-step">{{ s.step }}</span> }
        <span class="board-dim">checked {{ s.callsChecked }} calls · {{ s.cardsAdded }} cards added · last check {{ time(s.lastCheckAt) }}</span>
        @if (editable()) {
          <span class="board-live-acts">
            @if (state() === 'WATCHING') { <button type="button" class="action-btn" (click)="action.emit('pause')">Pause</button> }
            @if (state() === 'PAUSED') { <button type="button" class="action-btn" (click)="action.emit('resume')">Resume</button> }
            @if (state() !== 'STOPPED') { <button type="button" class="action-btn" (click)="action.emit('stop')">Stop</button> }
          </span>
        }
      </div>
    }`,
})
export class LiveStripComponent implements OnDestroy {
  readonly status = input<AgentStatus | null>(null);
  readonly editable = input(true);
  readonly action = output<'pause' | 'resume' | 'stop'>();
  /** The project this strip is for - its /alfred-live answers in progress show above Claude's status. */
  readonly project = input<string | null>(null);
  /** The cycle in view: its chat (where ▶ runs) is shown. */
  readonly cycleId = input<string | null>(null);
  readonly live = inject(LiveWorkStateService);
  readonly liveNow = computed(() => this.live.working().filter((w) => this.project() === null || w.project === this.project()));
  readonly step = currentStep;
  readonly runs = inject(SkillRunsStateService);
  /** Every run started with ▶ on this board (this cycle's, when one is in view), waiting or running. */
  readonly boardRuns = computed(() => (this.runs.projects(), this.project() === null ? [] : this.runs.active(this.project()!, this.cycleId())));
  readonly running = computed(() => this.boardRuns().filter((r) => r.state === 'RUNNING'));
  readonly queued = computed(() => this.boardRuns().filter(waiting));
  readonly chat = computed(() => (this.runs.cycles(), this.runs.chat(this.cycleId())));
  readonly kinds = computed(() => (this.chat()?.kinds ?? []).map((k) => `/alfred-${k}`).join(' + '));
  readonly runningText = computed(() => this.running().map((r) => `${label(r)} · ${runDuration(r)}`).join(', '));
  readonly queuedText = computed(() => this.queued().map(label).join(', '));

  /** Who answers the user on this board (specs/020) - the board once said "/alfred-live" while listen's lane answered. */
  readonly answerer = signal<LiveRunnerInfo | null>(null);
  readonly who = answererLabel;
  private readonly api = inject(BoardApiService);

  private readonly expired = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  readonly state = computed(() => {
    const s = this.status();
    if (!s) return 'STOPPED';
    return this.expired() ? 'STOPPED' : s.state;
  });
  readonly headline = computed(() => {
    const where = this.status()?.cycleId ? ` ${this.status()?.cycleId}` : ' this board';
    switch (this.state()) {
      case 'WATCHING': return `✦ Claude is watching${where}`;
      case 'PAUSED': return `✦ Claude paused on${where}`;
      default: return '✦ Claude stopped';
    }
  });

  constructor() {
    effect(() => {
      const p = this.project();
      if (p === null) return;
      this.runs.watch(p);
      this.runs.watchCycle(p, this.cycleId());
      this.loadAnswerer(p);
    }, { allowSignalWrites: true });
    inject(BoardSocketService).events$.pipe(
      filter((e) => e.type === 'live-runner' && (this.project() === null || e.project === this.project())),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe(() => { const p = this.project(); if (p !== null) this.loadAnswerer(p); });
    effect(() => {
      const s = this.status();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (!s) return;
      const left = Date.parse(s.updatedAt) + AGENT_EXPIRY_MS - Date.now();
      this.expired.set(left <= 0);
      if (left > 0) this.timer = setTimeout(() => this.expired.set(true), left);
    }, { allowSignalWrites: true });
  }

  private loadAnswerer(project: string): void {
    // an Alfred without the heartbeat answers 404: no line
    this.api.liveRunner(project).subscribe({ next: (r) => this.answerer.set(r ?? null), error: () => this.answerer.set(null) });
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

/** "#31 fix", or the command itself for a run without a card. */
function label(r: SkillRun): string {
  return r.cardNumber != null ? `#${r.cardNumber} ${r.command.split(/\s+/)[0].replace('/alfred-', '')}` : r.command;
}
