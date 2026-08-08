import { Injectable, signal } from '@angular/core';
import { SessionCycle } from '../models/call.model';

export interface EditCycleResult {
  readonly name: string;
  readonly assignedTo: string | null;
}

/** Single source of truth for "is the edit-cycle dialog open, for which cycle" - mirrors ExportDialogService/ConfirmDialogService's one-instance-at-the-root pattern. Replaces the previous window.prompt()-based rename, and adds an assignedTo field that had no edit UI at all before. */
@Injectable({ providedIn: 'root' })
export class EditCycleDialogService {
  readonly state = signal<SessionCycle | null>(null);

  private resolve: ((result: EditCycleResult | null) => void) | null = null;

  open(cycle: SessionCycle): Promise<EditCycleResult | null> {
    this.state.set(cycle);
    return new Promise<EditCycleResult | null>((resolve) => {
      this.resolve = resolve;
    });
  }

  submit(result: EditCycleResult): void {
    this.resolve?.(result);
    this.resolve = null;
    this.state.set(null);
  }

  cancel(): void {
    this.resolve?.(null);
    this.resolve = null;
    this.state.set(null);
  }
}
