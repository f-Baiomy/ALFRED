import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';

export type ReliveSelectionMode = 'ADD' | 'REPLACE';

export interface ReliveSelectionRequest {
  readonly calls: readonly CallRecord[];
  readonly mode: ReliveSelectionMode;
}

/** "Add to cycle…" / "Replace steps of cycle…" (T071, mock.html `reliveAction('add'|'replace')`) -
 *  single source of truth for "is the Relive cycle-picker dialog open, for which calls, in which
 *  mode" - mirrors CopyToCyclesDialogService's own one-instance-at-the-root pattern. */
@Injectable({ providedIn: 'root' })
export class ReliveSelectionDialogService {
  readonly state = signal<ReliveSelectionRequest | null>(null);

  open(calls: readonly CallRecord[], mode: ReliveSelectionMode): void {
    this.state.set({ calls, mode });
  }

  close(): void {
    this.state.set(null);
  }
}
