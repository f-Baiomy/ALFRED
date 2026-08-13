import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DatabaseStatsResponse } from '../models/database-stats.model';
import { AppConfigService } from './app-config.service';

/** Thin HTTP wrapper around the Database settings tab's backend endpoints - no state, just the requests. */
@Injectable({ providedIn: 'root' })
export class DatabaseStatsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  getStats(): Observable<DatabaseStatsResponse> {
    return this.http.get<DatabaseStatsResponse>(`${this.config.backendUrl}/database/stats`);
  }

  /** Permanently deletes every logged call - irreversible, the caller confirms first. */
  clearCalls(): Observable<void> {
    return this.http.post<void>(`${this.config.backendUrl}/database/clear-calls`, {});
  }

  /** Permanently deletes every session cycle and its captured calls - irreversible, the caller confirms first. */
  clearCycles(): Observable<void> {
    return this.http.post<void>(`${this.config.backendUrl}/database/clear-cycles`, {});
  }
}
