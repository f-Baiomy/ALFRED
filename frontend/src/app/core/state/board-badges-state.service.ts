import { DestroyRef, Injectable, Signal, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CallBadge } from '../models/board.models';
import { BoardApiService } from '../services/board-api.service';
import { BoardSocketService } from '../services/board-socket.service';

/** Ids per request - the ids travel in the URL (see CommentCountsState for the 8 KB request-line limit). */
const CHUNK = 100;

/**
 * The cards shown on call rows (FR-036): every call card on screen asks for its call, and the asks of one
 * change-detection pass go out as one request per 100 ids - the CommentCountsState shape. Kept current without
 * polling: a /ws/board signal re-asks for every call asked about; a reconnect does too.
 */
@Injectable({ providedIn: 'root' })
export class BoardBadgesState {
  private readonly api = inject(BoardApiService);
  private readonly badgesSignal = signal<ReadonlyMap<string, readonly CallBadge[]>>(new Map());
  readonly badges: Signal<ReadonlyMap<string, readonly CallBadge[]>> = this.badgesSignal.asReadonly();

  private readonly requested = new Set<string>();
  private readonly queued = new Set<string>();
  private flushScheduled = false;

  constructor() {
    const socket = inject(BoardSocketService);
    const destroyRef = inject(DestroyRef);
    socket.events$.pipe(takeUntilDestroyed(destroyRef)).subscribe((e) => {
      if (e.type === 'board-changed') this.requested.forEach((id) => this.enqueue(id));
    });
    socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.requested.forEach((id) => this.enqueue(id)));
  }

  /** A call row on screen wants its cards; batched with every other ask of the same pass. */
  request(callId: string): void {
    if (this.requested.has(callId)) return;
    this.requested.add(callId);
    this.enqueue(callId);
  }

  private enqueue(callId: string): void {
    this.queued.add(callId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const ids = [...this.queued];
    this.queued.clear();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      this.api.callBadges(chunk).subscribe({
        next: (found) => {
          const next = new Map(this.badgesSignal());
          for (const id of chunk) {
            if (found[id]?.length) next.set(id, found[id]);
            else next.delete(id);
          }
          this.badgesSignal.set(next);
        },
        error: () => undefined,
      });
    }
  }
}
