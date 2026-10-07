import { Component, DestroyRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ServerSettingsService } from '../../../core/services/server-settings.service';
import { ServerSocketService } from '../../../core/services/server-socket.service';
import { ProcessStatus, ServerStatus } from '../../../core/models/server-settings.model';
import { formatBytes } from '../../../shared/utils/server-settings';

type RestartKind = 'BACKEND' | 'PROXIES';

const PROCESS_LABELS: Record<string, string> = {
  BACKEND: 'Backend',
  OUTBOUND: 'Outbound proxy',
  REVERSE: 'Reverse proxy',
  MCP: "Claude's tools (MCP)",
  LOG_AGENT: 'Log agent',
};

/**
 * The Server card (specs/012-server-program US4): what runs, and the two restarts. Status is fetched when /ws/server
 * says something changed - no polling. After "Restart Alfred" the backend goes away and the socket drops; its
 * reconnect (reconnectingSocket's back-off) is the signal that Alfred is back.
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
  }

  label(p: ProcessStatus): string {
    return PROCESS_LABELS[p.name] ?? p.name;
  }

  ask(kind: RestartKind): void {
    this.failure.set(null);
    this.confirm.set(kind);
  }

  restart(): void {
    const kind = this.confirm();
    if (!kind) {
      return;
    }
    this.confirm.set(null);
    this.progressKind.set(kind);
    this.done.set(false);
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

  /** The socket reconnected: after a backend restart, Alfred is back. */
  private backAfterRestart(): void {
    this.load();
    if (this.progressKind() === 'BACKEND' && !this.done()) {
      this.finish('Alfred is back. Reconnected.');
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
