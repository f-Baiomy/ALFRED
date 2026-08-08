import { Injectable, signal } from '@angular/core';

export interface BulkReassignDialogState {
  readonly count: number;
}

/**
 * Single source of truth for "is the bulk-reassign dialog open, for how many cycles" - mirrors
 * EditCycleDialogService/ConfirmDialogService's Promise-based one-instance-at-the-root pattern.
 * One assignedTo value is applied to every selected cycle at once.
 *
 * `open()` resolves `undefined` on cancel and `string | null` on submit (`null` meaning the
 * field was left blank - clears assignedTo on every selected cycle) - these must stay distinct,
 * since "cancelled" and "intentionally cleared" require different handling by the caller.
 */
@Injectable({ providedIn: 'root' })
export class BulkReassignDialogService {
  readonly state = signal<BulkReassignDialogState | null>(null);

  private resolve: ((assignedTo: string | null | undefined) => void) | null = null;

  open(count: number): Promise<string | null | undefined> {
    this.state.set({ count });
    return new Promise<string | null | undefined>((resolve) => {
      this.resolve = resolve;
    });
  }

  submit(assignedTo: string | null): void {
    this.resolve?.(assignedTo);
    this.resolve = null;
    this.state.set(null);
  }

  cancel(): void {
    this.resolve?.(undefined);
    this.resolve = null;
    this.state.set(null);
  }
}
