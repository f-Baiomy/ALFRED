import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { NewRedaction, Redaction } from '../models/redaction.model';
import { AppConfigService } from './app-config.service';

@Injectable({ providedIn: 'root' })
export class RedactionsApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  /** Every redaction, not a per-call slice: an `all`-scoped one applies to calls this client may not have fetched yet, so the store keeps one global list and filters locally. */
  listAll(): Observable<Redaction[]> {
    return this.http.get<Redaction[]>(`${this.config.backendUrl}/redactions`);
  }

  create(newRedaction: NewRedaction): Observable<Redaction> {
    return this.http.post<Redaction>(`${this.config.backendUrl}/redactions`, newRedaction);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.config.backendUrl}/redactions/${id}`);
  }
}
