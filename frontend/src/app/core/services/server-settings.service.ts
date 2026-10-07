import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  EditAccess,
  ServerSettingsResponse,
  ServerStatus,
  SettingEdit,
  SettingsPreview,
  SettingsSaved,
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

  status(): Observable<ServerStatus> {
    return this.http.get<ServerStatus>(`${this.baseUrl}/status`);
  }

  restart(what: 'BACKEND' | 'PROXIES'): Observable<{ accepted: boolean }> {
    return this.http.post<{ accepted: boolean }>(`${this.baseUrl}/restart`, { what });
  }

  addMissing(): Observable<SettingsSaved> {
    return this.http.post<SettingsSaved>(`${this.baseUrl}/settings/add-missing`, {});
  }
}
