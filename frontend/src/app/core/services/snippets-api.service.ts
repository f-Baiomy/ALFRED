import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  BoardFileInfo, FilePlace, NewSnippetPage, SnippetOwner, SnippetPage, SnippetPageEdit, SnippetShotInfo, SnippetStateValue, SnippetVersionInfo, WidgetInfo,
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

  /** A card's, a cycle's or a project's own pages (every version, with sources), saved values and newest pictures - for the board export. */
  visuals(place: { card?: string; cycle?: string; project?: string }): Observable<{
    pages: { page: SnippetPage; versions: SnippetVersionInfo[] }[]; states: SnippetStateValue[];
    shots: { snippetId: string; version: number; png: string; console: string; at: string }[];
  }> {
    const params: Record<string, string> = place.card ? { card: place.card } : place.cycle ? { cycle: place.cycle } : { project: place.project ?? '' };
    return this.http.get<{
      pages: { page: SnippetPage; versions: SnippetVersionInfo[] }[]; states: SnippetStateValue[];
      shots: { snippetId: string; version: number; png: string; console: string; at: string }[];
    }>(`${this.base}/visuals`, { params });
  }

  // ----------------------------------------------------------------------------------------------- files (R36)

  files(place: { card?: string | null; cycle?: string | null }): Observable<BoardFileInfo[]> {
    return this.http.get<BoardFileInfo[]>(`${this.base}/files`, { params: place.card ? { card: place.card } : { cycle: place.cycle ?? '' } });
  }

  /** The file's bytes as the body; its type comes from its name. */
  attach(place: FilePlace, file: File): Observable<BoardFileInfo> {
    const params: Record<string, string> = 'card' in place ? { card: place.card, name: file.name } : { cycle: place.cycle, project: place.project, name: file.name };
    return this.http.post<BoardFileInfo>(`${this.base}/files`, file, { params, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  fileUrl(id: string): string {
    return `${this.base}/files/${encodeURIComponent(id)}`;
  }

  fileText(id: string): Observable<string> {
    return this.http.get(this.fileUrl(id), { params: { inline: true }, responseType: 'text' });
  }

  fileBlob(id: string): Observable<Blob> {
    return this.http.get(this.fileUrl(id), { responseType: 'blob' });
  }

  removeFile(id: string): Observable<void> {
    return this.http.delete<void>(this.fileUrl(id));
  }

  // --------------------------------------------------------------------------------------------- widgets (R34)

  widgets(project: string): Observable<WidgetInfo[]> {
    return this.http.get<WidgetInfo[]>(`${this.base}/widgets`, { params: { project } });
  }

  widget(project: string, name: string): Observable<WidgetInfo> {
    return this.http.get<WidgetInfo>(`${this.base}/widgets/${encodeURIComponent(name)}`, { params: { project } });
  }

  putWidget(project: string, name: string, w: { kind: string; info: string; source: string }): Observable<WidgetInfo> {
    return this.http.put<WidgetInfo>(`${this.base}/widgets/${encodeURIComponent(name)}`, w, { params: { project } });
  }

  deleteWidget(project: string, name: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/widgets/${encodeURIComponent(name)}`, { params: { project } });
  }
}
