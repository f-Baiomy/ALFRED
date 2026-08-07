import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { ExportMetadata } from '../models/export-metadata.model';
import { AppConfigService } from './app-config.service';

/** Asks pennyworth to dig the supplier/credentials/API key out of a call, rather than parsing call internals in the frontend. */
@Injectable({ providedIn: 'root' })
export class ExportApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  fetchMetadata(call: CallRecord): Observable<ExportMetadata> {
    return this.http.post<ExportMetadata>(`${this.config.backendUrl}/calls/export-metadata`, call);
  }
}
