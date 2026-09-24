import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { PickedCall, refOf } from '../../core/models/call-ref.model';
import { resendError } from '../../core/services/bulk-resend-dialog.service';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { ResendApiService, ResendResult } from '../../core/services/resend-api.service';
import { ResendDialogService } from '../../core/services/resend-dialog.service';
import { directionOf } from '../../core/models/call-ref.model';
import { ResendDraft, draftFrom, editsOf } from '../../shared/utils/resend-draft';
import { ResendCallEditorComponent } from '../resend-call-editor/resend-call-editor.component';

const RESEND_REQUESTER = 'resend';

/**
 * One instance lives in the main layout, so it opens from any page; ResendDialogService.state
 * drives whether it's visible and for which call. Opening starts a fresh draft from that call's
 * own request, edited through the same ResendCallEditorComponent the multi-call resend uses - so
 * the headers and body get the call card's formatter, colours, find and find-and-replace, and
 * "Format" alone is never sent as an edit (see editsOf).
 */
@Component({
  selector: 'app-resend-dialog',
  standalone: true,
  imports: [ResendCallEditorComponent],
  templateUrl: './resend-dialog.component.html',
})
export class ResendDialogComponent {
  private readonly dialogService = inject(ResendDialogService);
  private readonly api = inject(ResendApiService);
  private readonly picker = inject(CallPickerService);
  private readonly refDetail = inject(CallRefDetailService);
  private readonly router = inject(Router);

  readonly state = this.dialogService.state;
  readonly draft = signal<ResendDraft | null>(null);

  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ResendResult | null>(null);

  readonly resultCallHref = computed(() => {
    const result = this.result();
    return result ? `/?requestId=${encodeURIComponent(result.newCallId)}` : null;
  });

  /** Swaps which call is resent: closes the dialog, lets the user pick a call anywhere, reopens with it on Return. */
  pickAnother(): void {
    const current = this.state();
    // The call being resent now, so Cancel can reopen it - as a ref plus summary, never its body.
    const resume: PickedCall | null = current
      ? { ref: refOf(current.call, current.cycleId), call: { ...current.call, request: undefined, response: undefined }, originLabel: '' }
      : null;
    this.picker.start({
      requester: RESEND_REQUESTER,
      title: 'Call to resend',
      mode: 'single',
      returnUrl: this.router.url,
      returnLabel: 'the resend dialog',
      resume,
    });
    this.close();
  }

  constructor() {
    // This dialog lives in the layout, so it is still here when Return is pressed.
    effect(() => {
      if (!this.picker.hasResult(RESEND_REQUESTER)) return;
      untracked(() => {
        const result = this.picker.takeResult(RESEND_REQUESTER);
        const picked = result?.picked[0] ?? (result?.resume as PickedCall | null);
        if (!picked) return;
        this.refDetail.hydrate(picked.ref, picked.call).subscribe({
          next: (call) => this.dialogService.open(call, picked.ref.cycleId),
          error: () => this.error.set('Could not load the picked call.'),
        });
      });
    });

    // A fresh draft per opened call - never an update, so re-opening for a different call never
    // leaves a stale edit behind.
    effect(() => {
      const current = this.state();
      untracked(() => {
        this.draft.set(current ? draftFrom(current.call, current.cycleId) : null);
        this.error.set(null);
        this.result.set(null);
      });
    });
  }

  close(): void {
    this.dialogService.close();
  }

  send(): void {
    const draft = this.draft();
    if (!draft || this.sending()) return;
    this.sending.set(true);
    this.error.set(null);
    this.api
      .resend({
        direction: directionOf(draft.ref),
        callId: draft.ref.callId,
        cycleId: draft.ref.cycleId,
        edits: editsOf(draft),
        useCurrentSession: draft.useCurrentSession,
      })
      .subscribe({
        next: (result) => {
          this.sending.set(false);
          this.result.set(result);
        },
        error: (failure: HttpErrorResponse) => {
          this.sending.set(false);
          this.error.set(resendError(failure));
        },
      });
  }
}
