import { Injectable, signal } from '@angular/core';
import { CallRecord } from '../models/call.model';
import { ExportMetadata } from '../models/export-metadata.model';
import { Comment } from '../models/comment.model';

export type ExportFormat = 'markdown' | 'json' | 'html';

export interface ExportDialogState {
  readonly calls: readonly CallRecord[];
  readonly metadata: ExportMetadata | null;
  readonly commentsByCallId: ReadonlyMap<string, readonly Comment[]>;
  readonly format: ExportFormat;
}

/** Single source of truth for "is the export dialog open, and for which call(s)" - one dialog instance at the app root reads this instead of every call needing its own dialog. Works for a single call (length-1 `calls`) or a bulk selection alike. */
@Injectable({ providedIn: 'root' })
export class ExportDialogService {
  readonly state = signal<ExportDialogState | null>(null);

  open(
    calls: readonly CallRecord[],
    metadata: ExportMetadata | null,
    commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
    format: ExportFormat = 'markdown'
  ): void {
    this.state.set({ calls, metadata, commentsByCallId, format });
  }

  close(): void {
    this.state.set(null);
  }
}
