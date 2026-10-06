import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { LogCounts } from '../models/call-logs.model';
import { CallLogsApiService } from '../services/call-logs-api.service';
import { LogsSocketService } from '../services/logs-socket.service';
import { DbCaptureStateService } from './db-capture-state.service';

/** At most this many ids per counts request (the backend's cap). */
const BATCH = 100;
/** Cards come on screen one observer callback at a time: this long gathers them into one request. */
const BATCH_WAIT_MS = 20;
/** A burst of `lines-added` (a log being tailed) is one refetch. */
const REFETCH_MS = 2000;

/**
 * The ▤ chip's numbers (specs/008-logs-call-link FR-013/FR-018): line, error and warning counts per call, fetched
 * only for the cards that are on screen, batched - a screen of cards costs one request. Counts are refetched for the
 * cards still shown when the logs socket says lines arrived (no polling). The call lists also ask for every loaded
 * inbound call ({@link request}), so the "✖ Logs" row mark, the "Log errors" pill and filter see calls no card shows.
 */
@Injectable({ providedIn: 'root' })
export class CallLogCountsService {
  private readonly api = inject(CallLogsApiService);

  private readonly countsSignal = signal<ReadonlyMap<string, LogCounts>>(new Map());
  readonly counts = this.countsSignal.asReadonly();
  /** Calls with at least one ERROR line - the row mark, the "Log errors" pill and the "Has log errors" filter. */
  readonly errorCallIds: Signal<ReadonlySet<string>> = computed(() =>
    new Set([...this.countsSignal()].filter(([, c]) => c.errors > 0).map(([id]) => id)));
  /** Calls with at least one WARN line - the row mark, the "Log warnings" pill and the "Has log warnings" filter. */
  readonly warnCallIds: Signal<ReadonlySet<string>> = computed(() =>
    new Set([...this.countsSignal()].filter(([, c]) => c.warnings > 0).map(([id]) => id)));

  /** Calls a list asked counts for (every loaded inbound call), with their cycle - kept while the page lives. */
  private readonly wanted = new Map<string, string | null>();
  /** Calls the agent caught new lines for, refetched together after a short wait. */
  private readonly changed = new Set<string>();

  /** Cards showing a chip right now, by call id (several cards can show one call), with the cycle they are in. */
  private readonly shown = new Map<string, { count: number; cycleId: string | null }>();
  /** Waiting ids, by cycle ('' = live calls): one request per cycle per batch. */
  private readonly queued = new Map<string, Set<string>>();
  private flushScheduled = false;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const socket = inject(LogsSocketService);
    const sub = socket.events$.subscribe((e) => {
      if (e.type === 'lines-added' && e.count > 0) this.scheduleRefetch();
    });
    const reconnect = socket.reconnected$.subscribe(() => this.scheduleRefetch());
    // lines the agent caught (specs/009) arrive on the database-capture socket
    const caught = inject(DbCaptureStateService).events$.subscribe((e) => {
      if (e.type === 'logs-appended' && e.callId && (this.shown.has(e.callId) || this.wanted.has(e.callId))) this.changedLater(e.callId);
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      reconnect.unsubscribe();
      caught.unsubscribe();
      if (this.refetchTimer) clearTimeout(this.refetchTimer);
    });
  }

  /** A card with this call came on screen; `cycleId` when the card is in a session cycle. */
  show(callId: string, cycleId: string | null = null): void {
    const was = this.shown.get(callId);
    this.shown.set(callId, { count: (was?.count ?? 0) + 1, cycleId: was?.cycleId ?? cycleId });
    if (!was && !this.countsSignal().has(callId)) this.enqueue(callId, cycleId);
  }

  /** A list loaded this call (not necessarily on screen): its counts are fetched once, and again when lines arrive. */
  request(callId: string, cycleId: string | null = null): void {
    if (this.wanted.has(callId)) return;
    this.wanted.set(callId, cycleId);
    if (!this.countsSignal().has(callId) && !this.shown.has(callId)) this.enqueue(callId, cycleId);
  }

  /** It left the screen (or was destroyed). */
  hide(callId: string): void {
    const was = this.shown.get(callId);
    if (!was || was.count <= 1) this.shown.delete(callId);
    else this.shown.set(callId, { ...was, count: was.count - 1 });
  }

  /** Counts of this call again (its window was opened, its project's ▤ changed). */
  refresh(callId: string, cycleId: string | null = null): void {
    this.enqueue(callId, this.shown.get(callId)?.cycleId ?? cycleId);
  }

  private changedLater(callId: string): void {
    this.changed.add(callId);
    if (this.refetchTimer) return;
    this.refetchTimer = setTimeout(() => this.refetchNow(), REFETCH_MS);
  }

  private scheduleRefetch(): void {
    for (const id of this.shown.keys()) this.changed.add(id);
    if (this.refetchTimer || !this.changed.size) return;
    this.refetchTimer = setTimeout(() => this.refetchNow(), REFETCH_MS);
  }

  private refetchNow(): void {
    this.refetchTimer = null;
    for (const id of this.changed) this.enqueue(id, this.shown.get(id)?.cycleId ?? this.wanted.get(id) ?? null);
    this.changed.clear();
  }

  private enqueue(callId: string, cycleId: string | null): void {
    const key = cycleId ?? '';
    if (!this.queued.has(key)) this.queued.set(key, new Set());
    this.queued.get(key)!.add(callId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => this.flush(), BATCH_WAIT_MS);
  }

  private flush(): void {
    this.flushScheduled = false;
    const batches = [...this.queued].map(([cycle, ids]) => [cycle || null, [...ids]] as const);
    this.queued.clear();
    for (const [cycleId, ids] of batches) this.fetch(ids, cycleId);
  }

  private fetch(ids: readonly string[], cycleId: string | null): void {
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      this.api.counts(chunk, cycleId).subscribe({
        next: (found) => {
          const next = new Map(this.countsSignal());
          for (const id of chunk) {
            const c = found[id];
            if (c && c.lines > 0) next.set(id, c);
            else next.delete(id);
          }
          this.countsSignal.set(next);
        },
        error: () => undefined,
      });
    }
  }
}
