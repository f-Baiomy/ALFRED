import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { EMPTY, Observable, concatMap, defer, from, of, tap, timer } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { directionOf } from '../models/call-ref.model';
import { ResendDraft, editsOf } from '../../shared/utils/resend-draft';
import { ResendApiService, ResendResult } from './resend-api.service';

export interface DraftResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly newCallId: string | null;
  readonly error: string | null;
}

export interface SendOptions {
  readonly stopOnFailure: boolean;
  /** Waited BETWEEN sends, not before the first. */
  readonly delayMs: number;
}

/**
 * The multi-call resend editor's state. Lives in a root service, not the dialog, because the
 * drafts must survive the dialog hiding while the user picks more calls on another tab - and the
 * send loop keeps running if the dialog is closed mid-batch.
 *
 * Sends strictly in list order, one at a time: a batch is usually a sequence (search, then book),
 * and running them in parallel would make "2 of 4" meaningless.
 */
@Injectable({ providedIn: 'root' })
export class BulkResendDialogService {
  private readonly api = inject(ResendApiService);

  readonly open = signal(false);
  /** True while the user is off picking more calls - the drafts are kept, the dialog is not shown. */
  readonly hidden = signal(false);
  readonly drafts = signal<readonly ResendDraft[]>([]);
  readonly results = signal<Readonly<Record<string, DraftResult>>>({});
  readonly running = signal(false);
  readonly progress = signal(0);
  readonly total = signal(0);
  readonly stoppedEarly = signal(false);

  readonly visible = computed(() => this.open() && !this.hidden());

  private cancelRequested = false;

  start(drafts: readonly ResendDraft[]): void {
    this.drafts.set(drafts);
    this.results.set({});
    this.progress.set(0);
    this.total.set(0);
    this.stoppedEarly.set(false);
    this.hidden.set(false);
    this.open.set(true);
  }

  append(drafts: readonly ResendDraft[]): void {
    this.drafts.update((current) => [...current, ...drafts]);
  }

  close(): void {
    // Closing mid-run stops after the call in flight rather than abandoning it half-sent.
    this.cancelRequested = true;
    this.open.set(false);
    this.hidden.set(false);
  }

  /** Stops after the call currently in flight. */
  stop(): void {
    this.cancelRequested = true;
  }

  send(options: SendOptions): void {
    const queue = this.drafts().filter((d) => d.include);
    if (queue.length === 0 || this.running()) return;
    this.cancelRequested = false;
    this.running.set(true);
    this.results.set({});
    this.progress.set(0);
    this.total.set(queue.length);
    this.stoppedEarly.set(false);
    const batchId = queue.length > 1 ? newBatchId() : null;
    const delayMs = Math.min(Math.max(0, Math.round(options.delayMs || 0)), 60_000);

    let halted = false;
    from(queue.map((draft, i) => ({ draft, i })))
      .pipe(
        concatMap(({ draft, i }) => {
          if (halted || this.cancelRequested) return EMPTY;
          const wait = i > 0 && delayMs > 0 ? timer(delayMs) : of(0);
          return wait.pipe(
            concatMap(() => (halted || this.cancelRequested ? EMPTY : this.sendOne(draft, batchId ? { id: batchId, index: i + 1, total: queue.length } : null))),
            tap((result) => {
              this.results.update((all) => ({ ...all, [draft.key]: result }));
              this.progress.update((n) => n + 1);
              if (!result.ok && options.stopOnFailure) {
                halted = true;
                this.stoppedEarly.set(this.progress() < queue.length);
              }
            })
          );
        })
      )
      .subscribe({ complete: () => this.running.set(false) });
  }

  private sendOne(draft: ResendDraft, batch: { id: string; index: number; total: number } | null): Observable<DraftResult> {
    return defer(() =>
      this.api.resend({
        direction: directionOf(draft.ref),
        callId: draft.ref.callId,
        cycleId: draft.ref.cycleId,
        edits: editsOf(draft),
        useCurrentSession: draft.useCurrentSession,
        batch,
      })
    ).pipe(
      map((r: ResendResult): DraftResult => ({ ok: true, status: r.status, durationMs: r.durationMs, newCallId: r.newCallId, error: null })),
      catchError((failure: HttpErrorResponse) => of<DraftResult>({ ok: false, status: null, durationMs: null, newCallId: null, error: resendError(failure) }))
    );
  }
}

function newBatchId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Same wording as the single Resend dialog - one failure reads the same whichever way it was sent. */
export function resendError(failure: HttpErrorResponse): string {
  const body = failure.error as { error?: string; message?: string } | null;
  if (body?.error === 'call-not-found') return 'That call could not be found - it may have left the log.';
  if (body?.error === 'reverse-proxy-not-running') return "This project's reverse-proxy listener isn't running.";
  if (body?.error === 'send-failed') return `The resend failed: ${body.message ?? 'unknown error'}.`;
  if (body?.error === 'invalid-request') return 'One of the edits is too large to resend.';
  return 'Could not resend that call. Try again.';
}
