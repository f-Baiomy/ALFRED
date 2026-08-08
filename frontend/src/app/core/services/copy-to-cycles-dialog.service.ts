import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';

/** Single source of truth for "is the copy-to-cycles dialog open, for which calls" - mirrors ExportDialogService/ConfirmDialogService's one-instance-at-the-root pattern. The dialog itself owns picking cycles and calling the API, so open() is fire-and-forget rather than returning a Promise. */
@Injectable({ providedIn: 'root' })
export class CopyToCyclesDialogService {
  readonly state = signal<readonly CallRecord[] | null>(null);

  open(calls: readonly CallRecord[]): void {
    this.state.set(calls);
  }

  close(): void {
    this.state.set(null);
  }
}
