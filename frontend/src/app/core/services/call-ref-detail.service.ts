import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { CallRecord } from '../models/call.model';
import { CallRef } from '../models/call-ref.model';
import { CallsApiService } from './calls-api.service';
import { SessionCyclesApiService } from './session-cycles-api.service';

/** "Give me this call in full", for any CallRef - the live log or a cycle's captured copy, either direction. */
@Injectable({ providedIn: 'root' })
export class CallRefDetailService {
  private readonly calls = inject(CallsApiService);
  private readonly cycles = inject(SessionCyclesApiService);

  /** Merges the full request/response into the summary the ref was picked with. Always a real fetch. */
  hydrate(ref: CallRef, summary: CallRecord): Observable<CallRecord> {
    const detail = ref.cycleId
      ? this.cycles.getDetail(ref.cycleId, ref.callId, ref.source)
      : this.calls.getDetail(ref.callId, ref.source);
    return detail.pipe(map((d) => ({ ...summary, source: ref.source, ...d })));
  }
}
