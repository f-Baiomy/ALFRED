import { Injectable, inject } from '@angular/core';
import { Observable, catchError, forkJoin, from, map, mergeMap, of, switchMap, toArray } from 'rxjs';
import { CallsApiService } from './calls-api.service';
import { CommentsApiService } from './comments-api.service';
import { ExportApiService } from './export-api.service';
import { ExportDialogService } from './export-dialog.service';
import { CallEndpointSource, CallRecord } from '../models/call.model';
import { Comment } from '../models/comment.model';

/** How many calls are loaded at once - an export of thousands must not open thousands of requests together. */
const PARALLEL = 6;

/**
 * Settings → Storage's "Export (.json)": loads the chosen calls in full - request, response, interception - and
 * opens the ordinary export dialog on them, so the file is Alfred's own .json export (the re-import format), never a
 * summary. Calls in their original order, oldest first.
 */
@Injectable({ providedIn: 'root' })
export class StorageExportService {
  private readonly callsApi = inject(CallsApiService);
  private readonly commentsApi = inject(CommentsApiService);
  private readonly exportApi = inject(ExportApiService);
  private readonly exportDialog = inject(ExportDialogService);

  /** Loads and opens the export; completes with how many calls it holds. */
  exportCalls(direction: 'inbound' | 'outbound', ids: readonly string[]): Observable<number> {
    const source: CallEndpointSource = direction === 'inbound' ? 'internal' : 'external';
    return from(ids).pipe(
      mergeMap((id, i) => this.load(id, source).pipe(map((call) => ({ i, call }))), PARALLEL),
      toArray(),
      map((loaded) => loaded.filter((l) => !!l.call).sort((a, b) => a.i - b.i).map((l) => l.call as CallRecord)),
      switchMap((calls) => {
        if (calls.length === 0) return of(0);
        return forkJoin({
          metadata: this.exportApi.fetchMetadata(calls[0]).pipe(catchError(() => of(null))),
          comments: this.comments(calls),
        }).pipe(
          map(({ metadata, comments }) => {
            this.exportDialog.open(calls, metadata, comments, 'json');
            return calls.length;
          })
        );
      })
    );
  }

  private load(id: string, source: CallEndpointSource): Observable<CallRecord | null> {
    return forkJoin({
      summary: this.callsApi.getSummary(id, source),
      detail: this.callsApi.getDetail(id, source),
      interception: this.callsApi.getInterception(id, source).pipe(catchError(() => of(null))),
    }).pipe(
      map(({ summary, detail, interception }) => ({ ...summary, ...detail, source, interception: interception ?? summary.interception }) as CallRecord),
      // a call deleted since the list was made is simply not in the file
      catchError(() => of(null))
    );
  }

  private comments(calls: readonly CallRecord[]): Observable<ReadonlyMap<string, readonly Comment[]>> {
    return from(calls).pipe(
      mergeMap((c) => this.commentsApi.listForCall(c.id).pipe(catchError(() => of<Comment[]>([])), map((list) => [c.id, list] as const)), PARALLEL),
      toArray(),
      map((pairs) => new Map(pairs))
    );
  }
}
