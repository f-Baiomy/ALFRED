import { DestroyRef, Injectable, Signal, computed, inject, signal } from '@angular/core';
import { CallStoreSummary } from '../models/store-command.model';
import { DbCaptureApiService } from '../services/db-capture-api.service';
import { DbCaptureStateService } from './db-capture-state.service';

/** At most this many ids per summaries request (the backend's cap - they travel in the URL). */
const BATCH = 100;
/** Cards come on screen one observer callback at a time: this long gathers them into one request. */
const BATCH_WAIT_MS = 20;

/**
 * The ⬢ Redis chip's numbers (specs/011-redis-capture FR-013/FR-014): each call's Redis summary, fetched only for the
 * cards on screen and the calls a list loaded (for the "✖ Redis failures" pill and filter), batched - a screen of cards
 * costs one request. Refetched when the database-capture socket says a call's Redis commands changed - never polled.
 * No summary for a call = ⬢ was off for it (no chip); a summary with 0 commands = the agent saw none.
 */
@Injectable({ providedIn: 'root' })
export class CallStoreCountsService {
  private readonly api = inject(DbCaptureApiService);

  private readonly summariesSignal = signal<ReadonlyMap<string, CallStoreSummary>>(new Map());
  readonly summaries = this.summariesSignal.asReadonly();
  /** Calls with a failed Redis command - the "✖ Redis failures" pill and filter. */
  readonly failedCallIds: Signal<ReadonlySet<string>> = computed(() =>
    new Set([...this.summariesSignal().values()].filter((s) => s.failed > 0).map((s) => s.callId)));

  private readonly wanted = new Set<string>();
  private readonly shown = new Map<string, number>();
  private readonly queued = new Set<string>();
  private flushScheduled = false;

  constructor() {
    const db = inject(DbCaptureStateService);
    const sub = db.events$.subscribe((e) => {
      if (e.type === 'store-commands') {
        for (const id of e.callIds) if (this.shown.has(id) || this.wanted.has(id)) this.enqueue(id);
      }
    });
    const reconnect = db.reconnected$.subscribe(() => {
      for (const id of [...this.shown.keys(), ...this.wanted]) this.enqueue(id);
    });
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      reconnect.unsubscribe();
    });
  }

  /** A card with this call came on screen. */
  show(callId: string): void {
    const was = this.shown.get(callId) ?? 0;
    this.shown.set(callId, was + 1);
    if (!was && !this.summariesSignal().has(callId) && !this.wanted.has(callId)) this.enqueue(callId);
  }

  hide(callId: string): void {
    const was = this.shown.get(callId) ?? 0;
    if (was <= 1) this.shown.delete(callId);
    else this.shown.set(callId, was - 1);
  }

  /** A list loaded this call (not necessarily on screen): its summary is fetched once, and again when it changes. */
  request(callId: string): void {
    if (this.wanted.has(callId)) return;
    this.wanted.add(callId);
    if (!this.summariesSignal().has(callId) && !this.shown.has(callId)) this.enqueue(callId);
  }

  refresh(callId: string): void {
    this.enqueue(callId);
  }

  private enqueue(callId: string): void {
    this.queued.add(callId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => this.flush(), BATCH_WAIT_MS);
  }

  private flush(): void {
    this.flushScheduled = false;
    const ids = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      this.api.storeSummaries(chunk).subscribe({
        next: (found) => {
          const next = new Map(this.summariesSignal());
          for (const id of chunk) {
            const s = found[id];
            if (s) next.set(id, s);
            else next.delete(id);
          }
          this.summariesSignal.set(next);
        },
        error: () => undefined,
      });
    }
  }
}
