import { Component, WritableSignal, inject, signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { BULK_SELECTION_STATE, CALL_LIST_CONTROLS_STATE, CALL_REMOVAL_STATE } from '../../core/state/call-selection.tokens';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
import { draftFrom } from '../../shared/utils/resend-draft';
import { CALL_ORIGIN } from '../../core/state/call-origin.token';
import { CopyToCyclesDialogService } from '../../core/services/copy-to-cycles-dialog.service';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { buildBulkCurlScript, bulkCurlFilename } from '../../shared/utils/curl-builder';
import { downloadText } from '../../shared/utils/download';

/**
 * Sticky bar always present above the list so "Select all" is reachable
 * even before anything is selected; it grows to show export actions once
 * `selectedCalls().length > 0`. Every export action (report/JSON/Postman/cURL) is
 * grouped behind one "Export" menu (ActionMenuComponent) rather than one
 * toolbar button per format. Markdown/JSON/Postman export all go through the
 * (now-generalized) export dialog so the user can review/edit metadata
 * first - pre-filled from the FIRST selected call in current list order,
 * same rule the user asked for; Markdown vs. HTML is chosen inside that
 * dialog now, not by which menu item opened it. cURL export skips the
 * dialog entirely since it's a replay script, not a report: metadata is
 * only used for a header comment, not a form the user needs to see.
 *
 * A selected call may only be a summary (see CallRecord's doc comment) if it was never expanded -
 * every path here hydrates the full selection first (a burst of GET .../detail requests, one per
 * not-yet-cached call, run concurrently), since no-truncation is a hard requirement for every
 * export path and "duplicate to cycles" needs the complete CallRecord to store server-side.
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
  private readonly bulkResend = inject(BulkResendDialogService);
  private readonly copyToCyclesDialog = inject(CopyToCyclesDialogService);
  private readonly commentsApi = inject(CommentsApiService);
  private readonly controlsState = inject(CALL_LIST_CONTROLS_STATE);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly origin = inject(CALL_ORIGIN, { optional: true });
  readonly state = inject(BULK_SELECTION_STATE);
  /** Non-null only where something binds CALL_REMOVAL_STATE (a session-cycle detail view) - drives whether "Remove selected" renders at all, same optional-injection shape CallCardComponent uses for its own per-call "Remove". */
  readonly removalState = inject(CALL_REMOVAL_STATE, { optional: true });

  readonly curlLoading = signal(false);
  readonly mdLoading = signal(false);
  readonly jsonLoading = signal(false);
  readonly postmanLoading = signal(false);
  readonly duplicateLoading = signal(false);
  readonly resendLoading = signal(false);

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

  exportAsPostman(): void {
    this.openDialog(this.postmanLoading, 'postman');
  }

  exportAsCurl(): void {
    const selected = this.state.selectedCalls();
    if (selected.length === 0) return;
    this.curlLoading.set(true);
    this.hydrateAll(selected)
      .pipe(switchMap((calls) => forkJoin({ calls: of(calls), metadata: this.exportApi.fetchMetadata(calls[0]).pipe(catchError(() => of(null))) })))
      .subscribe(({ calls, metadata }) => {
        this.curlLoading.set(false);
        const script = buildBulkCurlScript(calls, new Date().toISOString(), {
          supplierName: metadata?.supplierName,
          credentialsUsed: metadata?.credentialsUsed,
        });
        downloadText(script, bulkCurlFilename(calls), 'text/x-sh');
      });
  }

  duplicateToCycles(): void {
    const selected = this.state.selectedCalls();
    if (selected.length === 0) return;
    this.duplicateLoading.set(true);
    this.hydrateAll(selected).subscribe((calls) => {
      this.duplicateLoading.set(false);
      this.copyToCyclesDialog.open(calls);
    });
  }

  /**
   * Opens the multi-call resend editor on the selection, in display order, every call hydrated so
   * it can be edited - nothing is sent until the user presses Resend there (see
   * BulkResendDialogService for the one-at-a-time send and stop-at-first-failure switch).
   */
  resendSelected(): void {
    const selected = this.state.selectedCalls();
    if (selected.length === 0 || this.resendLoading()) return;
    this.resendLoading.set(true);
    const cycleId = this.origin?.cycleId() ?? null;
    this.hydrateAll(selected).subscribe({
      next: (calls) => {
        this.resendLoading.set(false);
        this.bulkResend.start(calls.map((call) => draftFrom(call, cycleId)));
      },
      error: () => this.resendLoading.set(false),
    });
  }

  async removeSelected(): Promise<void> {
    const selected = this.state.selectedCalls();
    if (!this.removalState || selected.length === 0) return;
    const confirmed = await this.confirmDialog.confirm(
      `Remove ${selected.length} selected call${selected.length === 1 ? '' : 's'} from this cycle?`,
      'Remove'
    );
    if (!confirmed) return;
    this.removalState.removeMany(selected);
  }

  /**
   * `format === 'markdown'`/`'html'` only actually split a call when `calls.length > 1` (the
   * single-call branch in export-dialog.component.ts's buildContent never splits), and `'postman'`
   * never splits at all - but `'json'` always routes through buildBulkExportPayload/eventsForCall
   * regardless of selection size, so the overlap fetch runs unconditionally here rather than only
   * for a multi-call selection; the extra request is cheap and harmless when its result goes
   * unused (buildBulkExportMarkdown/buildBulkExportHtml/buildBulkExportPayload all default this
   * parameter to `[]` too, for any caller that skips fetching entirely).
   */
  private openDialog(loading: WritableSignal<boolean>, format: 'markdown' | 'json' | 'html' | 'postman'): void {
    const selected = this.state.selectedCalls();
    if (selected.length === 0) return;
    loading.set(true);
    this.hydrateAll(selected)
      .pipe(
        switchMap((calls) =>
          forkJoin({
            calls: of(calls),
            metadata: this.exportApi.fetchMetadata(calls[0]).pipe(catchError(() => of(null))),
            commentsByCallId: this.fetchAllComments(calls),
            overlapCandidates: this.fetchOverlapsFor(calls),
          })
        )
      )
      .subscribe(({ calls, metadata, commentsByCallId, overlapCandidates }) => {
        loading.set(false);
        this.exportDialog.open(calls, metadata, commentsByCallId, format, overlapCandidates, this.controlsState.statusFilter());
      });
  }

  /**
   * Fetches every overlap candidate for the full time range spanned by `calls` (each call's own
   * timestamp through timestamp + duration_ms), under whatever filters are active on the list
   * right now - the same query the live list's own `overlapCandidates` signal would run for this
   * range, but for the export's specific selection rather than whatever's currently loaded/visible
   * on screen (point 8 of the containment-rule spec: exports query the backend for full accuracy,
   * not just what's in this particular export). Resolves to `[]` (never splits) when there's
   * nothing to export or the fetch fails - a failed prefetch must not block the export itself.
   */
  private fetchOverlapsFor(calls: readonly CallRecord[]): Observable<readonly CallOverlapCandidate[]> {
    if (calls.length === 0) return of([]);
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const call of calls) {
      const start = new Date(call.timestamp).getTime();
      if (Number.isNaN(start)) continue;
      const end = start + (call.duration_ms ?? 0);
      if (start < minStart) minStart = start;
      if (end > maxEnd) maxEnd = end;
    }
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return of([]);
    return this.controlsState
      .getCallOverlaps({ from: new Date(minStart).toISOString(), to: new Date(maxEnd).toISOString() })
      .pipe(catchError(() => of([])));
  }

  /** Always a real fetch per call, even if it was hydrated by an earlier bulk action this session - detail is never served from a cache. */
  private hydrateAll(calls: readonly CallRecord[]): Observable<CallRecord[]> {
    const requests = calls.map((call) => this.controlsState.getCallDetail(call.id, call.source).pipe(map((detail) => ({ ...call, ...detail }))));
    return forkJoin(requests);
  }

  private fetchAllComments(calls: readonly CallRecord[]): Observable<ReadonlyMap<string, readonly Comment[]>> {
    const perCall = calls.map((call) =>
      this.commentsApi.listForCall(call.id).pipe(catchError(() => of<Comment[]>([])))
    );
    return forkJoin(perCall).pipe(
      map((results) => new Map(calls.map((call, i) => [call.id, results[i]] as const)))
    );
  }
}
