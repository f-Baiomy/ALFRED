import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { LogCounts } from '../models/call-logs.model';
import { CallLogsApiService } from '../services/call-logs-api.service';
import { LogsSocketService } from '../services/logs-socket.service';

/** At most this many ids per counts request (the backend's cap). */
const BATCH = 100;
/** Cards come on screen one observer callback at a time: this long gathers them into one request. */
const BATCH_WAIT_MS = 20;
/** A burst of `lines-added` (a log being tailed) is one refetch. */
const REFETCH_MS = 2000;

/**
 * The ▤ chip's numbers (specs/008-logs-call-link FR-013/FR-018): line, error and warning counts per call, fetched
 * only for the cards that are on screen, batched - a screen of cards costs one request. Counts are refetched for the
 * cards still shown when the logs socket says lines arrived (no polling).
 */
@Injectable({ providedIn: 'root' })
export class CallLogCountsService {
  private readonly api = inject(CallLogsApiService);

  private readonly countsSignal = signal<ReadonlyMap<string, LogCounts>>(new Map());
  readonly counts = this.countsSignal.asReadonly();

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
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      reconnect.unsubscribe();
      if (this.refetchTimer) clearTimeout(this.refetchTimer);
    });
  }

  /** A card with this call came on screen; `cycleId` when the card is in a session cycle. */
  show(callId: string, cycleId: string | null = null): void {
    const was = this.shown.get(callId);
    this.shown.set(callId, { count: (was?.count ?? 0) + 1, cycleId: was?.cycleId ?? cycleId });
    if (!was && !this.countsSignal().has(callId)) this.enqueue(callId, cycleId);
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

  private scheduleRefetch(): void {
    if (this.refetchTimer || !this.shown.size) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      for (const [id, card] of this.shown) this.enqueue(id, card.cycleId);
    }, REFETCH_MS);
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
