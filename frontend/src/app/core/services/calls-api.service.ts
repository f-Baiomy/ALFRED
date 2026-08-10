import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { CallsPageResult, CallsQuery } from '../state/call-list-view';

/** Thin HTTP wrapper around backend's GET /calls - no state, no polling, just the request. */
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
    return this.http.get<CallsPageResult>(`${this.config.backendUrl}/calls`, { params });
  }
}
