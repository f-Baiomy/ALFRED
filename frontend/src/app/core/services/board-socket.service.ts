import { DestroyRef, Injectable, inject } from '@angular/core';
import { Observable, Subject, filter, map, merge, share } from 'rxjs';
import { BoardSocketEvent } from '../models/board.models';
import { AppConfigService } from './app-config.service';
import { reconnectingSocket } from '../state/reconnecting-socket';
import { LinksSocketService } from '../links/links-socket.service';

/**
 * /ws/board "something on the board changed" signals (specs/014-task-board contracts/websocket.md): the board and the
 * cycle page re-fetch what they show on each one - no polling. `reconnected$` lets them catch up after the socket was away.
 */
@Injectable({ providedIn: 'root' })
export class BoardSocketService {
  private readonly config = inject(AppConfigService);
  readonly reconnected$ = new Subject<void>();
  /**
   * This Alfred's /ws/board, and the board signals of every board streamed to it (specs/035): their ids already carry
   * the link's suffix, so a page showing another Alfred's board matches them like its own.
   */
  readonly events$: Observable<BoardSocketEvent> = merge(
    reconnectingSocket<BoardSocketEvent>(`${this.config.backendUrl.replace(/^http/, 'ws')}/ws/board`, () => this.reconnected$.next()),
    inject(LinksSocketService).events$.pipe(
      filter((e) => e.type === 'signal' && e.channel === 'board' && !!e.data && typeof e.data === 'object'),
      map((e) => (e as unknown as { data: BoardSocketEvent }).data),
    ),
  ).pipe(share());

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reconnected$.complete());
  }
}
