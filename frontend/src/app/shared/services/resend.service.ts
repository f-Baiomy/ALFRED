import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ResendMetadata, ResendOutcome } from '../model/resend';

/** Frontend API service for resend operations. */
@Injectable({
  providedIn: 'root'
})
export class ResendService {
  private readonly API_URL = window.location.origin;

  constructor(private http: HttpClient) {}

  /**
   * Fetch resend metadata for a call (whether it can be resent, what headers were edited, etc).
   * Used by the resend editor to pre-fill UI state.
   */
  getResendMetadata(callId: string): Observable<ResendMetadata> {
    return this.http.get<ResendMetadata>(`${this.API_URL}/calls/${callId}/resend`);
  }

  /**
   * Record outcome after a resend was executed (called by proxy webhook).
   * Backend tracks the relationship: newCallId -> originalCallId via resend_of field.
   */
  recordResendOutcome(
    resendRequestId: string,
    originalCallId: string,
    newCallId: string
  ): Observable<void> {
    const payload = {
      resend_request_id: resendRequestId,
      original_call_id: originalCallId,
      new_call_id: newCallId
    };
    return this.http.post<void>(`${this.API_URL}/calls/resend/recorded`, payload);
  }

  /**
   * Helper: construct X-Alfred-Resend-Of and X-Alfred-Resend-Edits headers
   * for a resend request based on which headers were edited.
   */
  buildResendHeaders(
    originalCallId: string,
    editedHeaders?: Set<string>
  ): HttpHeaders {
    let headers = new HttpHeaders({
      'X-Alfred-Resend-Of': originalCallId
    });

    if (editedHeaders && editedHeaders.size > 0) {
      const editsMap: { [key: string]: boolean } = {};
      editedHeaders.forEach(h => {
        editsMap[h] = true;
      });
      headers = headers.set('X-Alfred-Resend-Edits', JSON.stringify(editsMap));
    }

    return headers;
  }
}
