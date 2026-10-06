import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { CallLogsPage, LineCall, LinkedLogLine, LogCounts, ProjectLogSettings, ProjectLogsView } from '../models/call-logs.model';
import { AppConfigService } from './app-config.service';

/** `/call-logs` (specs/008-logs-call-link/contracts/call-logs-api.md). */
@Injectable({ providedIn: 'root' })
export class CallLogsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/call-logs`;
  }

  lines(callId: string, opts: { cycleId?: string | null; after?: string | null; limit?: number } = {}): Observable<CallLogsPage> {
    const params: Record<string, string> = {};
    if (opts.cycleId) params['cycleId'] = opts.cycleId;
    if (opts.after) params['after'] = opts.after;
    if (opts.limit) params['limit'] = String(opts.limit);
    return this.http.get<CallLogsPage>(`${this.base}/${encodeURIComponent(callId)}`, { params });
  }

  counts(callIds: readonly string[]): Observable<Readonly<Record<string, LogCounts>>> {
    return this.http.get<Record<string, LogCounts>>(`${this.base}/counts`, { params: { callIds: callIds.join(',') } });
  }

  forLine(sourceId: string, lineId: string): Observable<LineCall | null> {
    return this.http.get<LineCall | null>(`${this.base}/for-line`, { params: { sourceId, lineId } });
  }

  settings(project: string): Observable<ProjectLogsView> {
    return this.http.get<ProjectLogsView>(`${this.base}/settings/${encodeURIComponent(project)}`);
  }

  saveSettings(project: string, settings: Omit<ProjectLogSettings, 'project'>): Observable<ProjectLogsView> {
    return this.http.put<ProjectLogsView>(`${this.base}/settings/${encodeURIComponent(project)}`, settings);
  }

  /** An imported call's lines, kept as ALFRED's own copies (at most 20,000 per request). */
  importLines(callId: string, lines: readonly LinkedLogLine[]): Observable<void> {
    return this.http.post<void>(`${this.base}/import`, { callId, lines });
  }
}
