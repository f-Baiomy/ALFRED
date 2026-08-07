import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';
import { ExportMetadata } from '../models/export-metadata.model';

export interface ExportDialogState {
  readonly call: CallRecord;
  readonly metadata: ExportMetadata | null;
}

/** Single source of truth for "is the export dialog open, and for which call" - one dialog instance at the app root reads this instead of every call needing its own dialog. */
@Injectable({ providedIn: 'root' })
export class ExportDialogService {
  readonly state = signal<ExportDialogState | null>(null);

  open(call: CallRecord, metadata: ExportMetadata | null): void {
    this.state.set({ call, metadata });
  }

  close(): void {
    this.state.set(null);
  }
}
