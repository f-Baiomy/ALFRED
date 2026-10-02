import { Injectable, inject } from '@angular/core';
import { Subject, Subscription, timer } from 'rxjs';
import { repeat, retry } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { AppConfigService } from './app-config.service';

const RECONNECT_DELAY_MS = 3000;

export type ReliveSocketEvent =
  | { readonly type: 'relive-changed' }
  | { readonly type: 'run-changed'; readonly cycleId: string; readonly runId: string }
  | {
      readonly type: 'run-call';
      readonly runId: string;
      readonly stepKey: string;
      readonly callId: string;
      readonly direction: 'outbound' | 'inbound';
      readonly attribution: string;
      readonly state: string;
      /** The call's own endpoint (T077) - a Guided run has no stepKey for an inbound call until
       *  the frontend matches it by this. */
      readonly method?: string | null;
      readonly url?: string | null;
      /** The call's own duration, once COMPLETED (FR-032). */
      readonly durationMs?: number | null;
      /** Whether the request differed from the recording (proxy's request-differs test, FR-014d). */
      readonly requestChanged?: boolean | null;
      /** On COMPLETED: whether the call really reached the real host (the proxy's own answer). */
      readonly reachedUpstream?: boolean | null;
    };

/**
 * `/ws/relive` (contracts/rest-api.md). Reconnects like `reconnecting-socket.ts` (see that file's
 * doc for why `retry` alone silently deafens a channel on a clean server close), but keeps the
 * underlying `WebSocketSubject` so it can `send()` lease messages - `reconnecting-socket.ts`
 * deliberately narrows its return type to a plain `Observable` and can't.
 */
@Injectable({ providedIn: 'root' })
export class ReliveSocketService {
  private readonly config = inject(AppConfigService);
  readonly events$ = new Subject<ReliveSocketEvent>();

  private socket: WebSocketSubject<ReliveSocketEvent | { type: 'lease' | 'release'; runId: string }> | null = null;
  private subscription: Subscription | null = null;
  private readonly heldLeases = new Set<string>();

  constructor() {
    this.connect();
  }

  private connect(): void {
    const url = `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/relive`;
    this.socket = webSocket<ReliveSocketEvent | { type: 'lease' | 'release'; runId: string }>({
      url,
      openObserver: {
        // Every lease still held is re-sent on every (re)connect (contracts/rest-api.md) -
        // including the first open, unlike reconnecting-socket.ts's onReconnect: a lease taken
        // before the socket existed still needs to reach the very first connection.
        next: () => this.heldLeases.forEach((runId) => this.socket?.next({ type: 'lease', runId })),
      },
    });
    this.subscription = this.socket
      .pipe(
        retry({ delay: () => timer(RECONNECT_DELAY_MS) }),
        repeat({ delay: () => timer(RECONNECT_DELAY_MS) }),
      )
      .subscribe((event) => {
        if (event.type !== 'lease' && event.type !== 'release') {
          this.events$.next(event as ReliveSocketEvent);
        }
      });
  }

  holdLease(runId: string): void {
    this.heldLeases.add(runId);
    this.socket?.next({ type: 'lease', runId });
  }

  /** Tells the backend this tab stopped driving the run. Without it the lease outlived the run,
   *  so closing the tab later re-ended a finished run as INTERRUPTED and resume answered 409. */
  releaseLease(runId: string): void {
    if (!this.heldLeases.delete(runId)) return;
    this.socket?.next({ type: 'release', runId });
  }
}
