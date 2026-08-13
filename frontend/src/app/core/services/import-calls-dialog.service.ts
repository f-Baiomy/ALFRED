import { Injectable, signal } from '@angular/core';

export interface ImportCallsDialogState {
  /** Set when opened from a specific cycle's detail page - that cycle is pre-checked in the picker, though the user can still add more. Null when opened from the Session Cycles list (nothing pre-checked). */
  readonly preselectedCycleId: string | null;
}

/** Single source of truth for "is the import-calls dialog open" - mirrors CopyToCyclesDialogService/ExportDialogService's one-instance-at-the-root pattern. The dialog itself owns file parsing, cycle picking, and calling the API. */
@Injectable({ providedIn: 'root' })
export class ImportCallsDialogService {
  readonly state = signal<ImportCallsDialogState | null>(null);

  open(preselectedCycleId?: string): void {
    this.state.set({ preselectedCycleId: preselectedCycleId ?? null });
  }

  close(): void {
    this.state.set(null);
  }
}
