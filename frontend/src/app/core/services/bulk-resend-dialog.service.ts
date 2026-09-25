import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { EMPTY, Observable, concatMap, defer, finalize, from, mergeMap, of, tap, timer } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { directionOf } from '../models/call-ref.model';
import { ResendDraft, editsOf } from '../../shared/utils/resend-draft';
import { SendRun, ResendGroup, runsOf } from '../../shared/utils/resend-group';
import { ResendApiService, ResendResult } from './resend-api.service';

export interface DraftResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly newCallId: string | null;
  readonly error: string | null;
}

export interface Batch {
  readonly id: string;
  readonly index: number;
  readonly total: number;
}

export interface SendOptions {
  readonly stopOnFailure: boolean;
  /** Waited BETWEEN sends, not before the first. In a parallel run it staggers the launches. */
  readonly delayMs: number;
}

/**
 * Stops, from two directions: a failure the user asked to stop on, or the Stop button / the dialog
 * closing. `stopped` is a plain read checked before each launch; `stop` is the one irreversible
 * call. They are separate because conflating them made merely ASKING whether to stop actually stop
 * the send - which silently sent nothing at all.
 */
interface SendGate {
  readonly stopped: () => boolean;
  readonly stop: () => void;
}

/**
 * The multi-call resend editor's state. Lives in a root service, not the dialog, because the
 * drafts must survive the dialog hiding while the user picks more calls on another tab - and the
 * send loop keeps running if the dialog is closed mid-batch.
 *
 * The list is a sequence of RUNS (resend-group.ts): a group, or a stretch of loose calls between
 * two groups. Runs always go in list order, so "search first, then book" still holds across the
 * whole resend; only WITHIN a run does the group's own mode apply, and only a parallel group
 * sends its calls at the same time.
 *
 * A batch is per run, not per resend: each run gets its own id so the log reads "2 of 3" within
 * the group it belongs to. A one-call run gets none - there is no position to be in.
 */
@Injectable({ providedIn: 'root' })
export class BulkResendDialogService {
  private readonly api = inject(ResendApiService);

  readonly open = signal(false);
  /** True while the user is off picking more calls - the drafts are kept, the dialog is not shown. */
  readonly hidden = signal(false);
  readonly drafts = signal<readonly ResendDraft[]>([]);
  /** Group definitions, keyed by id. Membership lives on each draft's groupId - see resend-group.ts. */
  readonly groups = signal<Readonly<Record<string, ResendGroup>>>({});
  /** The group "Edit all at once" is scoped to, or null for every ticked call. */
  readonly activeGroupId = signal<string | null>(null);
  readonly results = signal<Readonly<Record<string, DraftResult>>>({});
  readonly running = signal(false);
  readonly progress = signal(0);
  readonly total = signal(0);
  readonly stoppedEarly = signal(false);
  /** The run being sent right now - what the progress line names. Null between runs. */
  readonly currentRun = signal<SendRun | null>(null);
  /** How many calls are on the wire at this instant. Above 1 only inside a parallel group. */
  readonly inFlight = signal(0);

  readonly visible = computed(() => this.open() && !this.hidden());

  private cancelRequested = false;

  start(drafts: readonly ResendDraft[]): void {
    this.drafts.set(drafts);
    this.groups.set({});
    this.activeGroupId.set(null);
    this.results.set({});
    this.progress.set(0);
    this.total.set(0);
    this.stoppedEarly.set(false);
    this.hidden.set(false);
    this.open.set(true);
  }

  /**
   * The runs to SEND: unticked calls are gone, since skipping one is the point of unticking it.
   */
  readonly runs = computed<SendRun[]>(() =>
    runsOf(this.drafts().filter((d) => d.include), this.groups()).filter((run) => run.drafts.length > 0)
  );

  /**
   * The runs to SHOW, which is every call including the unticked ones - they have to stay visible
   * and re-tickable, so this is deliberately not `runs`. Rendering one list for both is how an
   * unticked call ends up unable to be unticked back.
   */
  listRuns(drafts: readonly ResendDraft[]): SendRun[] {
    return runsOf(drafts, this.groups());
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
    const runs = this.runs();
    if (runs.length === 0 || this.running()) return;
    this.cancelRequested = false;
    this.running.set(true);
    this.results.set({});
    this.progress.set(0);
    this.total.set(runs.reduce((n, run) => n + run.drafts.length, 0));
    this.stoppedEarly.set(false);
    this.currentRun.set(null);
    this.inFlight.set(0);
    const delayMs = Math.min(Math.max(0, Math.round(options.delayMs || 0)), 60_000);
    const batches = batchesFor(runs);

    // A stop can only stop the NEXT run from starting. Whatever a parallel run already launched is
    // at the supplier by now, and there is no handle to call it back on.
    let halted = false;
    const gate: SendGate = {
      stopped: () => halted || this.cancelRequested,
      stop: () => {
        if (halted) return;
        halted = true;
        this.stoppedEarly.set(true);
      },
    };

    from(runs)
      .pipe(
        concatMap((run, index) => {
          if (gate.stopped()) return EMPTY;
          // The delay is applied on BOTH sides of a run boundary - between two runs here, and
          // between two calls inside one - so it means the same thing however the list is grouped.
          // Exactly one of the two ever applies to any given pair of calls, so it never doubles.
          const wait = index > 0 && delayMs > 0 ? timer(delayMs) : of(0);
          return wait.pipe(
            concatMap(() => {
              if (gate.stopped()) return EMPTY;
              this.currentRun.set(run);
              return this.sendRun(run, delayMs, options.stopOnFailure, gate, batches);
            })
          );
        })
      )
      .subscribe({
        complete: () => {
          this.running.set(false);
          this.currentRun.set(null);
          this.inFlight.set(0);
        },
      });
  }

  private sendRun(
    run: SendRun,
    delayMs: number,
    stopOnFailure: boolean,
    gate: SendGate,
    batches: ReadonlyMap<string, Batch | null>
  ): Observable<unknown> {
    const record = (draft: ResendDraft, result: DraftResult): void => {
      this.results.update((all) => ({ ...all, [draft.key]: result }));
      this.progress.update((n) => n + 1);
      if (!result.ok && stopOnFailure) gate.stop();
    };
    // Counts what is on the wire, so a parallel group's progress line can admit that several
    // calls are out at once instead of implying one position in a queue.
    const tracked = (draft: ResendDraft) =>
      this.sendOne(draft, batches.get(draft.key) ?? null).pipe(
        tap((r) => record(draft, r)),
        finalize(() => this.inFlight.update((n) => Math.max(0, n - 1)))
      );

    if (run.group?.mode === 'parallel') {
      // Uncapped, as chosen: every call in the group goes out at once, so a stop can only keep
      // the runs after this one from starting - there is nothing already sent here to call back.
      // A delay staggers the launches instead of separating them, so a group can still be ramped;
      // a stop during that ramp still stops the launches that have not gone out yet, because
      // unlike an in-flight call, one still waiting on its timer is genuinely holdable.
      return from(run.drafts).pipe(
        mergeMap((draft, i) => {
          const wait = i > 0 && delayMs > 0 ? timer(delayMs) : of(0);
          return wait.pipe(
            mergeMap(() => {
              if (gate.stopped()) return EMPTY;
              this.inFlight.update((n) => n + 1);
              return tracked(draft);
            })
          );
        })
      );
    }

    return from(run.drafts).pipe(
      concatMap((draft, i) => {
        if (gate.stopped()) return EMPTY;
        const wait = i > 0 && delayMs > 0 ? timer(delayMs) : of(0);
        return wait.pipe(
          concatMap(() => {
            if (gate.stopped()) return EMPTY;
            this.inFlight.set(1);
            return tracked(draft);
          })
        );
      })
    );
  }

  private sendOne(draft: ResendDraft, batch: Batch | null): Observable<DraftResult> {
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

/**
 * Where each call sits in the log's "2 of 4" - decided here, before anything is sent, because a
 * parallel group's calls all leave at once and so cannot be numbered as they complete.
 *
 * Each GROUP is its own batch, numbered within itself, so a group reads "2 of 3" in the log rather
 * than a position in a resend it has nothing to do with. Every LOOSE call shares one batch across
 * the whole resend, which is what an ungrouped list has always done - so grouping nothing sends
 * exactly as it did before. A batch of one is no batch: there is no position to be in.
 */
function batchesFor(runs: readonly SendRun[]): Map<string, Batch | null> {
  const batches = new Map<string, Batch | null>();
  const looseTotal = runs.filter((run) => !run.group).reduce((n, run) => n + run.drafts.length, 0);
  const looseId = looseTotal > 1 ? newBatchId() : null;
  let looseIndex = 0;

  for (const run of runs) {
    if (run.group) {
      const id = run.drafts.length > 1 ? newBatchId() : null;
      run.drafts.forEach((draft, i) =>
        batches.set(draft.key, id ? { id, index: i + 1, total: run.drafts.length } : null)
      );
    } else {
      for (const draft of run.drafts) {
        looseIndex++;
        batches.set(draft.key, looseId ? { id: looseId, index: looseIndex, total: looseTotal } : null);
      }
    }
  }
  return batches;
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
