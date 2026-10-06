import { DestroyRef, Injectable, Signal, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommentCount } from '../models/comment.model';
import { CommentsApiService } from '../services/comments-api.service';
import { COMMENT_EVENTS } from './comments-store.service';

/**
 * Ids per request. The ids travel in the URL, and the gateway (and Tomcat) refuse a request line over 8 KB - about
 * 200 ids - with 414/400, which silently dropped every badge of that batch (a 182-call cycle). 100 keeps it ~3.7 KB.
 */
const CHUNK = 100;

/**
 * How many comments each call on screen has - what the 💬 badge on a card or waterfall row and the
 * per-block counts on a card's chips read. Same shape as DbCaptureStateService's summaries: every
 * badge that renders asks for its call, and the asks of one change-detection pass go out as ONE
 * request (per 100 ids), never one per card. Kept current without polling: a call whose comments
 * change anywhere (/ws/comments) is re-counted if something here asked for it; a reconnect re-counts
 * all of them, since events sent while the socket was away were missed.
 */
@Injectable({ providedIn: 'root' })
export class CommentCountsState {
  private readonly api = inject(CommentsApiService);
  private readonly countsSignal = signal<ReadonlyMap<string, CommentCount>>(new Map());
  readonly counts: Signal<ReadonlyMap<string, CommentCount>> = this.countsSignal.asReadonly();

  private readonly requested = new Set<string>();
  private readonly queued = new Set<string>();
  private flushScheduled = false;

  constructor() {
    inject(COMMENT_EVENTS).pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((callId) => {
      if (callId === null) this.requested.forEach((id) => this.enqueue(id));
      else if (this.requested.has(callId)) this.enqueue(callId);
    });
  }

  /** A badge on screen wants its call's count; batched with every other ask of the same pass. */
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
      this.api.counts(chunk).subscribe({
        next: (found) => {
          const next = new Map(this.countsSignal());
          // Absent from the answer means no comments (any more) - the last one may just have been deleted.
          for (const id of chunk) {
            if (found[id]) next.set(id, found[id]);
            else next.delete(id);
          }
          this.countsSignal.set(next);
        },
        error: () => undefined,
      });
    }
  }
}
