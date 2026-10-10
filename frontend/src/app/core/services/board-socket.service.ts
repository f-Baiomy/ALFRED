import { DestroyRef, Injectable, inject } from '@angular/core';
import { Observable, Subject, share } from 'rxjs';
import { BoardSocketEvent } from '../models/board.models';
import { AppConfigService } from './app-config.service';
import { reconnectingSocket } from '../state/reconnecting-socket';

/**
 * /ws/board "something on the board changed" signals (specs/014-task-board contracts/websocket.md): the board and the
 * cycle page re-fetch what they show on each one - no polling. `reconnected$` lets them catch up after the socket was away.
 */
@Injectable({ providedIn: 'root' })
export class BoardSocketService {
  private readonly config = inject(AppConfigService);
  readonly reconnected$ = new Subject<void>();
  readonly events$: Observable<BoardSocketEvent> = reconnectingSocket<BoardSocketEvent>(
    `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/board`,
    () => this.reconnected$.next(),
  ).pipe(share());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reconnected$.complete());
  }
}
