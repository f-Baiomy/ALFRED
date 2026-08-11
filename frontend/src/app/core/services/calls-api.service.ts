import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { CallsPageResult, CallsQuery } from '../state/call-list-view';
import { CallDetail, CallSummaryDto } from '../models/call.model';
import { toCallRecord } from '../../shared/utils/call-utils';

interface CallsPageDto {
  readonly calls: readonly CallSummaryDto[];
  readonly total: number;
}

/** Thin HTTP wrapper around backend's GET /calls and GET /calls/{id}/detail - no state, no polling, just the requests. */
@Injectable({ providedIn: 'root' })
export class CallsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  getCalls(query: CallsQuery): Observable<CallsPageResult> {
    const params = new HttpParams()
      .set('search', query.search)
      .set('supplier', query.supplier)
      .set('sort', query.sort)
      .set('offset', query.offset)
      .set('limit', query.limit);
    return this.http.get<CallsPageDto>(`${this.config.backendUrl}/calls`, { params }).pipe(
      map((page) => ({ calls: page.calls.map(toCallRecord), total: page.total }))
    );
  }

  /** The full request/response for one call - fetched only once it's actually expanded, see CallDetailCacheService. */
  getDetail(callId: string): Observable<CallDetail> {
    return this.http.get<CallDetail>(`${this.config.backendUrl}/calls/${callId}/detail`);
  }
}
