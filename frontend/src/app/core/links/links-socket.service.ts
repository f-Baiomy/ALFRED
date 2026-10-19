import { Injectable, inject } from '@angular/core';
import { Observable, Subject, Subscription, filter, repeat, retry, timer } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { AppConfigService } from '../services/app-config.service';
import { LinksSocketEvent } from './links.models';

const RECONNECT_DELAY_MS = 3000;

type Outgoing = { type: 'viewing'; slug: string; target: string; on: boolean };

/**
 * /ws/links: links, offers, streams and requests changed - and signals from linked Alfreds, so a page showing their data
 * fetches again (no polling). A page also tells the owner what streamed thing it has open (presence, D29); every view
 * still open is said again on each (re)connect. Reconnects like reconnecting-socket.ts, keeping the subject to send.
 */
@Injectable({ providedIn: 'root' })
export class LinksSocketService {
  private readonly config = inject(AppConfigService);
  readonly events$ = new Subject<LinksSocketEvent>();
  /** Fires on every open but the first, so pages catch up. */
  readonly reconnected$ = new Subject<void>();

  private socket: WebSocketSubject<LinksSocketEvent | Outgoing> | null = null;
  private subscription: Subscription | null = null;
  private readonly views = new Map<string, number>();
  private opened = false;

  constructor() {
    this.connect();
  }

  private connect(): void {
    const url = `${this.config.backendUrl.replace(/^http/, 'ws')}/ws/links`;
    this.socket = webSocket<LinksSocketEvent | Outgoing>({
      url,
      openObserver: {
        next: () => {
          for (const key of this.views.keys()) {
            const [slug, target] = key.split('\u0000');
            this.socket?.next({ type: 'viewing', slug, target, on: true });
          }
          if (this.opened) this.reconnected$.next();
          this.opened = true;
        },
      },
    });
    this.subscription = this.socket
      .pipe(
        retry({ delay: () => timer(RECONNECT_DELAY_MS) }),
        repeat({ delay: () => timer(RECONNECT_DELAY_MS) }),
      )
      .subscribe((event) => {
        if ((event as Outgoing).type !== 'viewing') this.events$.next(event as LinksSocketEvent);
      });
  }

  /** Stops reconnecting: links are refused here for good (the tunnel, or a backend without them). */
  stop(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.socket = null;
  }

  /** Signals from one linked Alfred on one channel (session-cycles, board, comments, db-capture, resync, offline). */
  signals(slug: string, channels?: readonly string[]): Observable<LinksSocketEvent & { type: 'signal' }> {
    return this.events$.pipe(
      filter((e): e is LinksSocketEvent & { type: 'signal' } => e.type === 'signal' && e.slug === slug
        && (!channels || channels.includes(e.channel) || e.channel === 'resync')),
    );
  }

  /** This page has a streamed thing open (or closed it): counted per page, sent when it first opens and last closes. */
  viewing(slug: string, target: string, on: boolean): void {
    const key = `${slug}\u0000${target}`;
    const n = (this.views.get(key) ?? 0) + (on ? 1 : -1);
    if (n <= 0) {
      if (!this.views.has(key)) return;
      this.views.delete(key);
      this.socket?.next({ type: 'viewing', slug, target, on: false });
    } else {
      const first = !this.views.has(key);
      this.views.set(key, n);
      if (first) this.socket?.next({ type: 'viewing', slug, target, on: true });
    }
  }
}
