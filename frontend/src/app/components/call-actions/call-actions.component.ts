import { Component, computed, inject, input, signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { PinService } from '../../core/services/pin.service';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { buildCurlCommand } from '../../shared/utils/curl-builder';
import { downloadJson } from '../../shared/utils/download';
import { callKey } from '../../shared/utils/call-utils';
import { copyToClipboard } from '../../shared/utils/clipboard';

/**
 * Pin / copy-as-cURL / download-as-JSON / export-report actions for a single call - cURL/JSON/
 * export-report are grouped behind one "Export" menu (ActionMenuComponent) rather than three
 * separate toolbar buttons; Markdown vs. HTML is chosen inside the export dialog itself now, not
 * by which button opened it, so there's only one "Export report..." entry, not two.
 *
 * These actions need the full request/response regardless of whether the card's panels have been
 * expanded (see CallCardComponent) - `call()` may only be a summary, and no-truncation is a hard
 * requirement for every export path - so each one hydrates via CALL_LIST_CONTROLS_STATE's
 * getCallDetail() first, which always makes a real request (no client-side cache), even if this
 * same call was hydrated by an earlier action.
 */
@Component({
  selector: 'app-call-actions',
  standalone: true,
  imports: [ActionMenuComponent],
  templateUrl: './call-actions.component.html',
})
export class CallActionsComponent {
  private readonly pinService = inject(PinService);
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);
  private readonly commentsApi = inject(CommentsApiService);
  private readonly controlsState = inject(CALL_LIST_CONTROLS_STATE);

  readonly call = input.required<CallRecord>();
  readonly curlCopyFeedback = signal(false);
  readonly curlLoading = signal(false);
  readonly exportLoading = signal(false);
  readonly downloadLoading = signal(false);

  readonly isPinned = computed(() => this.pinService.isPinned(this.call()));

  togglePin(): void {
    this.pinService.toggle(this.call());
  }

  copyAsCurl(): void {
    this.curlLoading.set(true);
    this.hydrated(this.call()).subscribe((call) => {
      this.curlLoading.set(false);
      copyToClipboard(buildCurlCommand(call)).then(() => {
        this.curlCopyFeedback.set(true);
        setTimeout(() => this.curlCopyFeedback.set(false), 1200);
      });
    });
  }

  /** The JSON download is meant for reprocessing, so flagged issues ride along as a plain `comments` array rather than inline markers that would make the file invalid JSON. */
  downloadAsJson(): void {
    this.downloadLoading.set(true);
    this.hydrated(this.call())
      .pipe(switchMap((call) => forkJoin({ call: of(call), comments: this.fetchComments(call) })))
      .subscribe(({ call, comments }) => {
        this.downloadLoading.set(false);
        downloadJson({ ...call, comments }, `${callKey(call)}.json`);
      });
  }

  /** Always opens with 'markdown' as the dialog's initial toggle state - the user picks Markdown
   * vs. HTML inside the dialog itself (see ExportDialogComponent.reportFormat), so there's no
   * separate "export as HTML" entry point anymore. */
  openExportReport(): void {
    this.exportLoading.set(true);
    this.hydrated(this.call())
      .pipe(
        switchMap((call) =>
          forkJoin({
            call: of(call),
            metadata: this.exportApi.fetchMetadata(call).pipe(catchError(() => of(null))),
            comments: this.fetchComments(call),
          })
        )
      )
      .subscribe(({ call, metadata, comments }) => {
        this.exportLoading.set(false);
        this.exportDialog.open([call], metadata, new Map([[call.id, comments]]), 'markdown');
      });
  }

  /** Resolves to a fully-hydrated CallRecord (request/response headers+bodies present) - always a real fetch, even if this same call was hydrated by an earlier action, so detail is never served stale. */
  private hydrated(call: CallRecord): Observable<CallRecord> {
    return this.controlsState.getCallDetail(call.id).pipe(map((detail) => ({ ...call, ...detail })));
  }

  private fetchComments(call: CallRecord) {
    return this.commentsApi.listForCall(call.id).pipe(catchError(() => of<Comment[]>([])));
  }
}
