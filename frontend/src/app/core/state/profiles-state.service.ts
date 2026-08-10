import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Observable, Subject, merge, of, timer } from 'rxjs';
import { catchError, retry, switchMap, tap } from 'rxjs/operators';
import { webSocket } from 'rxjs/webSocket';
import { Profile } from '../models/profile.model';
import { AppConfigService } from '../services/app-config.service';
import { NewProfileRequest, ProfileUpdateRequest, ProfilesApiService } from '../services/profiles-api.service';

/**
 * Root-provided facade for profiles - fetches GET /profiles once on load, again on any local
 * mutation (create/update/delete, via refreshNow()), and again whenever the backend's
 * /ws/profiles socket signals a change from any client - no polling. Profiles are few and simple
 * enough that this skips the search/sort/pagination machinery CallsStateService/
 * SessionCyclesStateService have; `byId` exists so session-cycles pages can resolve an assignedTo
 * profile id to a display name without each doing its own lookup and fetch.
 */
@Injectable({ providedIn: 'root' })
export class ProfilesStateService {
  private readonly api = inject(ProfilesApiService);
  private readonly config = inject(AppConfigService);

  private readonly manualRefresh = new Subject<void>();

  /** Emits (with no meaningful payload) whenever any client's profile create/update/delete happened - the trigger for a re-fetch, not the data itself. */
  private readonly changed$ = webSocket<unknown>(this.config.backendUrl.replace(/^http/, 'ws') + '/ws/profiles').pipe(
    retry({ delay: () => timer(3000) })
  );

  private readonly polled$ = merge(timer(0), this.manualRefresh, this.changed$).pipe(
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
