import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  EditAccess,
  EnvImport,
  HistoryEntry,
  ServerSettingsResponse,
  ServerStatus,
  SettingEdit,
  SettingsPreview,
  SettingsSaved,
  UpdateStatus,
  ValidationResult,
} from '../models/server-settings.model';

/** /server/** - the native install's settings (specs/012-server-program contracts/server-api.md). */
@Injectable({ providedIn: 'root' })
export class ServerSettingsService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get baseUrl(): string {
    return `${this.config.backendUrl}/server`;
  }

  access(): Observable<EditAccess> {
    return this.http.get<EditAccess>(`${this.baseUrl}/access`);
  }

  settings(): Observable<ServerSettingsResponse> {
    return this.http.get<ServerSettingsResponse>(`${this.baseUrl}/settings`);
  }

  preview(baseHash: string, edits: SettingEdit[]): Observable<SettingsPreview> {
    return this.http.post<SettingsPreview>(`${this.baseUrl}/settings/preview`, { baseHash, edits });
  }

  save(baseHash: string, edits: SettingEdit[]): Observable<SettingsSaved> {
    return this.http.put<SettingsSaved>(`${this.baseUrl}/settings`, { baseHash, edits });
  }

  check(edits: SettingEdit[], all = false): Observable<{ results: ValidationResult[] }> {
    return this.http.post<{ results: ValidationResult[] }>(`${this.baseUrl}/settings/check`, { edits, all });
  }

  history(limit = 50): Observable<HistoryEntry[]> {
    return this.http.get<HistoryEntry[]>(`${this.baseUrl}/settings/history`, { params: { limit } });
  }

  revert(id: number): Observable<{ edits: SettingEdit[] }> {
    return this.http.post<{ edits: SettingEdit[] }>(`${this.baseUrl}/settings/history/${id}/revert`, {});
  }

  status(): Observable<ServerStatus> {
    return this.http.get<ServerStatus>(`${this.baseUrl}/status`);
  }

  restart(what: 'BACKEND' | 'PROXIES'): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(`${this.baseUrl}/restart`, { what });
  }

  /** Ask the supervisor to attach Alfred's agent to the project's app (the JVM on its upstream port) now. */
  attachAgent(project: string, features: readonly string[], force = true): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(`${this.baseUrl}/agents/attach`, { project, features, force });
  }

  /** The last update check's result, without reading the feed. */
  updateStatus(): Observable<UpdateStatus> {
    return this.http.get<UpdateStatus>(`${this.baseUrl}/update`);
  }

  /** Reads the release feed now (open to read-only viewers: it writes nothing). */
  checkUpdate(): Observable<UpdateStatus> {
    return this.http.post<UpdateStatus>(`${this.baseUrl}/update/check`, {});
  }

  /** Asks the supervisor to download, verify and run the installer of `version` (default: the newest); Alfred restarts. */
  installUpdate(version?: string): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(`${this.baseUrl}/update/install`, version ? { version } : {});
  }

  /** Stops the download and keeps its pieces: the next install of the same release goes on from there. */
  pauseUpdate(): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(`${this.baseUrl}/update/pause`, {});
  }

  /** Stops the download, or drops a paused one, and deletes what was downloaded. */
  cancelUpdate(): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(`${this.baseUrl}/update/cancel`, {});
  }

  /** .env with its secrets hidden, as a file (allowed only where editing is). */
  downloadEnv(): Observable<HttpResponse<Blob>> {
    return this.http.get(`${this.baseUrl}/settings/env-file`, { responseType: 'blob', observe: 'response' });
  }

  /** Reads an uploaded .env into values for the form; writes nothing. */
  importEnv(file: File): Observable<EnvImport> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<EnvImport>(`${this.baseUrl}/settings/import`, form);
  }

  addMissing(): Observable<SettingsSaved> {
    return this.http.post<SettingsSaved>(`${this.baseUrl}/settings/add-missing`, {});
  }
}
