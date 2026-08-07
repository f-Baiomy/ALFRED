import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { AppConfigService } from './app-config.service';

/** Thin HTTP wrapper around pennyworth's GET /calls - no state, no polling, just the request. */
@Injectable({ providedIn: 'root' })
export class CallsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  getCalls(limit: number): Observable<CallRecord[]> {
    return this.http.get<CallRecord[]>(`${this.config.backendUrl}/calls?limit=${limit}`);
  }
}
