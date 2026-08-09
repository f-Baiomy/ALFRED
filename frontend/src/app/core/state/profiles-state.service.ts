import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, Subject, merge, of, timer } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { Profile } from '../models/profile.model';
import { NewProfileRequest, ProfileUpdateRequest, ProfilesApiService } from '../services/profiles-api.service';

const POLL_INTERVAL_MS = 5000;

/**
 * Root-provided facade for profiles - polls GET /profiles on the same 5s pattern as
 * CallsStateService/SessionCyclesStateService. Profiles are few and simple enough that this
 * skips the search/sort/pagination machinery those two have; `byId` exists so session-cycles
 * pages can resolve an assignedTo profile id to a display name without each doing its own lookup
 * and fetch.
 */
@Injectable({ providedIn: 'root' })
export class ProfilesStateService {
  private readonly api = inject(ProfilesApiService);

  private readonly manualRefresh = new Subject<void>();

  private readonly polled$ = merge(timer(0, POLL_INTERVAL_MS), this.manualRefresh).pipe(
    switchMap(() => this.api.list().pipe(catchError(() => of<Profile[]>([]))))
  );

  readonly profiles = toSignal(this.polled$, { initialValue: [] as Profile[] });

  readonly byId = computed(() => new Map(this.profiles().map((p) => [p.id, p] as const)));

  /** Falls back to the raw id if no matching profile is found (e.g. it was since deleted). */
  labelFor(id: string | null): string | null {
    if (!id) return null;
    return this.byId().get(id)?.name ?? id;
  }

  create(request: NewProfileRequest): Observable<Profile> {
    return this.api.create(request).pipe(tap(() => this.refreshNow()));
  }

  update(id: string, request: ProfileUpdateRequest): Observable<Profile> {
    return this.api.update(id, request).pipe(tap(() => this.refreshNow()));
  }

  delete(id: string): Observable<void> {
    return this.api.delete(id).pipe(tap(() => this.refreshNow()));
  }

  refreshNow(): void {
    this.manualRefresh.next();
  }
}
