import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { CallRecord, CapturedCall, SessionCycle } from '../models/call.model';
import { AppConfigService } from './app-config.service';

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

  listCalls(id: string): Observable<CapturedCall[]> {
    return this.http.get<CapturedCall[]>(`${this.baseUrl}/${id}/calls`);
  }

  removeCall(id: string, callId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/${id}/calls/${callId}`);
  }

  copyCallsInto(id: string, calls: readonly CallRecord[]): Observable<CopyCallsResult> {
    return this.http.post<CopyCallsResult>(`${this.baseUrl}/${id}/calls/copy`, { calls });
  }
}
