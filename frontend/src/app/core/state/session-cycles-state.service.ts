import { Injectable, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, Subject, merge, of, timer } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { SessionCycle } from '../models/call.model';
import { NewSessionCycleRequest, SessionCycleUpdateRequest, SessionCyclesApiService } from '../services/session-cycles-api.service';

const POLL_INTERVAL_MS = 5000;

/** Facade for the Session Cycles list tab - polls GET /session-cycles (same 5s pattern CallsStateService uses) and refreshes immediately after any local mutation. */
@Injectable({ providedIn: 'root' })
export class SessionCyclesStateService {
  private readonly api = inject(SessionCyclesApiService);

  private readonly manualRefresh = new Subject<void>();

  private readonly polled$ = merge(timer(0, POLL_INTERVAL_MS), this.manualRefresh).pipe(
    switchMap(() => this.api.list().pipe(catchError(() => of<SessionCycle[]>([]))))
  );

  readonly cycles = toSignal(this.polled$, { initialValue: [] as SessionCycle[] });

  create(request: NewSessionCycleRequest): Observable<SessionCycle> {
    return this.api.create(request).pipe(tap(() => this.refreshNow()));
  }

  update(id: string, request: SessionCycleUpdateRequest): Observable<SessionCycle> {
    return this.api.update(id, request).pipe(tap(() => this.refreshNow()));
  }

  startRecording(id: string): Observable<SessionCycle> {
    return this.api.startRecording(id).pipe(tap(() => this.refreshNow()));
  }

  pauseRecording(id: string): Observable<SessionCycle> {
    return this.api.pauseRecording(id).pipe(tap(() => this.refreshNow()));
  }

  delete(id: string): Observable<void> {
    return this.api.delete(id).pipe(tap(() => this.refreshNow()));
  }

  refreshNow(): void {
    this.manualRefresh.next();
  }
}
