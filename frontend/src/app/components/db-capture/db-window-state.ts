import { Injectable, computed, signal } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CapturedStatement } from '../../core/models/db-capture.model';
import { isDelete, isFailed, isTxEnd, isWrite, valueText } from '../../shared/utils/db-statement-display';

export type DbKindFilter = 'all' | 'read' | 'write' | 'delete' | 'fail';
export type DbDetailTab = 'error' | 'deleted' | 'sql' | 'params' | 'rows' | 'keys' | 'before' | 'where';

/**
 * One open database window's view state - shared by the window and the rows, groups and details inside it (provided
 * by DbWindowComponent, so each window has its own). Statement keys are their `seq` within the call.
 */
@Injectable()
export class DbWindowState {
  readonly search = signal('');
  readonly kind = signal<DbKindFilter>('all');
  readonly table = signal('');
  readonly fill = signal(true);
  readonly showSuppliers = signal(true);
  readonly open = signal<ReadonlySet<number>>(new Set());
  readonly folded = signal<ReadonlySet<string>>(new Set());
  readonly tabs = signal<ReadonlyMap<number, DbDetailTab>>(new Map());
  /** A value clicked to trace - every cell and parameter equal to it is highlighted. */
  readonly trace = signal('');
  /** The statement just jumped to - flashes once. */
  readonly flashSeq = signal<number | null>(null);
  /** The call's outbound (supplier) calls the page has loaded, by their place in the call's sequence. */
  readonly suppliersBySeq = signal<ReadonlyMap<number, CallRecord>>(new Map());

  readonly filtering = computed(() => !!this.search() || this.kind() !== 'all' || !!this.table());

  toggleOpen(seq: number): void {
    const next = new Set(this.open());
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    this.open.set(next);
  }

  toggleFold(key: string): void {
    const next = new Set(this.folded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.folded.set(next);
  }

  setTab(seq: number, tab: DbDetailTab): void {
    this.tabs.set(new Map(this.tabs()).set(seq, tab));
  }

  toggleTrace(value: string | null | undefined): void {
    if (value == null) return;
    this.trace.set(this.trace() === value ? '' : value);
  }

  matches(s: CapturedStatement): boolean {
    switch (this.kind()) {
      case 'read':
        if (isWrite(s) || isTxEnd(s)) return false;
        break;
      case 'write':
        if (!isWrite(s)) return false;
        break;
      case 'delete':
        if (!isDelete(s)) return false;
        break;
      case 'fail':
        if (!(isFailed(s) || s.undone || s.kind === 'ROLLBACK')) return false;
        break;
    }
    const table = this.table();
    if (table && (s.table ?? '').toLowerCase() !== table.toLowerCase()) return false;
    const q = this.search().toLowerCase();
    if (!q) return true;
    const text = `${s.sql} ${s.table ?? ''} ${s.params.flat().map(valueText).join(' ')}`.toLowerCase();
    return text.includes(q);
  }
}
