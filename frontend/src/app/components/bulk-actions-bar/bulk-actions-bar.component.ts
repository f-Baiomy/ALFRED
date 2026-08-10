import { Component, WritableSignal, inject, signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { BULK_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { CopyToCyclesDialogService } from '../../core/services/copy-to-cycles-dialog.service';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { buildBulkCurlScript, bulkCurlFilename } from '../../shared/utils/curl-builder';
import { downloadText } from '../../shared/utils/download';
import { callKey } from '../../shared/utils/call-utils';

/**
 * Sticky bar always present above the list so "Select all" is reachable
 * even before anything is selected; it grows to show export actions once
 * `selectedCalls().length > 0`. Every export action (report/JSON/cURL) is
 * grouped behind one "Export" menu (ActionMenuComponent) rather than one
 * toolbar button per format. Markdown/JSON export both go through the
 * (now-generalized) export dialog so the user can review/edit metadata
 * first - pre-filled from the FIRST selected call in current list order,
 * same rule the user asked for; Markdown vs. HTML is chosen inside that
 * dialog now, not by which menu item opened it. cURL export skips the
 * dialog entirely since it's a replay script, not a report: metadata is
 * only used for a header comment, not a form the user needs to see.
 */
@Component({
  selector: 'app-bulk-actions-bar',
  standalone: true,
  imports: [ActionMenuComponent],
  templateUrl: './bulk-actions-bar.component.html',
})
export class BulkActionsBarComponent {
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);
  private readonly copyToCyclesDialog = inject(CopyToCyclesDialogService);
  private readonly commentsApi = inject(CommentsApiService);
  readonly state = inject(BULK_SELECTION_STATE);

  readonly curlLoading = signal(false);
  readonly mdLoading = signal(false);
  readonly jsonLoading = signal(false);

  selectAll(): void {
    this.state.selectAll();
  }

  clearSelection(): void {
    this.state.clearSelection();
  }

  /** Always opens with 'markdown' as the dialog's initial toggle state - see
   * CallActionsComponent.openExportReport for why there's no separate "as HTML" entry. */
  exportReport(): void {
    this.openDialog(this.mdLoading, 'markdown');
  }

  exportAsJson(): void {
    this.openDialog(this.jsonLoading, 'json');
  }

  exportAsCurl(): void {
    const calls = this.state.selectedCalls();
    if (calls.length === 0) return;
    this.curlLoading.set(true);
    this.exportApi.fetchMetadata(calls[0]).pipe(catchError(() => of(null))).subscribe((metadata) => {
      this.curlLoading.set(false);
      const script = buildBulkCurlScript(calls, new Date().toISOString(), {
        supplierName: metadata?.supplierName,
        credentialsUsed: metadata?.credentialsUsed,
      });
      downloadText(script, bulkCurlFilename(calls), 'text/x-sh');
    });
  }

  duplicateToCycles(): void {
    const calls = this.state.selectedCalls();
    if (calls.length === 0) return;
    this.copyToCyclesDialog.open(calls);
  }

  private openDialog(loading: WritableSignal<boolean>, format: 'markdown' | 'json' | 'html'): void {
    const calls = this.state.selectedCalls();
    if (calls.length === 0) return;
    loading.set(true);
    forkJoin({
      metadata: this.exportApi.fetchMetadata(calls[0]).pipe(catchError(() => of(null))),
      commentsByCallId: this.fetchAllComments(calls),
    }).subscribe(({ metadata, commentsByCallId }) => {
      loading.set(false);
      this.exportDialog.open(calls, metadata, commentsByCallId, format);
    });
  }

  private fetchAllComments(calls: readonly CallRecord[]): Observable<ReadonlyMap<string, readonly Comment[]>> {
    const perCall = calls.map((call) =>
      this.commentsApi.listForCall(callKey(call)).pipe(catchError(() => of<Comment[]>([])))
    );
    return forkJoin(perCall).pipe(
      map((results) => new Map(calls.map((call, i) => [callKey(call), results[i]] as const)))
    );
  }
}
