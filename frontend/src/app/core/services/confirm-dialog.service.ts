import { Injectable, signal } from '@angular/core';

export interface ConfirmDialogState {
  readonly message: string;
  readonly confirmLabel: string;
}

/**
 * Single source of truth for "is the confirm dialog open, with what message" - mirrors
 * ExportDialogService's one-instance-at-the-root pattern. Replaces window.confirm() with a
 * styled in-app modal; callers await confirm() instead of getting a synchronous boolean back.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  readonly state = signal<ConfirmDialogState | null>(null);

  private resolve: ((confirmed: boolean) => void) | null = null;

  confirm(message: string, confirmLabel = 'Delete'): Promise<boolean> {
    this.state.set({ message, confirmLabel });
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  respond(confirmed: boolean): void {
    this.resolve?.(confirmed);
    this.resolve = null;
    this.state.set(null);
  }
}
