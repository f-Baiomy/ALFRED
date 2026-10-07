import { Component, DestroyRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import { ProcessStatus, ServerStatus, UpdateStatus } from '../../../core/models/server-settings.model';
import { formatBytes } from '../../../shared/utils/server-settings';

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
  readonly progress = signal<string[] | null>(null);
  readonly progressKind = signal<RestartKind | null>(null);
  readonly done = signal(false);
  readonly failure = signal<string | null>(null);

  readonly formatBytes = formatBytes;

  constructor() {
    this.load();
    const destroyRef = inject(DestroyRef);
    this.socket.events$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.load());
    this.socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.backAfterRestart());
  }

  load(): void {
    this.api.status().subscribe({ next: s => this.status.set(s), error: () => undefined });
    this.api.updateStatus().subscribe({ next: u => this.update.set(u), error: () => undefined });
  }

  label(p: ProcessStatus): string {
    return PROCESS_LABELS[p.name] ?? p.name;
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
    this.progressKind.set(kind);
    this.done.set(false);
    if (kind === 'UPDATE') {
      this.progress.set(['Downloading the installer and verifying its checksum…',
        'Running the installer: Alfred stops, its program files are replaced, it starts again…',
        'Waiting for Alfred to answer…']);
      this.api.installUpdate().subscribe({
        error: e => {
          this.progress.set(null);
          this.failure.set(e?.error?.message ?? 'The update could not be started.');
        },
      });
      return;
    }
    this.progress.set(kind === 'PROXIES'
      ? ['Restarting the outbound and reverse proxies…']
      : ['Stopping the backend…', 'Starting it with the current .env (Alfred is unavailable for a moment)…', 'Waiting for Alfred to answer…']);
    this.api.restart(kind).subscribe({
      next: () => {
        if (kind === 'PROXIES') {
          this.finish('Proxies running again.');
        }
      },
      error: e => {
        this.progress.set(null);
        this.failure.set(e?.error?.message ?? 'The restart could not be started.');
      },
    });
  }

  /** The socket reconnected: after a backend restart or an update, Alfred is back. */
  private backAfterRestart(): void {
    this.load();
    if (this.progressKind() === 'BACKEND' && !this.done()) {
      this.finish('Alfred is back. Reconnected.');
    } else if (this.progressKind() === 'UPDATE' && !this.done()) {
      this.api.status().subscribe({
        next: s => this.finish(`Alfred ${s.version} is running. Reconnected.`),
        error: () => this.finish('Alfred is back. Reconnected.'),
      });
    }
  }

  private finish(message: string): void {
    this.progress.update(steps => [...(steps ?? []), `✓ ${message}`]);
    this.done.set(true);
    this.load();
  }

  closeProgress(): void {
    this.progress.set(null);
    this.progressKind.set(null);
    if (this.done()) {
      window.location.reload();
    }
  }
}
