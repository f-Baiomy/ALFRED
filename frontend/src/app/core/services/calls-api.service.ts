import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { CallsPageResult, CallsQuery } from '../state/call-list-view';
import { CallDetail, CallEndpointSource, CallSummaryDto } from '../models/call.model';
import { toCallRecord } from '../../shared/utils/call-utils';

interface CallsPageDto {
  readonly calls: readonly CallSummaryDto[];
  readonly total: number;
}

export type { CallEndpointSource };

function endpointFor(source: CallEndpointSource): string {
  return source === 'internal' ? 'internal-calls' : 'calls';
}

/**
 * Thin HTTP wrapper around the backend's call-listing endpoints - no state, no polling, just the
 * requests. Defaults `source` to 'external' everywhere so every pre-existing call site (which never
 * passes a source) keeps hitting GET /calls and GET /calls/{id}/detail exactly as before -
 * backend-internal-calls' GET /internal-calls and GET /internal-calls/{id}/detail mirror those
 * shapes exactly (same CallSummaryDto/CallDetail JSON), so no separate DTO mapping is needed.
 */
@Injectable({ providedIn: 'root' })
export class CallsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  getCalls(query: CallsQuery, source: CallEndpointSource = 'external'): Observable<CallsPageResult> {
    const params = new HttpParams()
      .set('search', query.search)
      .set('supplier', query.supplier)
      .set('sort', query.sort)
      .set('offset', query.offset)
      .set('limit', query.limit)
      .set('sessionId', query.sessionId)
      .set('operationId', query.operationId)
      .set('requestId', query.requestId);
    return this.http.get<CallsPageDto>(`${this.config.backendUrl}/${endpointFor(source)}`, { params }).pipe(
      map((page) => ({ calls: page.calls.map((dto) => toCallRecord(dto, source)), total: page.total }))
    );
  }

  /** The full request/response for one call - fetched only once it's actually expanded, always over the network (no client-side cache - see CALL_LIST_CONTROLS_STATE.getCallDetail). */
  getDetail(callId: string, source: CallEndpointSource = 'external'): Observable<CallDetail> {
    return this.http.get<CallDetail>(`${this.config.backendUrl}/${endpointFor(source)}/${callId}/detail`);
  }
}
