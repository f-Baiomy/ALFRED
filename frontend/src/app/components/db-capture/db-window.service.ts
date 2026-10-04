import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';

/** What the database window shows: one inbound call's statements, or the statements that ran outside any call. */
export type DbWindowRequest =
  | { readonly kind: 'call'; readonly call: CallRecord; readonly view?: 'stmts' | 'tables' }
  | { readonly kind: 'outside'; readonly project?: string | null };

/**
 * Opens the one database window (rendered once, by DbWindowHostComponent in the app shell), from a ◆ DB chip on any
 * call card - Live Calls, Session Cycles, Relive - without each page hosting its own copy.
 */
@Injectable({ providedIn: 'root' })
export class DbWindowService {
  private readonly requestSignal = signal<DbWindowRequest | null>(null);
  readonly request = this.requestSignal.asReadonly();

  openCall(call: CallRecord, view: 'stmts' | 'tables' = 'stmts'): void {
    this.requestSignal.set({ kind: 'call', call, view });
  }

  openOutside(project?: string | null): void {
    this.requestSignal.set({ kind: 'outside', project });
  }

  close(): void {
    this.requestSignal.set(null);
  }
}
