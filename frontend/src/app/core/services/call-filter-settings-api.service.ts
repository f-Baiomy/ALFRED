import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { CallFilterSettings, FilterMode } from '../models/call-filter-settings.model';
import { AppConfigService } from './app-config.service';

@Injectable({ providedIn: 'root' })
export class CallFilterSettingsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get baseUrl(): string {
    return `${this.config.backendUrl}/settings/call-filtering`;
  }

  get(): Observable<CallFilterSettings> {
    return this.http.get<CallFilterSettings>(this.baseUrl);
  }

  setMode(mode: FilterMode): Observable<CallFilterSettings> {
    return this.http.put<CallFilterSettings>(`${this.baseUrl}/mode`, { mode });
  }

  addWhitelistUrl(host: string): Observable<CallFilterSettings> {
    return this.http.post<CallFilterSettings>(`${this.baseUrl}/whitelist`, { host });
  }

  toggleWhitelistUrl(id: string, enabled: boolean): Observable<CallFilterSettings> {
    return this.http.patch<CallFilterSettings>(`${this.baseUrl}/whitelist/${id}`, { enabled });
  }

  removeWhitelistUrl(id: string): Observable<CallFilterSettings> {
    return this.http.delete<CallFilterSettings>(`${this.baseUrl}/whitelist/${id}`);
  }

  addBlacklistUrl(host: string): Observable<CallFilterSettings> {
    return this.http.post<CallFilterSettings>(`${this.baseUrl}/blacklist`, { host });
  }

  removeBlacklistUrl(id: string): Observable<CallFilterSettings> {
    return this.http.delete<CallFilterSettings>(`${this.baseUrl}/blacklist/${id}`);
  }
}
