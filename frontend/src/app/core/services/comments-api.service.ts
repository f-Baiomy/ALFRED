import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Comment, CommentCount, NewComment } from '../models/comment.model';
import { AppConfigService } from './app-config.service';

@Injectable({ providedIn: 'root' })
export class CommentsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  listForCall(callId: string): Observable<Comment[]> {
    return this.http.get<Comment[]>(`${this.config.backendUrl}/comments`, { params: { callId } });
  }

  /** Counts for those of `callIds` that have comments (at most 500 ids per request); a call without any is absent. */
  counts(callIds: readonly string[]): Observable<Record<string, CommentCount>> {
    return this.http.get<Record<string, CommentCount>>(`${this.config.backendUrl}/comments/counts`, { params: { callIds: callIds.join(',') } });
  }

  create(newComment: NewComment): Observable<Comment> {
    return this.http.post<Comment>(`${this.config.backendUrl}/comments`, newComment);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.config.backendUrl}/comments/${id}`);
  }
}
