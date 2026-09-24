import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';

export type ResendDirection = 'outbound' | 'inbound';

/** What to change before resending - see backend-resend's ResendEdits. A header set to null removes it. */
export interface ResendEdits {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly body?: string;
}

export interface ResendRequest {
  readonly direction: ResendDirection;
  readonly callId: string;
  readonly cycleId?: string | null;
  readonly edits?: ResendEdits;
  readonly useCurrentSession?: boolean;
}

export interface SessionValueUsed {
  readonly name: string;
  readonly fromCallId: string;
}

export interface ResendResult {
  readonly newCallId: string;
  readonly status: number;
  readonly durationMs: number;
  readonly sessionValuesUsed: readonly SessionValueUsed[];
}

/** POST /resend - see contracts/rest-api.md. */
@Injectable({ providedIn: 'root' })
export class ResendApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  resend(request: ResendRequest): Observable<ResendResult> {
    return this.http.post<ResendResult>(`${this.config.backendUrl}/resend`, {
      direction: request.direction,
      callId: request.callId,
      cycleId: request.cycleId ?? null,
      edits: request.edits ?? null,
      useCurrentSession: request.useCurrentSession ?? false,
    });
  }
}
