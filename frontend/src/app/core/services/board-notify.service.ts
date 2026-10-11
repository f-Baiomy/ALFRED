import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { BoardApiService } from './board-api.service';
import { BoardSocketService } from './board-socket.service';

const KEY = 'alfred.board.notify';

/**
 * Desktop notifications when Claude asks a question or proposes something (specs/015 FR-10) - while an Alfred tab is
 * open. Off until the user turns it on (the browser asks permission then, never on load). Woken by the /ws/board signal;
 * reads only Claude's new entries after its cursor, so nothing polls and nothing is announced twice.
 */
@Injectable({ providedIn: 'root' })
export class BoardNotifyService {
  private readonly api = inject(BoardApiService);
  private readonly socket = inject(BoardSocketService);
  private readonly router = inject(Router);

  /** The browser can notify at all. */
  readonly supported = typeof window !== 'undefined' && 'Notification' in window;
  readonly enabled = signal(this.supported && stored() && Notification.permission === 'granted');
  private cursor: string | null = null;
  private sub: Subscription | null = null;

  constructor() {
    if (this.enabled()) this.start();
  }

  /** From a button: asks the browser once, then listens. */
  async enable(): Promise<boolean> {
    if (!this.supported) return false;
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    const on = permission === 'granted';
    store(on);
    this.enabled.set(on);
    if (on) this.start();
    return on;
  }

  disable(): void {
    store(false);
    this.enabled.set(false);
    this.sub?.unsubscribe();
    this.sub = null;
  }

  /** A desktop notification of the board's own (a new build ready to re-test, specs/016), when notifications are on. */
  notifyText(title: string, body: string, tag: string): void {
    if (!this.enabled()) return;
    try {
      const n = new Notification(title, { body, tag });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // a browser that refuses page notifications (some mobiles) shows none
    }
  }

  private start(): void {
    if (this.sub) return;
    this.api.changes('now').subscribe({ next: (c) => (this.cursor = c.cursor), error: () => undefined });
    this.sub = this.socket.events$.pipe(filter((e) => e.type === 'board-changed' && (e.what === 'card' || e.what === 'activity')))
      .subscribe(() => this.check());
  }

  private check(): void {
    if (!this.cursor || !this.enabled()) return;
    this.api.changes(this.cursor, 'CLAUDE').subscribe({
      next: (page) => {
        this.cursor = page.cursor;
        for (const e of page.entries) {
          const question = e.kind === 'COMMENT' && !!e.text?.startsWith('**Question**');
          if (!question && e.kind !== 'PROPOSED') continue;
          const body = question ? (e.text ?? '').replace(/^\*\*Question\*\*\s*/, '') : `Proposes ${e.newValue ?? ''}`;
          const n = new Notification(`Alfred · Claude ${question ? 'asked a question' : 'proposes a step'}`,
            { body: `#${e.number} ${e.title}: ${body.slice(0, 180)}`, tag: `alfred-${e.cardId}` });
          n.onclick = () => {
            window.focus();
            void this.router.navigate(['/board'], { queryParams: { project: e.project || null, card: e.number } });
            n.close();
          };
        }
      },
      error: () => undefined,
    });
  }
}

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

function store(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // blocked storage: it lasts this page only
  }
}
