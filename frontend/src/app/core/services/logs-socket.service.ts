import { DestroyRef, Injectable, inject } from '@angular/core';
import { Observable, Subject, share } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { reconnectingSocket } from '../state/reconnecting-socket';
import { LogsSocketEvent } from '../models/logs.model';

/**
 * /ws/logs "something changed" signals (FR-036). Pages re-fetch what they show when an event for
 * their source arrives - no polling, and no list data is pushed over the socket.
 */
@Injectable({ providedIn: 'root' })
export class LogsSocketService {
  private readonly config = inject(AppConfigService);
  /** Fires after a reconnect, so open pages refetch whatever they missed while offline. */
  readonly reconnected$ = new Subject<void>();
  readonly events$: Observable<LogsSocketEvent> = reconnectingSocket<LogsSocketEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/logs`,
    () => this.reconnected$.next(),
  ).pipe(share());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reconnected$.complete());
  }
}
