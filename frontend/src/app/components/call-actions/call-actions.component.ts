import { Component, WritableSignal, computed, inject, input, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { PinService } from '../../core/services/pin.service';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { buildCurlCommand } from '../../shared/utils/curl-builder';
import { downloadJson } from '../../shared/utils/download';
import { callKey } from '../../shared/utils/call-utils';

/** Pin / copy-as-cURL / download-as-JSON / export-as-Markdown actions for a single call. */
@Component({
  selector: 'app-call-actions',
  standalone: true,
  templateUrl: './call-actions.component.html',
})
export class CallActionsComponent {
  private readonly pinService = inject(PinService);
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);
  private readonly commentsApi = inject(CommentsApiService);

  readonly call = input.required<CallRecord>();
  readonly curlCopyFeedback = signal(false);
  readonly exportLoading = signal(false);
  readonly htmlExportLoading = signal(false);
  readonly downloadLoading = signal(false);

  readonly isPinned = computed(() => this.pinService.isPinned(this.call()));

  togglePin(): void {
    this.pinService.toggle(this.call());
  }

  copyAsCurl(): void {
    navigator.clipboard.writeText(buildCurlCommand(this.call())).then(() => {
      this.curlCopyFeedback.set(true);
      setTimeout(() => this.curlCopyFeedback.set(false), 1200);
    });
  }

  /** The JSON download is meant for reprocessing, so flagged issues ride along as a plain `comments` array rather than inline markers that would make the file invalid JSON. */
  downloadAsJson(): void {
    const call = this.call();
    this.downloadLoading.set(true);
    this.fetchComments(call).subscribe((comments) => {
      this.downloadLoading.set(false);
      downloadJson({ ...call, comments }, `${callKey(call)}.json`);
    });
  }

  exportAsMarkdown(): void {
    this.openExportDialog(this.exportLoading, 'markdown');
  }

  exportAsHtml(): void {
    this.openExportDialog(this.htmlExportLoading, 'html');
  }

  private openExportDialog(loading: WritableSignal<boolean>, format: 'markdown' | 'html'): void {
    const call = this.call();
    loading.set(true);
    forkJoin({
      metadata: this.exportApi.fetchMetadata(call).pipe(catchError(() => of(null))),
      comments: this.fetchComments(call),
    }).subscribe(({ metadata, comments }) => {
      loading.set(false);
      this.exportDialog.open([call], metadata, new Map([[callKey(call), comments]]), format);
    });
  }

  private fetchComments(call: CallRecord) {
    return this.commentsApi.listForCall(callKey(call)).pipe(catchError(() => of<Comment[]>([])));
  }
}
