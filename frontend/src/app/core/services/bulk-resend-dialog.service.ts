import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { EMPTY, Observable, Subject, concatMap, defer, finalize, from, map, mergeMap, of, tap, timer, toArray } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { directionOf } from '../models/call-ref.model';
import {
  Dataset,
  DraftResult,
  ResendDraft,
  RetryPolicy,
  editsOf,
} from '../../shared/utils/resend-draft';
import { ThisValues, mergeThisValues, substituteDraft, extractValues } from '../../shared/utils/resend-draft-chain';
import { SendRun, ResendGroup, runsOf } from '../../shared/utils/resend-group';
import { ResendApiService, ResendResult } from './resend-api.service';

// DraftResult now lives in resend-draft.ts (contracts.md section 6, shared with F-SCENARIO) -
// re-exported here so the component and existing imports do not have to change paths.
export type { DraftResult } from '../../shared/utils/resend-draft';

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
 * The whole editor's state, exportable as an opaque-to-the-backend definition a scenario can save
 * and F-SCENARIO can re-run (contracts.md section 3). `drafts`/`groups` are this dialog's own
 * shape; `datasets` is keyed by groupId, matching D3.
 */
export interface ScenarioDefinition {
  readonly version: 1;
  readonly drafts: readonly ResendDraft[];
  readonly groups: Readonly<Record<string, ResendGroup>>;
  readonly settings: {
    readonly delayMs: number;
    readonly stopOnFailure: boolean;
    readonly useCurrentSession: boolean;
    readonly maxParallel: number | null;
    readonly retry: RetryPolicy | null;
  };
  readonly datasets: Readonly<Record<string, Dataset>>;
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

/** One row of a dataset-driven group run, or undefined for a plain (non-data-driven) run. */
interface RowContext {
  readonly row: Readonly<Record<string, string>>;
  readonly rowIndex: number;
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
 *
 * C1/D3: a mutable `this.*` map is threaded through one whole send. A sequential run (including
 * every loose call, which is its own one-call run) merges a call's extracted values into it the
 * moment that call settles, so the NEXT call in the same run already sees them. A parallel group
 * only merges once every one of its members has settled, so "extracted values are available only
 * to runs after the group" holds without any of this needing to know what a group even is. A
 * group with a Dataset (D3) repeats itself once per row, substituting `{{row.col}}` before each
 * repetition and honouring the dataset's own onRowFailure - independent of, and evaluated in
 * addition to, the resend-wide stopOnFailure gate.
 */
@Injectable({ providedIn: 'root' })
export class BulkResendDialogService {
  private readonly api = inject(ResendApiService);

  readonly open = signal(false);
  /** True while the user is off picking more calls - the drafts are kept, the dialog is not shown. */
  readonly hidden = signal(false);
  readonly drafts = signal<readonly ResendDraft[]>([]);
  /** Changes only when a new selection starts a fresh editor session. */
  readonly editorRevision = signal(0);
  readonly stopOnFailure = signal(true);
  readonly delayMs = signal(0);
  /** Group definitions, keyed by id. Membership lives on each draft's groupId - see resend-group.ts. */
  readonly groups = signal<Readonly<Record<string, ResendGroup>>>({});
  /** The group "Edit all at once" is scoped to, or null for every ticked call. */
  readonly activeGroupId = signal<string | null>(null);
  /** Every send attempt so far, per draft key - more than one entry per key when D3 datasets or
   *  retries are in play. See resend-draft.ts's DraftResult (contracts.md section 6). */
  readonly results = signal<Readonly<Record<string, readonly DraftResult[]>>>({});
  readonly running = signal(false);
  readonly progress = signal(0);
  readonly total = signal(0);
  readonly stoppedEarly = signal(false);
  /** Set as soon as Stop / Close is pressed, cleared on the next `start`/`send` - what tells
   *  `runState` apart "stopping" (in-flight finishing) from "running". */
  private readonly stopRequestedSignal = signal(false);
  /** The run being sent right now - what the progress line names. Null between runs. */
  readonly currentRun = signal<SendRun | null>(null);
  /** How many calls are on the wire at this instant. Above 1 only inside a parallel group. */
  readonly inFlight = signal(0);

  /** D3: an uncapped parallel group (null) sends every member at once, as before; a cap limits how
   *  many are ever in flight together. */
  readonly maxParallel = signal<number | null>(null);
  /** D3: attempts/backoff applied to every send in the resend. Null = no retries (current behavior). */
  readonly retry = signal<RetryPolicy | null>(null);
  /** D3: per-group dataset, keyed by groupId. A group with no entry here runs once, as before. */
  readonly datasets = signal<Readonly<Record<string, Dataset>>>({});
  /** Scenario-level default for "use current session" - `settings.useCurrentSession` in
   *  toDefinition/loadDefinition. Per-draft `useCurrentSession` (set via "Use current session on
   *  all") is what actually governs a send; this is only round-tripped for F-SCENARIO. */
  readonly useCurrentSessionDefault = signal(false);

  readonly visible = computed(() => this.open() && !this.hidden());

  /** B2: 'idle' before any send, 'running' while one is going, 'stopping' once Stop/Close has been
   *  pressed but the in-flight call has not finished yet, 'done' once it has. */
  readonly runState = computed<'idle' | 'running' | 'stopping' | 'done'>(() => {
    if (this.running()) return this.stopRequestedSignal() ? 'stopping' : 'running';
    return this.total() > 0 ? 'done' : 'idle';
  });

  private readonly runFinishedSubject = new Subject<DraftResult[]>();
  /** Emits every result from a send once it has finished (naturally or by stopping). */
  readonly onRunFinished: Observable<DraftResult[]> = this.runFinishedSubject.asObservable();
  /** Start time of the most recent resend, used by persisted scenario run history. */
  lastRunStartedAt: string | null = null;

  private cancelRequested = false;

  start(drafts: readonly ResendDraft[]): void {
    this.editorRevision.update((revision) => revision + 1);
    this.lastRunStartedAt = null;
    this.drafts.set(drafts);
    this.stopOnFailure.set(true);
    this.delayMs.set(0);
    this.groups.set({});
    this.activeGroupId.set(null);
    this.results.set({});
    this.progress.set(0);
    this.total.set(0);
    this.stoppedEarly.set(false);
    this.stopRequestedSignal.set(false);
    this.maxParallel.set(null);
    this.retry.set(null);
    this.datasets.set({});
    this.useCurrentSessionDefault.set(false);
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
    this.stopRequestedSignal.set(true);
    this.open.set(false);
    this.hidden.set(false);
  }

  /** Stops after the call currently in flight. */
  stop(): void {
    this.cancelRequested = true;
    this.stopRequestedSignal.set(true);
  }

  /** The latest attempt for a key - what a list row's result chip shows. */
  latestResult(key: string): DraftResult | null {
    const all = this.results()[key];
    return all && all.length ? all[all.length - 1] : null;
  }

  /** Every attempt for a key, in order - what a retry count or a dataset's per-row chips read from. */
  resultsFor(key: string): readonly DraftResult[] {
    return this.results()[key] ?? [];
  }

  /** An editor-state snapshot F-SCENARIO can persist and later reload with `loadDefinition`. */
  toDefinition(): ScenarioDefinition {
    return {
      version: 1,
      drafts: this.drafts(),
      groups: this.groups(),
      settings: {
        delayMs: this.delayMs(),
        stopOnFailure: this.stopOnFailure(),
        useCurrentSession: this.useCurrentSessionDefault(),
        maxParallel: this.maxParallel(),
        retry: this.retry(),
      },
      datasets: this.datasets(),
    };
  }

  /** The inverse of `toDefinition` - loads a saved scenario back into the editor. */
  loadDefinition(def: ScenarioDefinition): void {
    this.drafts.set(def.drafts);
    this.stopOnFailure.set(def.settings.stopOnFailure);
    this.delayMs.set(def.settings.delayMs);
    this.groups.set(def.groups);
    this.datasets.set(def.datasets);
    this.maxParallel.set(def.settings.maxParallel);
    this.retry.set(def.settings.retry);
    this.useCurrentSessionDefault.set(def.settings.useCurrentSession);
    this.activeGroupId.set(null);
    this.results.set({});
    this.progress.set(0);
    this.total.set(0);
    this.stoppedEarly.set(false);
    this.stopRequestedSignal.set(false);
  }

  send(options: SendOptions): void {
    const runs = this.runs();
    if (runs.length === 0 || this.running()) return;
    this.lastRunStartedAt = new Date().toISOString();
    this.cancelRequested = false;
    this.stopRequestedSignal.set(false);
    this.running.set(true);
    this.results.set({});
    this.progress.set(0);
    this.total.set(this.totalUnitsOf(runs));
    this.stoppedEarly.set(false);
    this.currentRun.set(null);
    this.inFlight.set(0);
    const delayMs = clampDelay(options.delayMs);
    const batches = batchesFor(runs);
    const thisValues: ThisValues = {};
    const retry = this.retry();
    const maxParallel = this.maxParallel();
    const datasets = this.datasets();

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
              const dataset = run.group ? datasets[run.group.id] : undefined;
              return this.sendRun(run, dataset, delayMs, options.stopOnFailure, gate, batches, thisValues, retry, maxParallel);
            })
          );
        })
      )
      .subscribe({
        complete: () => {
          this.running.set(false);
          this.currentRun.set(null);
          this.inFlight.set(0);
          this.runFinishedSubject.next(this.flatResults());
        },
      });
  }

  /** A dataset-bearing group repeats itself once per row; anything else runs once. */
  private sendRun(
    run: SendRun,
    dataset: Dataset | undefined,
    delayMs: number,
    stopOnFailure: boolean,
    gate: SendGate,
    batches: ReadonlyMap<string, Batch | null>,
    thisValues: ThisValues,
    retry: RetryPolicy | null,
    maxParallel: number | null
  ): Observable<unknown> {
    if (!dataset || dataset.rows.length === 0) {
      return this.sendOneRoundOfRun(run, undefined, delayMs, stopOnFailure, gate, batches, thisValues, retry, maxParallel);
    }

    let rowsHalted = false;
    return from(dataset.rows).pipe(
      concatMap((row, rowIndex) => {
        if (gate.stopped() || rowsHalted) return EMPTY;
        const wait = rowIndex > 0 && delayMs > 0 ? timer(delayMs) : of(0);
        return wait.pipe(
          concatMap(() => {
            if (gate.stopped() || rowsHalted) return EMPTY;
            return this.sendOneRoundOfRun(run, { row, rowIndex }, delayMs, stopOnFailure, gate, batches, thisValues, retry, maxParallel).pipe(
              toArray(),
              tap((results: DraftResult[]) => {
                if (dataset.onRowFailure === 'STOP' && results.some((r) => r.error !== null)) rowsHalted = true;
              })
            );
          })
        );
      })
    );
  }

  /** One pass over a run's drafts - sequential or, inside a parallel group, all at once (capped by
   *  maxParallel). Emits each draft's FINAL (post-retry) DraftResult. */
  private sendOneRoundOfRun(
    run: SendRun,
    rowCtx: RowContext | undefined,
    delayMs: number,
    stopOnFailure: boolean,
    gate: SendGate,
    batches: ReadonlyMap<string, Batch | null>,
    thisValues: ThisValues,
    retry: RetryPolicy | null,
    maxParallel: number | null
  ): Observable<DraftResult> {
    const finish = (result: DraftResult): void => {
      this.progress.update((n) => n + 1);
      if (result.error !== null && stopOnFailure) gate.stop();
    };
    const onAttempt = (result: DraftResult): void => {
      this.results.update((all) => ({ ...all, [result.key]: [...(all[result.key] ?? []), result] }));
    };
    // Counts what is on the wire, so a parallel group's progress line can admit that several
    // calls are out at once instead of implying one position in a queue.
    const tracked = (draft: ResendDraft): Observable<DraftResult> =>
      this.sendOneWithRetry(draft, batches.get(draft.key) ?? null, thisValues, rowCtx, retry, onAttempt).pipe(
        tap((r) => finish(r)),
        finalize(() => this.inFlight.update((n) => Math.max(0, n - 1)))
      );

    if (run.group?.mode === 'parallel') {
      // Uncapped by default, as chosen: every call in the group goes out at once, so a stop can
      // only keep the runs after this one from starting. maxParallel (D3) caps how many of them
      // are ever in flight at the same time without changing anything else about the mode.
      return from(run.drafts).pipe(
        mergeMap(
          (draft, i) => {
            const wait = i > 0 && delayMs > 0 ? timer(delayMs) : of(0);
            return wait.pipe(
              mergeMap(() => {
                if (gate.stopped()) return EMPTY;
                this.inFlight.update((n) => n + 1);
                return tracked(draft);
              })
            );
          },
          maxParallel && maxParallel > 0 ? maxParallel : Infinity
        ),
        toArray(),
        concatMap((results: DraftResult[]) => {
          // Merged only now: a parallel group's members never see each other's extracted values,
          // only runs strictly after the whole group do.
          for (const r of results) mergeThisValues(thisValues, r.extracted);
          return from(results);
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
            return tracked(draft).pipe(tap((r) => mergeThisValues(thisValues, r.extracted)));
          })
        );
      })
    );
  }

  private sendOneWithRetry(
    draft: ResendDraft,
    batch: Batch | null,
    thisValues: ThisValues,
    rowCtx: RowContext | undefined,
    retry: RetryPolicy | null,
    onAttempt: (result: DraftResult) => void
  ): Observable<DraftResult> {
    const maxAttempts = 1 + clampAttempts(retry?.attempts);
    const attempt = (n: number): Observable<DraftResult> =>
      this.sendAttempt(draft, batch, thisValues, rowCtx, n).pipe(
        concatMap((result) => {
          onAttempt(result);
          const canRetry = !!retry && n < maxAttempts && isRetryable(result, retry.on);
          if (!canRetry) return of(result);
          const wait = retry!.backoffMs > 0 ? timer(retry!.backoffMs) : of(0);
          return wait.pipe(concatMap(() => attempt(n + 1)));
        })
      );
    return attempt(1);
  }

  private sendAttempt(draft: ResendDraft, batch: Batch | null, thisValues: ThisValues, rowCtx: RowContext | undefined, attempt: number): Observable<DraftResult> {
    return defer(() => {
      const substituted = substituteDraft(draft, thisValues, rowCtx?.row);
      if (substituted.unavailable.length) {
        return of<DraftResult>({
          key: draft.key,
          row: rowCtx?.rowIndex,
          attempt,
          status: null,
          durationMs: null,
          newCallId: null,
          error: `this.${substituted.unavailable[0]} unavailable`,
          response: null,
          extracted: {},
        });
      }
      const tempDraft = { ...draft, method: substituted.method, url: substituted.url, headers: substituted.headers, body: substituted.body };
      return this.api
        .resend({
          direction: directionOf(draft.ref),
          callId: draft.ref.callId,
          cycleId: draft.ref.cycleId,
          edits: editsOf(tempDraft),
          useCurrentSession: draft.useCurrentSession,
          batch,
        })
        .pipe(
          map(
            (r: ResendResult): DraftResult => ({
              key: draft.key,
              row: rowCtx?.rowIndex,
              attempt,
              status: r.status,
              durationMs: r.durationMs,
              newCallId: r.newCallId,
              error: null,
              response: r.response ?? null,
              extracted: extractValues(r.response ?? null, draft.extract),
            })
          ),
          catchError((failure: HttpErrorResponse) =>
            of<DraftResult>({
              key: draft.key,
              row: rowCtx?.rowIndex,
              attempt,
              status: failure.status || null,
              durationMs: null,
              newCallId: null,
              error: resendError(failure),
              response: null,
              extracted: {},
            })
          )
        );
    });
  }

  private totalUnitsOf(runs: readonly SendRun[]): number {
    const datasets = this.datasets();
    return runs.reduce((n, run) => {
      const rows = run.group && datasets[run.group.id] ? Math.max(1, datasets[run.group.id].rows.length) : 1;
      return n + run.drafts.length * rows;
    }, 0);
  }

  private flatResults(): DraftResult[] {
    return Object.values(this.results()).flat();
  }
}

function clampDelay(delayMs: number): number {
  return Math.min(Math.max(0, Math.round(delayMs || 0)), 60_000);
}

function clampAttempts(attempts: number | undefined): number {
  return Math.min(Math.max(0, Math.round(attempts ?? 0)), 5);
}

/** A retry never fires for a substitution failure ("this.x unavailable") - there is nothing a
 *  resend of the exact same request would fix. */
function isRetryable(result: DraftResult, on: readonly ('5XX' | 'NETWORK')[]): boolean {
  if (result.error === null || result.error.endsWith('unavailable')) return false;
  if (result.status !== null && result.status >= 500) return on.includes('5XX');
  if (result.status === null) return on.includes('NETWORK');
  return false;
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
