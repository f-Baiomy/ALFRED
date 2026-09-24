import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ResendApiService, ResendResult } from '../../core/services/resend-api.service';
import { ResendDialogService } from '../../core/services/resend-dialog.service';

interface HeaderRow {
  name: string;
  value: string;
  /** Removed from the resent call entirely - a header edited down to "no value", not "empty string". */
  removed: boolean;
}

/**
 * One instance lives at the app root; ResendDialogService.state drives whether it's visible and
 * for which call. Opening resets the form from that call's own method/url/headers/body - every
 * field stays freely editable, since the point of resending is usually to change exactly one of
 * them and see what happens.
 */
@Component({
  selector: 'app-resend-dialog',
  standalone: true,
  templateUrl: './resend-dialog.component.html',
})
export class ResendDialogComponent {
  private readonly dialogService = inject(ResendDialogService);
  private readonly api = inject(ResendApiService);

  readonly state = this.dialogService.state;

  readonly method = signal('');
  readonly url = signal('');
  readonly headers = signal<HeaderRow[]>([]);
  readonly body = signal('');
  readonly useCurrentSession = signal(false);

  readonly sending = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<ResendResult | null>(null);

  readonly resultCallHref = computed(() => {
    const result = this.result();
    return result ? `/?requestId=${encodeURIComponent(result.newCallId)}` : null;
  });

  constructor() {
    // Resets the form to the newly-opened call's own request - not an update, so re-opening the
    // same dialog for a different call never leaves a stale edit behind.
    effect(() => {
      const current = this.state();
      untracked(() => {
        if (!current) return;
        const call = current.call;
        this.method.set(call.method);
        this.url.set(call.url);
        this.body.set(call.request?.body ?? '');
        this.headers.set(
          Object.entries(call.request?.headers ?? {}).map(([name, value]) => ({ name, value, removed: false }))
        );
        this.useCurrentSession.set(false);
        this.error.set(null);
        this.result.set(null);
      });
    });
  }

  onMethod(event: Event): void {
    this.method.set((event.target as HTMLInputElement).value);
  }

  onUrl(event: Event): void {
    this.url.set((event.target as HTMLInputElement).value);
  }

  onBody(event: Event): void {
    this.body.set((event.target as HTMLTextAreaElement).value);
  }

  onHeaderValue(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.headers.update((rows) => rows.map((row, i) => (i === index ? { ...row, value } : row)));
  }

  toggleHeaderRemoved(index: number): void {
    this.headers.update((rows) => rows.map((row, i) => (i === index ? { ...row, removed: !row.removed } : row)));
  }

  toggleUseCurrentSession(event: Event): void {
    this.useCurrentSession.set((event.target as HTMLInputElement).checked);
  }

  close(): void {
    this.dialogService.close();
  }

  send(): void {
    const current = this.state();
    if (!current || this.sending()) return;
    const call = current.call;

    const editedHeaders: Record<string, string | null> = {};
    for (const row of this.headers()) {
      const original = call.request?.headers?.[row.name];
      if (row.removed) {
        editedHeaders[row.name] = null;
      } else if (row.value !== original) {
        editedHeaders[row.name] = row.value;
      }
    }
    const edits = {
      ...(this.method() !== call.method ? { method: this.method() } : {}),
      ...(this.url() !== call.url ? { url: this.url() } : {}),
      ...(Object.keys(editedHeaders).length ? { headers: editedHeaders } : {}),
      ...(this.body() !== (call.request?.body ?? '') ? { body: this.body() } : {}),
    };

    this.sending.set(true);
    this.error.set(null);
    this.api
      .resend({
        direction: call.source === 'internal' ? 'inbound' : 'outbound',
        callId: call.id,
        cycleId: current.cycleId,
        edits,
        useCurrentSession: this.useCurrentSession(),
      })
      .subscribe({
        next: (result) => {
          this.sending.set(false);
          this.result.set(result);
        },
        error: (failure: HttpErrorResponse) => {
          this.sending.set(false);
          this.error.set(errorMessage(failure));
        },
      });
  }
}

function errorMessage(failure: HttpErrorResponse): string {
  const body = failure.error as { error?: string; message?: string } | null;
  if (body?.error === 'call-not-found') return 'That call could not be found - it may have left the log.';
  if (body?.error === 'reverse-proxy-not-running') return "This project's reverse-proxy listener isn't running.";
  if (body?.error === 'send-failed') return `The resend failed: ${body.message ?? 'unknown error'}.`;
  if (body?.error === 'invalid-request') return 'One of the edits is too large to resend.';
  return 'Could not resend that call. Try again.';
}
