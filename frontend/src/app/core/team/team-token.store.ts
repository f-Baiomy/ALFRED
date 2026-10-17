import { Injectable, signal } from '@angular/core';

/**
 * Each viewer's personal access token per connection (specs/027 R10): kept in this browser only (localStorage), sent
 * with the calls that reach the provider, never stored by Alfred. Storage can be missing or blocked: every read and
 * write is guarded, and the page then just asks for the token again.
 */
@Injectable({ providedIn: 'root' })
export class TeamTokenStore {
  private static readonly PREFIX = 'alfred.team.token.';
  private static readonly WHO = 'alfred.team.who';
  /** Bumped on every change so signals depending on a token re-read. */
  readonly version = signal(0);

  get(conn: string): string | null {
    this.version();
    try {
      return localStorage.getItem(TeamTokenStore.PREFIX + conn) || null;
    } catch {
      return null;
    }
  }

  has(conn: string): boolean {
    return !!this.get(conn);
  }

  set(conn: string, token: string): void {
    try {
      localStorage.setItem(TeamTokenStore.PREFIX + conn, token.trim());
    } catch {
      // private window or blocked storage: the token lives until the page closes, through the request only
    }
    this.version.update((v) => v + 1);
  }

  clear(conn: string): void {
    try {
      localStorage.removeItem(TeamTokenStore.PREFIX + conn);
    } catch {
      // nothing stored
    }
    this.version.update((v) => v + 1);
  }

  /** The name shown as "fetched by" (this browser's choice). */
  who(): string {
    try {
      return localStorage.getItem(TeamTokenStore.WHO) || '';
    } catch {
      return '';
    }
  }

  setWho(name: string): void {
    try {
      localStorage.setItem(TeamTokenStore.WHO, name.trim().slice(0, 80));
    } catch {
      // not remembered
    }
  }
}
