import { Component, DestroyRef, OnDestroy, computed, effect, inject, input, output, signal } from '@angular/core';
import { LiveWorkStateService, currentStep } from '../../../core/state/live-work-state.service';
import { AgentStatus, LiveRunnerInfo, SkillRun } from '../../../core/models/board.models';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { BoardApiService } from '../../../core/services/board-api.service';
import { BoardSocketService } from '../../../core/services/board-socket.service';
import { SkillRunsStateService, waiting } from '../../../core/state/skill-runs-state.service';
import { runDuration } from '../../../shared/utils/skill-prompt';
import { SessionsStateService } from '../../../core/state/sessions-state.service';

/** A status not updated for this long reads as "Claude stopped" (the backend reads it the same way). */
export const AGENT_EXPIRY_MS = 10 * 60 * 1000;

/** A runner whose heartbeat is older than this no longer answers (the backend's RUNNER_ALIVE, plus a little slack). */
export const RUNNER_EXPIRY_MS = 2 * 60 * 1000 + 5000;

/**
 * What Claude is doing on this board (FR-044), only while it does something (specs/032 D12): the runs it works on or
 * waits to take, with Open in Desktop and Stop, and watching a recording (with what it checked and added) - Pause /
 * Resume / Stop. An idle board shows no row. Driven by /ws/board agent-status messages; one timer to the expiry deadline flips it to
 * "stopped" when Claude goes quiet (a single delay, re-armed per message - not a refresh).
 */
@Component({
  selector: 'app-live-strip',
  standalone: true,
  template: `
    @for (w of liveNow(); track w.id) {
      <div class="board-live live-strip-work" role="status">
        <span class="live-spinner"></span><b>✦ Live</b>
        <span class="board-live-step">{{ w.head }} · #{{ w.cardNumber }} · {{ step(w) }}</span>
        @if (editable()) { <button type="button" class="action-btn" [disabled]="w.stop" (click)="live.stop(w.id)">{{ w.stop ? 'Stopping…' : 'Stop' }}</button> }
      </div>
    }
    <!-- one row, only while Claude works: a run, or watching a recording - an idle board shows nothing (specs/032 D12) -->
    @if (boardRuns().length) {
      <div class="board-live live-strip-chat" role="status">
        <span class="live-strip-dot"></span>
        <span><b>Claude</b>@if (host()) { on {{ host() }} }
          @if (running().length) { · {{ runningText() }} }
          @if (queued().length) { · <b>{{ queued().length }} waiting</b> ({{ queuedText() }}) }
          @if (chat() && !chat()!.chatAlive) { · <span class="live-strip-warn">the chat seems closed - open it again, or stop it there and start a new one</span> }
        </span>
        @if (editable()) {
          <span class="board-live-acts">
            @if (mySession(); as s) { <button type="button" class="action-btn" (click)="openDesktop()">Open in Desktop</button> }
            <button type="button" class="action-btn" title="Stop what runs and cancel what waits" (click)="stopRuns()">Stop</button>
          </span>
        }
      </div>
    }
    @if (status(); as s) {
      @if (state() !== 'STOPPED') {
        <div class="board-live" [class.paused]="state() === 'PAUSED'">
          <span class="board-pulse"></span>
          <b>{{ headline() }}</b>
          @if (s.step) { <span class="board-live-step">{{ s.step }}</span> }
          <span class="board-dim">checked {{ s.callsChecked }} calls · {{ s.cardsAdded }} cards added · last check {{ time(s.lastCheckAt) }}</span>
          @if (editable()) {
            <span class="board-live-acts">
              @if (state() === 'WATCHING') { <button type="button" class="action-btn" (click)="action.emit('pause')">Pause</button> }
              @if (state() === 'PAUSED') { <button type="button" class="action-btn" (click)="action.emit('resume')">Resume</button> }
              <button type="button" class="action-btn" (click)="action.emit('stop')">Stop</button>
            </span>
          }
        </div>
      }
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
  readonly runningText = computed(() => this.running().map((r) => `${label(r)} · ${runDuration(r)}`).join(', '));
  readonly queuedText = computed(() => this.queued().map(label).join(', '));

  /** Who answers the user on this board (specs/020) - the board once said "/alfred-live" while listen's lane answered. */
  readonly answerer = signal<LiveRunnerInfo | null>(null);
  private readonly api = inject(BoardApiService);

  private readonly expired = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** One delay to the answerer's expiry: a runner that was killed sends no last "stopped" beat, so no signal comes. */
  private answererTimer: ReturnType<typeof setTimeout> | null = null;

  readonly state = computed(() => {
    const s = this.status();
    if (!s) return 'STOPPED';
    return this.expired() ? 'STOPPED' : s.state;
  });
  private readonly sessions = inject(SessionsStateService);
  /** Where Claude runs: the chat that takes the runs, else the runner that answers the board. */
  readonly host = computed(() => this.chat()?.host ?? this.answerer()?.host ?? null);
  /** This user's session on the board in view, to open in Claude Desktop. */
  readonly mySession = computed(() => {
    const s = this.sessions.currentSession(this.cycleId());
    return s && s.user === this.sessions.user() ? s : null;
  });

  readonly headline = computed(() => {
    const where = this.status()?.cycleId ? ` ${this.status()?.cycleId}` : ' this board';
    switch (this.state()) {
      case 'WATCHING': return `✦ Claude is watching${where}`;
      case 'PAUSED': return `✦ Claude paused on${where}`;
      default: return '✦ Claude stopped';
    }
  });

  openDesktop(): void {
    const s = this.mySession();
    if (s) this.sessions.send('OPEN_DESKTOP', { boardId: s.boardId, project: s.project, sessionId: s.id, helperKeyId: s.helperKeyId,
      args: { cliSessionId: s.cliSessionId } }).subscribe();
  }

  stopRuns(): void {
    for (const r of this.running()) this.runs.stop(r);
    if (this.queued().length) this.runs.stopAll(this.project() ?? '');
  }

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
    this.api.liveRunner(project).subscribe({ next: (r) => this.setAnswerer(r ?? null), error: () => this.setAnswerer(null) });
  }

  private setAnswerer(r: LiveRunnerInfo | null): void {
    if (this.answererTimer) clearTimeout(this.answererTimer);
    this.answererTimer = null;
    const left = r?.lastSeen ? Date.parse(r.lastSeen) + RUNNER_EXPIRY_MS - Date.now() : Infinity;
    if (left <= 0) {
      this.answerer.set(null);
      return;
    }
    this.answerer.set(r);
    if (Number.isFinite(left)) this.answererTimer = setTimeout(() => this.answerer.set(null), left);
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.answererTimer) clearTimeout(this.answererTimer);
  }
}

/** "#31 fix", or the command itself for a run without a card. */
function label(r: SkillRun): string {
  return r.cardNumber != null ? `#${r.cardNumber} ${r.command.split(/\s+/)[0].replace('/alfred-', '')}` : r.command;
}
