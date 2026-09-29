import { Component, computed, inject, input, signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { PinService } from '../../core/services/pin.service';
import { ExportApiService } from '../../core/services/export-api.service';
import { ExportDialogService } from '../../core/services/export-dialog.service';
import { Router } from '@angular/router';
import { ResendDialogService } from '../../core/services/resend-dialog.service';
import { RuleDraftService } from '../../core/services/rule-draft.service';
import { CommentsApiService } from '../../core/services/comments-api.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { interceptionBodiesLoaded } from '../../core/models/interception.model';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { ReliveQuickActionsService } from '../../core/services/relive-quick-actions.service';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { PickCallButtonComponent } from '../pick-call-button/pick-call-button.component';
import { CALL_ORIGIN } from '../../core/state/call-origin.token';
import { buildCurlCommand } from '../../shared/utils/curl-builder';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { redactCall } from '../../shared/utils/redact';
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
  imports: [ActionMenuComponent, PickCallButtonComponent],
  templateUrl: './call-actions.component.html',
})
export class CallActionsComponent {
  private readonly pinService = inject(PinService);
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);
  private readonly resendDialog = inject(ResendDialogService);
  private readonly commentsApi = inject(CommentsApiService);
  private readonly redactions = inject(RedactionsStore);
  private readonly controlsState = inject(CALL_LIST_CONTROLS_STATE);
  private readonly callsApi = inject(CallsApiService);
  private readonly ruleDraft = inject(RuleDraftService);
  private readonly router = inject(Router);
  private readonly origin = inject(CALL_ORIGIN, { optional: true });
  private readonly reliveActions = inject(ReliveQuickActionsService);

  readonly call = input.required<CallRecord>();
  readonly curlCopyFeedback = signal(false);
  readonly curlLoading = signal(false);
  readonly exportLoading = signal(false);
  readonly downloadLoading = signal(false);
  readonly resendLoading = signal(false);
  readonly reliveLoading = signal(false);
  readonly reliveError = signal<string | null>(null);

  readonly isPinned = computed(() => this.pinService.isPinned(this.call()));

  togglePin(): void {
    this.pinService.toggle(this.call());
  }

  copyAsCurl(): void {
    this.curlLoading.set(true);
    this.hydrated(this.call()).subscribe((call) => {
      this.curlLoading.set(false);
      // A cURL command is pasted into tickets and chats as readily as a file is attached, so it
      // goes through the same masking as every other export format.
      const { call: safe } = redactCall(call, this.redactions.all());
      copyToClipboard(buildCurlCommand(safe)).then(() => {
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
        const { call: safe } = redactCall(call, this.redactions.all());
        downloadJson({ ...safe, comments }, `${callKey(call)}.json`);
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
    const detail$ = this.controlsState.getCallDetail(call.id, call.source);
    if (interceptionBodiesLoaded(call.interception)) {
      return detail$.pipe(map((detail) => ({ ...call, ...detail })));
    }
    return forkJoin({
      detail: detail$,
      interception: this.callsApi.getInterception(call.id, call.source ?? 'external').pipe(catchError(() => of(call.interception ?? null))),
    }).pipe(map(({ detail, interception }) => ({ ...call, ...detail, interception: interception ?? call.interception })));
  }

  openResend(): void {
    this.resendLoading.set(true);
    this.hydrated(this.call()).subscribe((call) => {
      this.resendLoading.set(false);
      // A cycle's captured copy can outlive the live log, so the backend is told which copy to resend.
      this.resendDialog.open(call, this.origin?.cycleId() ?? null);
    });
  }

  /** Only a call that got a response has anything to answer with. */
  readonly canAnswerWith = computed(() => this.call().response?.status != null);

  /** Opens Interception on a new rule matching this call, answered by its response - the copy itself happens there, where the secrets prompt lives. */
  useAsAnswer(): void {
    this.ruleDraft.start(this.call());
    this.router.navigate(['/interception']);
  }

  /** All four "Relive ▾" actions (T071) treat this one call as a one-item selection - same
   *  hydrate-first rule every other export/resend action here already follows. */
  private withHydrated(action: (calls: readonly CallRecord[]) => void): void {
    if (this.reliveLoading()) return;
    this.reliveError.set(null);
    this.reliveLoading.set(true);
    this.hydrated(this.call()).subscribe({
      next: (call) => {
        this.reliveLoading.set(false);
        action([call]);
      },
      error: () => {
        this.reliveLoading.set(false);
        this.reliveError.set('Could not load this call. Try again.');
      },
    });
  }

  reliveAddToCycle(): void {
    this.withHydrated((calls) => this.reliveActions.addToCycle(calls));
  }

  reliveNewCycle(): void {
    this.withHydrated((calls) => this.reliveActions.newCycleFromSelection(calls,
      () => this.reliveError.set('Could not create a Relive cycle from this call. Try again.')));
  }

  reliveNow(): void {
    this.withHydrated((calls) => this.reliveActions.reliveNow(calls));
  }

  reliveReplaceSteps(): void {
    this.withHydrated((calls) => this.reliveActions.replaceStepsOfCycle(calls));
  }

  private fetchComments(call: CallRecord) {
    return this.commentsApi.listForCall(call.id).pipe(catchError(() => of<Comment[]>([])));
  }
}
