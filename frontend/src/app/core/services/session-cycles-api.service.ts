import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, map } from 'rxjs';
import { CallDetail, CallDetailPart, CallEndpointSource, CallOverlapCandidate, CallRecord, CallSummaryDto, CapturedCall, SessionCycle } from '../models/call.model';
import { AppConfigService } from './app-config.service';
import { CallOverlapQuery, CallsQuery } from '../state/call-list-view';
import { toCallRecord } from '../../shared/utils/call-utils';
import { CycleSpacer } from '../state/call-selection.tokens';

/** Mirrors CallsApiService's endpointFor - 'internal' routes to the parallel /session-cycles/{id}/internal-calls* resource, 'external' (the default everywhere below) keeps hitting today's /session-cycles/{id}/calls*. */
function endpointSegmentFor(source: CallEndpointSource): string {
  return source === 'internal' ? 'internal-calls' : 'calls';
}

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

  /** `serviceNames` (internal only - ignored for 'external') narrows the result to just those named projects (plus "unknown"), server-side - see the Sources bar/SessionCycleDetailStateService.selectedSources. Omitted/empty means no filter, every project. */
  listCalls(id: string, query: CallsQuery, source: CallEndpointSource = 'external', serviceNames?: readonly string[]): Observable<CapturedCallsPageResult> {
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
    return this.http.get<CapturedCallsPageDto>(`${this.baseUrl}/${id}/${endpointSegmentFor(source)}`, { params }).pipe(
      map((page) => ({
        calls: page.calls.map((c) => ({ id: c.id, capturedAt: c.capturedAt, call: toCallRecord(c.call, source) })),
        total: page.total,
      }))
    );
  }

  /**
   * One captured call's request/response - fetched only once it's actually expanded, always over
   * the network (no client-side cache - see CALL_LIST_CONTROLS_STATE.getCallDetail). `part` narrows
   * it to a single block, mirroring CallsApiService.getDetail.
   */
  getDetail(cycleId: string, callId: string, source: CallEndpointSource = 'external', part?: CallDetailPart): Observable<CallDetail> {
    const options = part ? { params: new HttpParams().set('part', part) } : {};
    return this.http.get<CallDetail>(`${this.baseUrl}/${cycleId}/${endpointSegmentFor(source)}/${callId}/detail`, options);
  }

  /** Mirrors CallsApiService.getCallOverlaps, scoped to this cycle's captured calls - see its doc. */
  getCallOverlaps(cycleId: string, query: CallOverlapQuery, serviceNames?: readonly string[]): Observable<CallOverlapCandidate[]> {
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
    return this.http.get<CallOverlapCandidate[]>(`${this.baseUrl}/${cycleId}/call-overlaps`, { params });
  }

  removeCall(id: string, callId: string, source: CallEndpointSource = 'external'): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/${endpointSegmentFor(source)}/${callId}`);
  }

  /** Bulk counterpart to removeCall - one request instead of one DELETE per selected call. */
  removeCalls(id: string, callIds: readonly string[], source: CallEndpointSource = 'external'): Observable<RemoveCallsResult> {
    return this.http.post<RemoveCallsResult>(`${this.baseUrl}/${id}/${endpointSegmentFor(source)}/remove`, { callIds });
  }

  /** Wipes every captured call (external and internal) for this cycle in one request - the cycle itself (name/status/assignee) is untouched. */
  clearCalls(id: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/${id}/calls/clear`, {});
  }

  /**
   * {@code calls} must already be fully hydrated (request/response present) - copying stores the
   * complete CallRecord, not a summary. Callers hydrate the selection first (see
   * BulkActionsBarComponent.hydrateAll). A selection built from a 'both'-mode list can mix
   * external- and internal-sourced calls, each of which only exists in its own backend store - so
   * this groups by each call's own stamped `source` (defaulting to 'external' for a call that
   * predates the source toggle) and issues one POST per group, to /calls/copy or
   * /internal-calls/copy respectively, then sums the added/skipped counts back into one result.
   */
  copyCallsInto(id: string, calls: readonly CallRecord[]): Observable<CopyCallsResult> {
    const bySource = new Map<CallEndpointSource, CallRecord[]>();
    for (const call of calls) {
      const source = call.source ?? 'external';
      const group = bySource.get(source);
      if (group) {
        group.push(call);
      } else {
        bySource.set(source, [call]);
      }
    }

    const requests = [...bySource.entries()].map(([source, group]) =>
      this.http.post<CopyCallsResult>(`${this.baseUrl}/${id}/${endpointSegmentFor(source)}/copy`, { calls: group })
    );
    return forkJoin(requests).pipe(
      map((results) => results.reduce((acc, r) => ({ added: acc.added + r.added, skipped: acc.skipped + r.skipped }), { added: 0, skipped: 0 }))
    );
  }

  /** Every spacer for this cycle - never paginated, a cycle has at most a handful. */
  listSpacers(id: string): Observable<CycleSpacer[]> {
    return this.http.get<CycleSpacer[]>(`${this.baseUrl}/${id}/spacers`);
  }

  createSpacer(id: string, label: string, beforeCallId: string | null): Observable<CycleSpacer> {
    return this.http.post<CycleSpacer>(`${this.baseUrl}/${id}/spacers`, { label, beforeCallId });
  }

  renameSpacer(id: string, spacerId: string, label: string): Observable<CycleSpacer> {
    return this.http.patch<CycleSpacer>(`${this.baseUrl}/${id}/spacers/${spacerId}`, { label });
  }

  /** Re-anchors a spacer next to a different captured call - the backend half of dragging a spacer around in the call list. */
  moveSpacer(id: string, spacerId: string, beforeCallId: string | null): Observable<CycleSpacer> {
    return this.http.patch<CycleSpacer>(`${this.baseUrl}/${id}/spacers/${spacerId}/move`, { beforeCallId });
  }

  deleteSpacer(id: string, spacerId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/spacers/${spacerId}`);
  }
}
