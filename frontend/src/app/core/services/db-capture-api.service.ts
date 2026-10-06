import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  CallDbCapture,
  CallDbSummary,
  CallStatementsPage,
  CapturedStatement,
  DbCaptureSettings,
  ProjectCaptureStatus,
  RecordedQueryRequest,
  RecordedQueryResult,
  RowsPage,
  RowsPart,
  TableSummary,
  TraceHit,
} from '../models/db-capture.model';

/** /db-capture (specs/006-db-capture/contracts/rest-api.md). Every list is paged; rows load on demand. */
@Injectable({ providedIn: 'root' })
export class DbCaptureApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get base(): string {
    return `${this.config.backendUrl}/db-capture`;
  }

  summaries(callIds: readonly string[]): Observable<Record<string, CallDbSummary>> {
    return this.http.get<Record<string, CallDbSummary>>(`${this.base}/summaries`, {
      params: new HttpParams().set('callIds', callIds.join(',')),
    });
  }

  statements(callId: string, afterSeq = 0, limit = 500): Observable<CallStatementsPage> {
    return this.http.get<CallStatementsPage>(`${this.base}/calls/${encodeURIComponent(callId)}/statements`, {
      params: new HttpParams().set('afterSeq', afterSeq).set('limit', limit),
    });
  }

  outside(thread: string, offset = 0, limit = 200): Observable<CallStatementsPage> {
    return this.http.get<CallStatementsPage>(`${this.base}/outside`, {
      params: new HttpParams().set('thread', thread).set('offset', offset).set('limit', limit),
    });
  }

  statement(id: number): Observable<CapturedStatement> {
    return this.http.get<CapturedStatement>(`${this.base}/statements/${id}`);
  }

  rows(id: number, part: RowsPart, offset: number, limit: number): Observable<RowsPage> {
    return this.http.get<RowsPage>(`${this.base}/statements/${id}/rows`, {
      params: new HttpParams().set('part', part).set('offset', offset).set('limit', limit),
    });
  }

  queryRows(id: number, request: RecordedQueryRequest, part: RowsPart = 'RESULT'): Observable<RecordedQueryResult> {
    return this.http.post<RecordedQueryResult>(`${this.base}/statements/${id}/rows/query`, request, { params: new HttpParams().set('part', part) });
  }

  queryStatements(callId: string, request: RecordedQueryRequest): Observable<RecordedQueryResult> {
    return this.http.post<RecordedQueryResult>(`${this.base}/calls/${encodeURIComponent(callId)}/statements/query`, request);
  }

  trace(callId: string, value: string): Observable<{ readonly hits: readonly TraceHit[] }> {
    return this.http.get<{ readonly hits: readonly TraceHit[] }>(`${this.base}/calls/${encodeURIComponent(callId)}/trace`, {
      params: new HttpParams().set('value', value),
    });
  }

  tables(callId: string): Observable<readonly TableSummary[]> {
    return this.http.get<readonly TableSummary[]>(`${this.base}/calls/${encodeURIComponent(callId)}/tables`);
  }

  projects(): Observable<readonly ProjectCaptureStatus[]> {
    return this.http.get<readonly ProjectCaptureStatus[]>(`${this.base}/projects`);
  }

  setEnabled(project: string, enabled: boolean): Observable<readonly ProjectCaptureStatus[]> {
    return this.http.put<readonly ProjectCaptureStatus[]>(`${this.base}/projects/${encodeURIComponent(project)}/enabled`, { enabled });
  }

  /** The ▤ Logs switch - 409 while the project's inbound logging is off, like ◆. */
  setLogsOn(project: string, on: boolean): Observable<readonly ProjectCaptureStatus[]> {
    return this.http.put<readonly ProjectCaptureStatus[]>(`${this.base}/projects/${encodeURIComponent(project)}/logs`, { on });
  }

  settings(project: string): Observable<DbCaptureSettings> {
    return this.http.get<DbCaptureSettings>(`${this.base}/projects/${encodeURIComponent(project)}/settings`);
  }

  saveSettings(project: string, settings: DbCaptureSettings): Observable<DbCaptureSettings> {
    return this.http.put<DbCaptureSettings>(`${this.base}/projects/${encodeURIComponent(project)}/settings`, settings);
  }

  markExpected(project: string, fingerprint: string): Observable<DbCaptureSettings> {
    return this.http.post<DbCaptureSettings>(`${this.base}/projects/${encodeURIComponent(project)}/expected`, { fingerprint });
  }

  /** Every statement of a call with every stored row - what exports embed. 404 when the call was not captured. */
  exportCall(callId: string): Observable<CallDbCapture> {
    return this.http.get<CallDbCapture>(`${this.base}/calls/${encodeURIComponent(callId)}/export`);
  }

  import(calls: readonly { readonly callId: string; readonly dbCapture: CallDbCapture }[]): Observable<{ readonly imported: number }> {
    return this.http.post<{ readonly imported: number }>(`${this.base}/import`, { calls });
  }
}
