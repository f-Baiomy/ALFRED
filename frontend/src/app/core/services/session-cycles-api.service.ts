import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { CallDetail, CallRecord, CallSummaryDto, CapturedCall, SessionCycle } from '../models/call.model';
import { AppConfigService } from './app-config.service';
import { CallsQuery } from '../state/call-list-view';
import { toCallRecord } from '../../shared/utils/call-utils';

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

export interface RemoveCallsResult {
  readonly removed: number;
  readonly notFound: number;
}

interface CapturedCallSummaryDto {
  readonly id: string;
  readonly capturedAt: string;
  readonly call: CallSummaryDto;
}

interface CapturedCallsPageDto {
  readonly calls: readonly CapturedCallSummaryDto[];
  readonly total: number;
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
    return this.http.get<CapturedCallsPageDto>(`${this.baseUrl}/${id}/calls`, { params }).pipe(
      map((page) => ({
        calls: page.calls.map((c) => ({ id: c.id, capturedAt: c.capturedAt, call: toCallRecord(c.call) })),
        total: page.total,
      }))
    );
  }

  /** The full request/response for one captured call - fetched only once it's actually expanded, always over the network (no client-side cache - see CALL_LIST_CONTROLS_STATE.getCallDetail). */
  getDetail(cycleId: string, callId: string): Observable<CallDetail> {
    return this.http.get<CallDetail>(`${this.baseUrl}/${cycleId}/calls/${callId}/detail`);
  }

  removeCall(id: string, callId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/calls/${callId}`);
  }

  /** Bulk counterpart to removeCall - one request instead of one DELETE per selected call. */
  removeCalls(id: string, callIds: readonly string[]): Observable<RemoveCallsResult> {
    return this.http.post<RemoveCallsResult>(`${this.baseUrl}/${id}/calls/remove`, { callIds });
  }

  /** {@code calls} must already be fully hydrated (request/response present) - copying stores the complete CallRecord, not a summary. Callers hydrate the selection first (see BulkActionsBarComponent.hydrateAll). */
  copyCallsInto(id: string, calls: readonly CallRecord[]): Observable<CopyCallsResult> {
    return this.http.post<CopyCallsResult>(`${this.baseUrl}/${id}/calls/copy`, { calls });
  }
}
