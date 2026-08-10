import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { CallRecord, CapturedCall, SessionCycle } from '../models/call.model';
import { AppConfigService } from './app-config.service';
import { CallsQuery } from '../state/call-list-view';

export interface NewSessionCycleRequest {
  readonly name: string;
  readonly assignedTo?: string | null;
}

export interface SessionCycleUpdateRequest {
  readonly name?: string;
  readonly assignedTo?: string | null;
}

export interface CopyCallsResult {
  readonly added: number;
  readonly skipped: number;
}

/** GET /session-cycles/{id}/calls' paged response shape - CapturedCall items, not bare CallRecord. */
export interface CapturedCallsPageResult {
  readonly calls: readonly CapturedCall[];
  readonly total: number;
}

@Injectable({ providedIn: 'root' })
export class SessionCyclesApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get baseUrl(): string {
    return `${this.config.backendUrl}/session-cycles`;
  }

  list(): Observable<SessionCycle[]> {
    return this.http.get<SessionCycle[]>(this.baseUrl);
  }

  create(request: NewSessionCycleRequest): Observable<SessionCycle> {
    return this.http.post<SessionCycle>(this.baseUrl, request);
  }

  update(id: string, request: SessionCycleUpdateRequest): Observable<SessionCycle> {
    return this.http.patch<SessionCycle>(`${this.baseUrl}/${id}`, request);
  }

  startRecording(id: string): Observable<SessionCycle> {
    return this.http.post<SessionCycle>(`${this.baseUrl}/${id}/record`, {});
  }

  pauseRecording(id: string): Observable<SessionCycle> {
    return this.http.post<SessionCycle>(`${this.baseUrl}/${id}/pause`, {});
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}`);
  }

  listCalls(id: string, query: CallsQuery): Observable<CapturedCallsPageResult> {
    const params = new HttpParams()
      .set('search', query.search)
      .set('supplier', query.supplier)
      .set('sort', query.sort)
      .set('offset', query.offset)
      .set('limit', query.limit);
    return this.http.get<CapturedCallsPageResult>(`${this.baseUrl}/${id}/calls`, { params });
  }

  removeCall(id: string, callId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/calls/${callId}`);
  }

  copyCallsInto(id: string, calls: readonly CallRecord[]): Observable<CopyCallsResult> {
    return this.http.post<CopyCallsResult>(`${this.baseUrl}/${id}/calls/copy`, { calls });
  }
}
