import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, catchError, expand, of, reduce } from 'rxjs';
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

  /** Every linked line of a call, all pages (oldest first); none when the call is unknown. For exports - never cut. */
  allLines(callId: string, cycleId: string | null = null): Observable<readonly LinkedLogLine[]> {
    return this.lines(callId, { cycleId, limit: 500 }).pipe(
      expand((p) => (p.next && p.lines.length ? this.lines(callId, { cycleId, after: p.next, limit: 500 }) : EMPTY)),
      reduce((all, p) => [...all, ...p.lines], [] as LinkedLogLine[]),
      catchError(() => of([] as LinkedLogLine[])),
    );
  }

  /** With `cycleId`, calls the live list no longer has are found through that cycle's copies (and their kept lines). */
  counts(callIds: readonly string[], cycleId: string | null = null): Observable<Readonly<Record<string, LogCounts>>> {
    const params: Record<string, string> = { callIds: callIds.join(',') };
    if (cycleId) params['cycleId'] = cycleId;
    return this.http.get<Record<string, LogCounts>>(`${this.base}/counts`, { params });
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
