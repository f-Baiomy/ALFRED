import { Injectable, signal } from '@angular/core';
import { CallOverlapCandidate, CallRecord } from '../models/call.model';
import { ExportMetadata } from '../models/export-metadata.model';
import { Comment } from '../models/comment.model';
import { CallStatusFilter } from '../../shared/utils/call-utils';

export type ExportFormat = 'markdown' | 'json' | 'html' | 'postman';

export interface ExportDialogState {
  readonly calls: readonly CallRecord[];
  readonly metadata: ExportMetadata | null;
  readonly commentsByCallId: ReadonlyMap<string, readonly Comment[]>;
  readonly format: ExportFormat;
  /**
   * Overlap candidates already fetched (by whichever caller opened the dialog - see
   * BulkActionsBarComponent/CallActionsComponent) for the full time range spanned by `calls`, under
   * the filters active at export time - passed straight through to the bulk export builders'
   * containment check (see markdown-builder.ts/html-builder.ts's isSplitInternalCall,
   * bulk-json-builder.ts's eventsForCall). Empty when the opener didn't need to fetch any (e.g. a
   * single-call Markdown/HTML export, which never splits regardless).
   */
  readonly overlapCandidates: readonly CallOverlapCandidate[];
  /** The status-pill filter active at export time - applied to `overlapCandidates` the same way the live list applies it (see call-utils.ts's candidateMatchesStatusFilter). */
  readonly statusFilter: CallStatusFilter;
}

/** Single source of truth for "is the export dialog open, and for which call(s)" - one dialog instance at the app root reads this instead of every call needing its own dialog. Works for a single call (length-1 `calls`) or a bulk selection alike. */
@Injectable({ providedIn: 'root' })
export class ExportDialogService {
  readonly state = signal<ExportDialogState | null>(null);

  open(
    calls: readonly CallRecord[],
    metadata: ExportMetadata | null,
    commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
    format: ExportFormat = 'markdown',
    overlapCandidates: readonly CallOverlapCandidate[] = [],
    statusFilter: CallStatusFilter = 'all'
  ): void {
    this.state.set({ calls, metadata, commentsByCallId, format, overlapCandidates, statusFilter });
  }

  close(): void {
    this.state.set(null);
  }
}
