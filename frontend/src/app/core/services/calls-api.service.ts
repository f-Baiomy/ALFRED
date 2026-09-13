import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { CallOverlapQuery, CallsPageResult, CallsQuery } from '../state/call-list-view';
import { CallBaseline, CallDetail, CallDetailPart, CallEndpointSource, CallOverlapCandidate, CallSummaryDto } from '../models/call.model';
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

  /** `serviceNames` (internal only - ignored for 'external') narrows the result to just those named projects (plus "unknown"), server-side - see the Sources bar/CallsStateService.selectedSources. Omitted/empty means no filter, every project. */
  getCalls(query: CallsQuery, source: CallEndpointSource = 'external', serviceNames?: readonly string[]): Observable<CallsPageResult> {
    let params = new HttpParams()
      .set('search', query.search)
      .set('supplier', query.supplier)
      .set('sort', query.sort)
      .set('offset', query.offset)
      .set('limit', query.limit)
      .set('sessionId', query.sessionId)
      .set('operationId', query.operationId)
      .set('requestId', query.requestId);
    if (source === 'internal' && serviceNames?.length) {
      params = params.set('serviceNames', serviceNames.join(','));
    }
    return this.http.get<CallsPageDto>(`${this.config.backendUrl}/${endpointFor(source)}`, { params }).pipe(
      map((page) => ({ calls: page.calls.map((dto) => toCallRecord(dto, source)), total: page.total }))
    );
  }

  /**
   * One call's request/response - fetched only once it's actually expanded, always over the network
   * (no client-side cache - see CALL_LIST_CONTROLS_STATE.getCallDetail).
   *
   * `part` narrows it to a single block, so opening Response headers doesn't drag a multi-megabyte
   * response body across with it. Omitted, the whole detail comes back exactly as before - which is
   * what the export path still wants.
   */
  /**
   * How this endpoint normally performs - only ever fetched when a diagnostics panel is actually
   * expanded, since a list of 200 calls would otherwise fire 200 aggregate queries nobody asked for.
   * Outbound calls only: the baseline is per supplier endpoint, which is a backend-calls concept.
   */
  getBaseline(url: string, source: CallEndpointSource = 'external'): Observable<CallBaseline> {
    return this.http.get<CallBaseline>(`${this.config.backendUrl}/${endpointFor(source)}/baseline`, {
      params: new HttpParams().set('url', url),
    });
  }

  getDetail(callId: string, source: CallEndpointSource = 'external', part?: CallDetailPart): Observable<CallDetail> {
    const options = part ? { params: new HttpParams().set('part', part) } : {};
    return this.http.get<CallDetail>(`${this.config.backendUrl}/${endpointFor(source)}/${callId}/detail`, options);
  }

  /**
   * Every resolved call (external or internal, any project) whose own [timestamp, timestamp +
   * duration_ms] window falls anywhere in `[query.from, query.to]` - the batch call-list-view.ts
   * fetches once per relevant range, not per-call, for the containment check that decides whether
   * an internal call stays split into request/response rows (see splitCallsForDisplay).
   * `serviceNames` mirrors getCalls' own (internal-projects-only) narrowing - the dashboard/session-
   * cycle-detail's currently-selected Sources-bar projects, not the two-DTOs'-worth this endpoint
   * only ever hits once (it returns both external and internal candidates together).
   */
  getCallOverlaps(query: CallOverlapQuery, serviceNames?: readonly string[]): Observable<CallOverlapCandidate[]> {
    let params = new HttpParams()
      .set('from', query.from)
      .set('to', query.to)
      .set('search', query.search)
      .set('supplier', query.supplier)
      .set('sessionId', query.sessionId)
      .set('operationId', query.operationId)
      .set('requestId', query.requestId);
    if (serviceNames?.length) {
      params = params.set('serviceNames', serviceNames.join(','));
    }
    return this.http.get<CallOverlapCandidate[]>(`${this.config.backendUrl}/call-overlaps`, { params });
  }
}
