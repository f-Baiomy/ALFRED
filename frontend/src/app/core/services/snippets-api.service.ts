import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  NewSnippetPage, SnippetOwner, SnippetPage, SnippetPageEdit, SnippetShotInfo, SnippetStateValue, SnippetVersionInfo,
} from '../models/snippet.models';
import { AppConfigService } from './app-config.service';

/** Pages, versions, saved state and shots (specs/017 R23, R28-R32). */
@Injectable({ providedIn: 'root' })
export class SnippetsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/board`;
  }

  private one(id: string): string {
    return `${this.base}/snippets/${encodeURIComponent(id)}`;
  }

  pages(owner: SnippetOwner, project?: string | null): Observable<SnippetPage[]> {
    return this.http.get<SnippetPage[]>(`${this.base}/pages`, { params: project ? { owner, project } : { owner } });
  }

  create(page: NewSnippetPage): Observable<SnippetPage> {
    return this.http.post<SnippetPage>(`${this.base}/pages`, page);
  }

  page(id: string, version?: number): Observable<SnippetPage> {
    return this.http.get<SnippetPage>(this.one(id), version == null ? {} : { params: { version } });
  }

  update(id: string, edit: SnippetPageEdit): Observable<SnippetPage> {
    return this.http.put<SnippetPage>(this.one(id), edit);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(this.one(id));
  }

  versions(id: string): Observable<SnippetVersionInfo[]> {
    return this.http.get<SnippetVersionInfo[]>(`${this.one(id)}/versions`);
  }

  state(id: string): Observable<SnippetStateValue[]> {
    return this.http.get<SnippetStateValue[]>(`${this.one(id)}/state`);
  }

  /** `value` undefined/null removes the key. */
  putState(id: string, key: string, value: unknown): Observable<SnippetStateValue | null> {
    return this.http.put<SnippetStateValue | null>(`${this.one(id)}/state/${encodeURIComponent(key)}`, { value: value ?? null });
  }

  stateHistory(id: string, key: string): Observable<SnippetStateValue[]> {
    return this.http.get<SnippetStateValue[]>(`${this.one(id)}/state/${encodeURIComponent(key)}/history`);
  }

  putShot(id: string, version: number, png: string, console: readonly string[]): Observable<void> {
    return this.http.post<void>(`${this.one(id)}/shot`, { version, png, console });
  }

  /** `withPicture` false: only version, console and time (to know whether a new shot is needed). */
  shot(id: string, withPicture = true): Observable<SnippetShotInfo> {
    return this.http.get<SnippetShotInfo>(`${this.one(id)}/shot`, withPicture ? {} : { params: { png: false } });
  }
}
