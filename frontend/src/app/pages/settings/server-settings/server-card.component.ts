import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import { AgentAttach, ProcessStatus, ServerStatus, UpdateStatus } from '../../../core/models/server-settings.model';
import { formatBytes } from '../../../shared/utils/server-settings';
import { ProgressInput, ProgressView, progressPhase, progressView } from '../../../shared/utils/server-progress';

type RestartKind = 'BACKEND' | 'PROXIES' | 'UPDATE';

const PROCESS_LABELS: Record<string, string> = {
  BACKEND: 'Backend',
  OUTBOUND: 'Outbound proxy',
  REVERSE: 'Reverse proxy',
  MCP: "Claude's tools (MCP)",
  LOG_AGENT: 'Log agent',
};

/**
 * The Server card (specs/012-server-program US4): what runs, the two restarts, and the update row. Status is fetched
 * when /ws/server says something changed - no polling. After "Restart Alfred" or an update the backend goes away and
 * the socket drops; its reconnect (reconnectingSocket's back-off) is the signal that Alfred is back.
 */
@Component({
  selector: 'app-server-card',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './server-card.component.html',
})
export class ServerCardComponent {
  private readonly api = inject(ServerSettingsService);
  private readonly socket = inject(ServerSocketService);

  readonly editable = input(false);
  readonly mode = input<'NATIVE' | 'DOCKER'>('NATIVE');
  readonly pendingRestart = input(false);

  readonly status = signal<ServerStatus | null>(null);
  readonly update = signal<UpdateStatus | null>(null);
  readonly checking = signal(false);
  readonly confirm = signal<RestartKind | null>(null);
  readonly progressKind = signal<RestartKind | null>(null);
  readonly done = signal(false);
  readonly accepted = signal(false);
  readonly dropped = signal(false);
  readonly back = signal(false);
  readonly progressError = signal<string | null>(null);
  readonly finalMessage = signal('');
  readonly startedAt = signal(0);
  readonly now = signal(0);
  /** The progress dialog as steps and bars (shared/utils/server-progress.ts), recomputed on every event and tick. */
  readonly view = computed<ProgressView | null>(() => {
    const input = this.input();
    return input ? progressView(input) : null;
  });

  private phase = '';
  private phaseStartedAt = 0;
  private clock: ReturnType<typeof setInterval> | undefined;
  private speed = { bytes: 0, at: 0, perSecond: 0 };
  readonly failure = signal<string | null>(null);

  readonly formatBytes = formatBytes;

  constructor() {
    this.load();
    const destroyRef = inject(DestroyRef);
    this.socket.events$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.load());
    this.socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.backAfterRestart());
    this.socket.disconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.stoppedForRestart());
    destroyRef.onDestroy(() => this.stopClock());
  }

  load(): void {
    this.api.status().subscribe({ next: s => this.status.set(s), error: () => undefined });
    this.api.updateStatus().subscribe({
      next: u => {
        this.update.set(u);
        this.jobChanged(u);
      },
      error: () => undefined,
    });
  }

  label(p: ProcessStatus): string {
    return PROCESS_LABELS[p.name] ?? p.name;
  }

  /** The supervisor's last attach attempt for a project, in words (docs/server.md "The agent attaches itself"). */
  agentState(a: AgentAttach): string {
    switch (a.state) {
      case 'ATTACHED': return 'attached by itself';
      case 'ATTACHING': return 'attaching…';
      case 'NO_JVM': return 'no app to attach to';
      case 'NOT_A_JVM': return 'not a Java process';
      case 'FAILED': return 'attach failed';
      case 'NO_PROJECT': return 'unknown project';
      case 'ELSEWHERE': return 'kept by another Alfred';
      default: return a.state.toLowerCase();
    }
  }

  /** A forced retry of the last attempt, with the features it was asked for. */
  attachAgain(a: AgentAttach): void {
    this.failure.set(null);
    const features = a.features ? a.features.split(',').filter(Boolean) : ['proxy', 'db', 'logs', 'redis'];
    this.api.attachAgent(a.project, features, true).subscribe({
      error: e => this.failure.set(e?.error?.message ?? 'The attach could not be started.'),
    });
  }

  jobText(u: UpdateStatus): string {
    switch (u.job.state) {
      case 'DOWNLOADING': {
        const total = u.job.totalBytes || u.sizeBytes;
        const pct = total ? ` ${Math.min(100, Math.round((u.job.downloadedBytes / total) * 100))}%` : '';
        return `downloading Alfred ${u.job.version}${pct}`;
      }
      case 'VERIFYING':
        return `verifying the installer of ${u.job.version}`;
      case 'INSTALLING':
        return `installing Alfred ${u.job.version} - it restarts in a moment`;
      default:
        return u.job.state.toLowerCase();
    }
  }

  /** "2 days ago", "3 hours ago", "just now" - for the check time and the release date. */
  relativeDate(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) {
      return iso;
    }
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) {
      return 'just now';
    }
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 48) {
      return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    const days = Math.round(hours / 24);
    return `${days} days ago`;
  }

  checkNow(): void {
    this.checking.set(true);
    this.api.checkUpdate().subscribe({
      next: u => {
        this.update.set(u);
        this.checking.set(false);
      },
      error: e => {
        this.checking.set(false);
        this.failure.set(e?.error?.message ?? 'The update check failed.');
      },
    });
  }

  ask(kind: RestartKind): void {
    this.failure.set(null);
    this.confirm.set(kind);
  }

  askUpdate(): void {
    this.ask('UPDATE');
  }

  restart(): void {
    const kind = this.confirm();
    if (!kind) {
      return;
    }
    this.confirm.set(null);
    this.failure.set(null);
    this.progressKind.set(kind);
    this.done.set(false);
    this.accepted.set(false);
    this.dropped.set(false);
    this.back.set(false);
    this.progressError.set(null);
    this.finalMessage.set('');
    this.speed = { bytes: 0, at: 0, perSecond: 0 };
    this.startedAt.set(Date.now());
    this.now.set(Date.now());
    this.syncPhase();
    this.startClock();
    const request = kind === 'UPDATE' ? this.api.installUpdate() : this.api.restart(kind);
    request.subscribe({
      next: () => {
        this.accepted.set(true);
        this.syncPhase();
        if (kind === 'PROXIES') {
          this.finish('Proxies running again');
        }
      },
      error: e => this.fail(e?.error?.message ?? (kind === 'UPDATE' ? 'The update could not be started.' : 'The restart could not be started.')),
    });
  }

  /**
   * The socket closed while a restart or an install runs: Alfred stopped - but only once it can have: the installer
   * running, or the restart accepted. A close during the download is a network blip (or a socket that never
   * connected), not the installer stopping Alfred.
   */
  private stoppedForRestart(): void {
    const kind = this.progressKind();
    if (!kind || kind === 'PROXIES' || this.done()) {
      return;
    }
    const canHaveStopped = kind === 'UPDATE' ? this.update()?.job.state === 'INSTALLING' : this.accepted();
    if (canHaveStopped) {
      this.dropped.set(true);
      this.syncPhase();
    }
  }

  /**
   * The socket reconnected: after a backend restart or an update, Alfred is back. A reconnect before Alfred went
   * away (a network blip during the download) is not the end of an install - only one after the drop, the installer
   * starting or an accepted backend restart counts.
   */
  private backAfterRestart(): void {
    this.load();
    const kind = this.progressKind();
    if (!kind || kind === 'PROXIES' || this.done()) {
      return;
    }
    const installing = this.update()?.job.state === 'INSTALLING';
    if (!this.dropped() && !(kind === 'UPDATE' && installing) && !(kind === 'BACKEND' && this.accepted())) {
      return;
    }
    this.back.set(true);
    this.syncPhase();
    if (kind === 'BACKEND') {
      this.finish('Alfred is back');
      return;
    }
    // Back on the old version means the installer did not replace it - green "running" would hide that.
    const wanted = this.update()?.job.version || this.update()?.latestVersion || '';
    this.api.status().subscribe({
      next: s => wanted && s.version !== wanted
        ? this.fail(`Alfred came back on ${s.version}, not ${wanted} - the installer did not replace it. See data/log/update.log.`)
        : this.finish(`Alfred ${s.version} is running`),
      error: () => this.finish('Alfred is back'),
    });
  }

  private fail(message: string): void {
    this.progressError.set(message);
    this.syncPhase();
    this.done.set(true);
    this.stopClock();
  }

  private finish(message: string): void {
    this.finalMessage.set(message);
    this.done.set(true);
    this.stopClock();
    this.load();
  }

  /** The update job as fetched: a FAILED one ends the dialog; the bytes feed the download speed. */
  private jobChanged(u: UpdateStatus): void {
    if (this.progressKind() !== 'UPDATE' || this.done()) {
      return;
    }
    const now = Date.now();
    if (u.job.state === 'DOWNLOADING') {
      if (this.speed.at && u.job.downloadedBytes > this.speed.bytes && now > this.speed.at) {
        const sample = (u.job.downloadedBytes - this.speed.bytes) * 1000 / (now - this.speed.at);
        this.speed.perSecond = this.speed.perSecond ? this.speed.perSecond * 0.6 + sample * 0.4 : sample;
      }
      this.speed.bytes = u.job.downloadedBytes;
      this.speed.at = now;
    }
    this.syncPhase();
    if (u.job.state === 'FAILED') {
      this.fail(u.job.error || 'The update failed.');
    }
  }

  private input(): ProgressInput | null {
    const kind = this.progressKind();
    if (!kind) {
      return null;
    }
    return {
      kind,
      job: kind === 'UPDATE' ? this.update()?.job ?? null : null,
      sizeBytes: this.update()?.sizeBytes ?? 0,
      accepted: this.accepted(),
      dropped: this.dropped(),
      back: this.back(),
      error: this.progressError(),
      phaseMs: this.now() - this.phaseStartedAt,
      bytesPerSecond: this.speed.perSecond || undefined,
    };
  }

  /** Restarts the phase clock when the phase changed - each stretch's creep starts from its own beginning. */
  private syncPhase(): void {
    const input = this.input();
    const phase = input ? progressPhase(input) : '';
    if (phase !== this.phase) {
      this.phase = phase;
      this.phaseStartedAt = Date.now();
      this.now.set(this.phaseStartedAt);
    }
  }

  /** The dialog's own clock: the elapsed time and the creep. A UI timer - nothing is fetched on it. */
  private startClock(): void {
    this.stopClock();
    this.clock = setInterval(() => this.now.set(Date.now()), 250);
  }

  private stopClock(): void {
    if (this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  elapsed(): string {
    const seconds = Math.max(0, Math.round((this.now() - this.startedAt()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  progressTitle(): string {
    const kind = this.progressKind();
    const failed = this.view()?.outcome === 'failed';
    if (kind === 'UPDATE') {
      return failed ? 'Update failed' : `Installing Alfred ${this.update()?.latestVersion ?? ''}`.trim();
    }
    if (failed) {
      return 'Restart failed';
    }
    return kind === 'PROXIES' ? 'Restarting proxies' : 'Restarting Alfred';
  }

  closeProgress(): void {
    const reload = this.done() && this.view()?.outcome === 'ok' && this.progressKind() !== 'PROXIES';
    this.stopClock();
    this.progressKind.set(null);
    this.done.set(false);
    if (reload) {
      window.location.reload();
    }
  }
}
