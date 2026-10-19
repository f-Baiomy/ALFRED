import { Injectable, Injector, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { Comment, CommentCount, NewComment } from '../models/comment.model';
import { AppConfigService } from './app-config.service';
import { LinksStateService } from '../links/links-state.service';
import { RemoteContextService } from '../links/remote-context.service';
import { splitRef } from '../links/remote-ref';

@Injectable({ providedIn: 'root' })
export class CommentsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);
  /** Resolved when needed: the links state injects services that would otherwise come back here. */
  private readonly injector = inject(Injector);

  listForCall(callId: string): Observable<Comment[]> {
    return this.http.get<Comment[]>(`${this.config.backendUrl}/comments`, { params: { callId } });
  }

  /** Counts for those of `callIds` that have comments (at most 500 ids per request); a call without any is absent. */
  counts(callIds: readonly string[]): Observable<Record<string, CommentCount>> {
    return this.http.get<Record<string, CommentCount>>(`${this.config.backendUrl}/comments/counts`, { params: { callIds: callIds.join(',') } });
  }

  /**
   * A comment on another Alfred's call (specs/035 D25) is never written here: it goes to its owner as a note request
   * over the stream that carries the call, and comes back as the owner's comment once accepted. What this returns
   * stands for it meanwhile (its text says it waits); an owner that is offline gets it later from this browser.
   */
  create(newComment: NewComment): Observable<Comment> {
    const split = splitRef(newComment.callId);
    if (split) {
      const links = this.injector.get(LinksStateService);
      const context = this.injector.get(RemoteContextService);
      const stream = context.streamForCall(newComment.callId);
      const cycleId = context.cycleForCall(newComment.callId);
      if (!stream) {
        return new Observable<Comment>((s) => s.error({ error: 'NOT_STREAMED', message: 'No stream from ' + links.nameOf(split.slug) + ' carries this call' }));
      }
      const owner = links.nameOf(split.slug);
      return links.send({ via: split.slug, streamId: stream.id, kind: 'CALL_NOTE', target: split.inner, targetLabel: newComment.lineText?.slice(0, 120) || undefined,
        text: newComment.comment,
        extra: JSON.stringify({ block: newComment.block, lineIndex: newComment.lineIndex, lineText: newComment.lineText, ...(cycleId ? { cycleId } : {}) }) })
        .pipe(map((r) => ({ id: r?.id ?? 'draft', callId: newComment.callId, block: newComment.block, lineIndex: newComment.lineIndex,
          lineText: newComment.lineText, createdAt: new Date().toISOString(),
          comment: r?.state === 'ACCEPTED' ? newComment.comment : `⇄ waiting for ${owner}: ${newComment.comment}` })));
    }
    return this.http.post<Comment>(`${this.config.backendUrl}/comments`, newComment);
  }

  delete(id: string): Observable<void> {
    if (splitRef(id)) {
      return new Observable<void>((s) => s.error({ error: 'READ_ONLY', message: "Another Alfred's comments are its owner's - they are not deleted from here" }));
    }
    return this.http.delete<void>(`${this.config.backendUrl}/comments/${id}`);
  }
}
