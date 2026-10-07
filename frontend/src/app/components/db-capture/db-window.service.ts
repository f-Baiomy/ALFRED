import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';

/** The window's views; Logs and Together are the call's linked log lines (specs/008-logs-call-link), Redis and Keys its
 *  Redis commands (specs/011-redis-capture). */
export type DbWindowView = 'stmts' | 'queries' | 'tables' | 'logs' | 'together' | 'redis' | 'keys';

/** What the database window shows: one inbound call's statements, or the statements that ran outside any call. */
export type DbWindowRequest =
  | { readonly kind: 'call'; readonly call: CallRecord; readonly view?: DbWindowView; readonly cycleId?: string | null }
  | { readonly kind: 'outside'; readonly project?: string | null };

/**
 * Opens the one database window (rendered once, by DbWindowHostComponent in the app shell), from a ◆ DB chip on any
 * call card - Live Calls, Session Cycles, Relive - without each page hosting its own copy.
 */
@Injectable({ providedIn: 'root' })
export class DbWindowService {
  private readonly requestSignal = signal<DbWindowRequest | null>(null);
  readonly request = this.requestSignal.asReadonly();
  /**
   * Set while the window is put aside to show a supplier call in the list ("show call ↗"): it stays alive - scroll,
   * open rows, tab, switches - and a "Back to database" button brings it back exactly as it was.
   */
  private readonly asideSignal = signal<{ readonly label: string } | null>(null);
  readonly aside = this.asideSignal.asReadonly();

  openCall(call: CallRecord, view: DbWindowView = 'stmts', cycleId: string | null = null): void {
    this.asideSignal.set(null);
    this.requestSignal.set({ kind: 'call', call, view, cycleId });
  }

  openOutside(project?: string | null): void {
    this.asideSignal.set(null);
    this.requestSignal.set({ kind: 'outside', project });
  }

  putAside(label: string): void {
    if (this.requestSignal()) this.asideSignal.set({ label });
  }

  back(): void {
    this.asideSignal.set(null);
  }

  close(): void {
    this.asideSignal.set(null);
    this.requestSignal.set(null);
  }
}
