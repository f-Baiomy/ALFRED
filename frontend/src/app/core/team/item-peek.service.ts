import { Injectable, inject, signal } from '@angular/core';
import { Observable, map, of, shareReplay, catchError } from 'rxjs';
import { TeamApiService } from './team-api.service';
import { TeamStateService } from './team-state.service';

/**
 * A work item opened where the user is (a chip on the board, the chat, a card): the same drawer as the Team tab, drawn
 * over the page by `TeamItemPeekHostComponent` - nothing navigates away.
 */
@Injectable({ providedIn: 'root' })
export class TeamItemPeekService {
  private readonly api = inject(TeamApiService);
  private readonly state = inject(TeamStateService);
  readonly opened = signal<{ conn: string; item: string } | null>(null);
  private firstConn$: Observable<string | null> | null = null;

  /** Opens an item; `*` is the Azure connection (an `AB#n` written in text names none). */
  open(conn: string, item: string): void {
    if (!this.state.loaded()) this.state.load();
    this.connOf(conn).subscribe((c) => { if (c) this.opened.set({ conn: c, item }); });
  }

  close(): void {
    this.opened.set(null);
  }

  /** The connection a ref means: itself, or for `*` the one picked on the Team tab, else the first one. */
  connOf(conn: string): Observable<string | null> {
    if (conn !== '*') return of(conn);
    const picked = this.state.picked()?.id;
    if (picked) return of(picked);
    this.firstConn$ ??= this.api.connections().pipe(map((c) => c[0]?.id ?? null), catchError(() => of(null)), shareReplay(1));
    return this.firstConn$;
  }
}
