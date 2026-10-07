import { DestroyRef, Injectable, inject } from '@angular/core';
import { Observable, Subject, share } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { reconnectingSocket } from '../state/reconnecting-socket';

export interface ServerSocketEvent {
  type: 'server-status-changed';
  /** "settings", "process", "restart" - what changed; clients re-fetch either way. */
  what: string;
}

/**
 * /ws/server "something about the server changed" signals (specs/012-server-program): the Server section re-fetches
 * on each one - no polling. After a backend restart the socket reconnects by itself (reconnectingSocket's back-off),
 * which is how the page knows Alfred is back.
 */
@Injectable({ providedIn: 'root' })
export class ServerSocketService {
  private readonly config = inject(AppConfigService);
  /** Fires after a reconnect - after a restart of Alfred, this is the "it is back" signal. */
  readonly reconnected$ = new Subject<void>();
  readonly events$: Observable<ServerSocketEvent> = reconnectingSocket<ServerSocketEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/server`,
    () => this.reconnected$.next(),
  ).pipe(share());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reconnected$.complete());
  }
}
