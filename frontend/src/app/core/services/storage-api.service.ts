import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  CleanupRequest, CleanupResult, DiskState, FileHealth, StorageBackup, StorageBackups, StorageBudget, StorageInsights, StorageOverview,
} from '../models/storage.model';

/** Settings → Storage's endpoints (backend-app/storage/StorageController) - no state, just the requests. */
@Injectable({ providedIn: 'root' })
export class StorageApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/database`;
  }

  overview(): Observable<StorageOverview> {
    return this.http.get<StorageOverview>(`${this.base}/storage`);
  }

  /** Sets (bytes) or removes (bytes null) the budget; the backend applies it at once and answers the new overview. */
  saveBudget(budget: StorageBudget): Observable<StorageOverview> {
    return this.http.put<StorageOverview>(`${this.base}/storage/budget`, budget);
  }

  /** Gives empty space back - every file, or one. Deletes nothing. {@code running}: a big file is still being rewritten in the background. */
  compact(file?: string): Observable<{ freedBytes: number; files: string[]; running: boolean }> {
    const params = file ? new HttpParams().set('file', file) : undefined;
    return this.http.post<{ freedBytes: number; files: string[]; running: boolean }>(`${this.base}/storage/compact`, {}, { params });
  }

  /** apply=false: the dialog's live preview. apply=true: deletes - the caller confirms first. */
  cleanup(request: CleanupRequest, apply: boolean): Observable<CleanupResult> {
    return this.http.post<CleanupResult>(`${this.base}/storage/cleanup`, request, {
      params: new HttpParams().set('apply', String(apply)),
    });
  }

  /** Cheap: free disk and whether it is under the warning rule (the banner every tab shows). */
  disk(): Observable<DiskState> {
    return this.http.get<DiskState>(`${this.base}/storage/disk`);
  }

  /** Where the space goes and what each day added - read when the Biggest or History tab opens. */
  insights(): Observable<StorageInsights> {
    return this.http.get<StorageInsights>(`${this.base}/storage/insights`);
  }

  /** Deletes exactly these calls; a call with a comment stays. The caller confirms first. */
  deleteCalls(inbound: readonly string[], outbound: readonly string[], what: string): Observable<{ count: number; kept: number }> {
    return this.http.post<{ count: number; kept: number }>(`${this.base}/storage/delete-calls`, { inbound, outbound, what });
  }

  star(runId: string, starred: boolean): Observable<{ starred: boolean }> {
    return this.http.put<{ starred: boolean }>(`${this.base}/storage/runs/${encodeURIComponent(runId)}/star`, { starred });
  }

  files(check: boolean): Observable<FileHealth[]> {
    return this.http.get<FileHealth[]>(`${this.base}/storage/files`, { params: new HttpParams().set('check', String(check)) });
  }

  checkpoint(): Observable<{ freedBytes: number }> {
    return this.http.post<{ freedBytes: number }>(`${this.base}/storage/checkpoint`, {});
  }

  backups(): Observable<StorageBackups> {
    return this.http.get<StorageBackups>(`${this.base}/storage/backups`);
  }

  /** The backup, or {running: true} while a big one finishes in the background. */
  backUp(groups: readonly string[]): Observable<StorageBackup | { running: true }> {
    return this.http.post<StorageBackup | { running: true }>(`${this.base}/storage/backups`, { groups });
  }

  backupUrl(name: string): string {
    return `${this.base}/storage/backups/${encodeURIComponent(name)}`;
  }

  deleteBackup(name: string): Observable<void> {
    return this.http.delete<void>(this.backupUrl(name));
  }

  /** Prepares a restore - it replaces the store files at the next start. */
  restore(name: string): Observable<{ files: string[]; from: string }> {
    return this.http.post<{ files: string[]; from: string }>(`${this.backupUrl(name)}/restore`, {});
  }

  /** One raw chunk of a backup .zip; the last answers with the new backup, the others with {received: true}. */
  uploadChunk(id: string, offset: number, total: number, chunk: Blob): Observable<StorageBackup | { received: true }> {
    return this.http.post<StorageBackup | { received: true }>(`${this.base}/storage/backups/upload`, chunk, {
      params: new HttpParams().set('id', id).set('offset', String(offset)).set('total', String(total)),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  cancelRestore(): Observable<void> {
    return this.http.delete<void>(`${this.base}/storage/restore`);
  }

  clearOutbound(): Observable<void> {
    return this.http.post<void>(`${this.base}/clear-calls`, {});
  }

  clearInbound(): Observable<{ deleted: number }> {
    return this.http.post<{ deleted: number }>(`${this.base}/clear-inbound`, {});
  }

  clearCycles(): Observable<void> {
    return this.http.post<void>(`${this.base}/clear-user-cycles`, {});
  }
}
