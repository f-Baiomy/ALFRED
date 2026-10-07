import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import {
  CallDbCapture,
  CallDbSummary,
  CallStatementsPage,
  OutsideLogLine,
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
import { CallStoreSummary, KeyHistoryRow, KeyPatternRow, StoreCommand, StoreCommandsPage } from '../models/store-command.model';

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

  /** Lines the agent caught outside any call (specs/009-agent-log-capture), oldest first. */
  outsideLogs(project: string | null, after = 0, limit = 500): Observable<readonly OutsideLogLine[]> {
    const params: Record<string, string> = { after: String(after), limit: String(limit) };
    if (project) params['project'] = project;
    return this.http.get<OutsideLogLine[]>(`${this.base}/outside/logs`, { params });
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

  // ---- Redis (specs/011-redis-capture, contracts/store-commands-api.md)

  setRedisOn(project: string, on: boolean): Observable<readonly ProjectCaptureStatus[]> {
    return this.http.put<readonly ProjectCaptureStatus[]>(`${this.base}/projects/${encodeURIComponent(project)}/redis`, { on });
  }

  storeCommands(callId: string, offset = 0, limit = 500): Observable<StoreCommandsPage> {
    return this.http.get<StoreCommandsPage>(`${this.base}/calls/${encodeURIComponent(callId)}/store-commands`, {
      params: new HttpParams().set('offset', offset).set('limit', limit),
    });
  }

  storeCommand(id: number, raw = false): Observable<StoreCommand> {
    return this.http.get<StoreCommand>(`${this.base}/store-commands/${id}`, { params: new HttpParams().set('raw', raw) });
  }

  storeKeys(callId: string): Observable<readonly KeyPatternRow[]> {
    return this.http.get<readonly KeyPatternRow[]>(`${this.base}/calls/${encodeURIComponent(callId)}/store-keys`);
  }

  keyHistory(project: string | null, key: string, limit = 50): Observable<readonly KeyHistoryRow[]> {
    let params = new HttpParams().set('key', key).set('limit', limit);
    if (project) params = params.set('project', project);
    return this.http.get<readonly KeyHistoryRow[]>(`${this.base}/store-keys/history`, { params });
  }

  /** redis-cli lines for the call's commands (all, or these seqs) - quoted and escaped by the backend's one implementation. */
  redisCli(callId: string, seqs: readonly number[] = []): Observable<string> {
    return this.http.get(`${this.base}/calls/${encodeURIComponent(callId)}/store-commands/redis-cli`, {
      params: new HttpParams().set('seq', seqs.join(',')), responseType: 'text',
    });
  }

  storeSummaries(callIds: readonly string[]): Observable<Record<string, CallStoreSummary>> {
    return this.http.get<Record<string, CallStoreSummary>>(`${this.base}/store/summaries`, {
      params: new HttpParams().set('callIds', callIds.join(',')),
    });
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
