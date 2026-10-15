import { Injectable, signal } from '@angular/core';

export interface ConfirmDialogState {
  readonly message: string;
  readonly confirmLabel: string;
  /** The other choice's label. Both are real answers when the question is not "are you sure". */
  readonly cancelLabel?: string;
  /** A choice to make with the answer (radio buttons), and which one is picked. */
  readonly choices?: readonly ConfirmChoice[];
  readonly chosen?: string;
}

export interface ConfirmChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
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

  confirm(message: string, confirmLabel = 'Delete', cancelLabel?: string): Promise<boolean> {
    this.state.set({ message, confirmLabel, cancelLabel });
    return new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Asks with a choice: the value picked when confirmed, null when cancelled. */
  async choose(message: string, choices: readonly ConfirmChoice[], chosen: string, confirmLabel = 'Delete', cancelLabel?: string): Promise<string | null> {
    this.state.set({ message, confirmLabel, choices, chosen, ...(cancelLabel ? { cancelLabel } : {}) });
    const confirmed = await new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
    return confirmed ? this.lastChosen : null;
  }

  private lastChosen: string | null = null;

  pick(value: string): void {
    const s = this.state();
    if (s) this.state.set({ ...s, chosen: value });
  }

  respond(confirmed: boolean): void {
    this.lastChosen = this.state()?.chosen ?? null;
    this.resolve?.(confirmed);
    this.resolve = null;
    this.state.set(null);
  }
}
