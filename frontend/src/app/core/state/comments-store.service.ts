import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject } from 'rxjs';
import { Comment, NewComment } from '../models/comment.model';
import { CommentsApiService } from '../services/comments-api.service';
import { AppConfigService } from '../services/app-config.service';
import { reconnectingSocket } from './reconnecting-socket';

/** A call whose comments changed, from any client - one id per message, or null for "anything may have changed" (a reconnect). */
export const COMMENT_EVENTS = new InjectionToken<Observable<string | null>>('COMMENT_EVENTS', {
  providedIn: 'root',
  factory: () => {
    const config = inject(AppConfigService);
    const reconnected = new Subject<string | null>();
    return new Observable<string | null>((subscriber) => {
      const fromReconnect = reconnected.subscribe(subscriber);
      const fromSocket = reconnectingSocket<{ type?: string; callId?: string }>(
        `${config.backendUrl.replace(/^http/, 'ws')}/ws/comments`,
        () => reconnected.next(null),
      ).subscribe((m) => {
        if (m?.type === 'comments-changed' && typeof m.callId === 'string') subscriber.next(m.callId);
      });
      return () => { fromReconnect.unsubscribe(); fromSocket.unsubscribe(); };
    });
  },
});

const COMMENTS_CHANNEL_NAME = 'alfred-comments';

interface CommentsSyncMessage {
  readonly callId: string;
  readonly comments: Comment[];
}

/**
 * Per-call comment cache. A call's comments are fetched once (on first
 * JsonPanelComponent that needs them) and shared from here - both the four
 * panels of a call, its export dialog, and any "open in new tab" view of
 * one of its blocks all read the same cached list rather than each making
 * their own request.
 *
 * Every genuine local mutation (add/delete) also broadcasts the call's
 * updated list over a BroadcastChannel, so a comment added in one tab
 * appears live in any other tab that already has that call's comments
 * loaded - including a dashboard tab and an "open in new tab" view of the
 * same block open side by side. Applying an *incoming* broadcast never
 * re-broadcasts, or every tab would echo the same update back and forth
 * forever.
 *
 * A comment from ANOTHER client - another browser, or Claude through the MCP server - never reaches
 * that channel. Those arrive as a call id on /ws/comments (COMMENT_EVENTS), and a call this store
 * already holds is re-fetched; one it never loaded is ignored, since it is fetched fresh when shown.
 */
@Injectable({ providedIn: 'root' })
export class CommentsStore {
  private readonly api = inject(CommentsApiService);
  private readonly channel = new BroadcastChannel(COMMENTS_CHANNEL_NAME);

  private readonly _cache = signal<ReadonlyMap<string, Comment[]>>(new Map());
  readonly cache = this._cache.asReadonly();

  constructor() {
    inject(COMMENT_EVENTS).pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((callId) => {
      const loaded = callId === null ? [...this._cache().keys()] : this._cache().has(callId) ? [callId] : [];
      for (const id of loaded) this.refetch(id);
    });
    this.channel.addEventListener('message', (event: MessageEvent<CommentsSyncMessage>) => {
      const { callId, comments } = event.data ?? {};
      if (typeof callId === 'string' && Array.isArray(comments) && this._cache().has(callId)) {
        this.setForCall(callId, comments, { broadcast: false });
      }
    });
  }

  /** No-op if this call's comments are already loaded (or loading). */
  ensureLoaded(callId: string): void {
    if (this._cache().has(callId)) return;
    this.setForCall(callId, [], { broadcast: false });
    this.api.listForCall(callId).subscribe({
      next: (comments) => this.setForCall(callId, comments, { broadcast: false }),
      error: () => {
        // leave it as an empty list rather than retrying in a loop
      },
    });
  }

  /** Re-reads one loaded call's comments from the backend - applied locally only, every other tab hears the same socket event. */
  private refetch(callId: string): void {
    this.api.listForCall(callId).subscribe({
      next: (comments) => this.setForCall(callId, comments, { broadcast: false }),
      error: () => {
        // keep what is shown; the next event or a reload brings it up to date
      },
    });
  }

  addComment(newComment: NewComment): void {
    this.api.create(newComment).subscribe((created) => {
      const current = this._cache().get(created.callId) ?? [];
      this.setForCall(created.callId, [...current, created]);
    });
  }

  deleteComment(callId: string, id: string): void {
    this.api.delete(id).subscribe(() => {
      const current = this._cache().get(callId) ?? [];
      this.setForCall(
        callId,
        current.filter((c) => c.id !== id)
      );
    });
  }

  private setForCall(callId: string, comments: Comment[], options: { broadcast?: boolean } = {}): void {
    const next = new Map(this._cache());
    next.set(callId, comments);
    this._cache.set(next);
    if (options.broadcast !== false) {
      this.channel.postMessage({ callId, comments } satisfies CommentsSyncMessage);
    }
  }
}
