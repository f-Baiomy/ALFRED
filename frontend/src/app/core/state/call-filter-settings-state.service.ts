import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { CallFilterSettings, FilterMode } from '../models/call-filter-settings.model';
import { CallFilterSettingsApiService } from '../services/call-filter-settings-api.service';

const EMPTY_SETTINGS: CallFilterSettings = { mode: 'ACCEPT_ALL', whitelist: [], blacklist: [] };

/**
 * Root-provided facade for the call-filtering settings. Unlike the list-shaped state services
 * (ProfilesStateService et al.), this wraps a single object every mutation endpoint already
 * returns in full - each call() below applies that response straight to the signal, so there's
 * no need for a separate refetch or a change-notification WebSocket the way a shared list would.
 */
@Injectable({ providedIn: 'root' })
export class CallFilterSettingsStateService {
  private readonly api = inject(CallFilterSettingsApiService);

  private readonly settingsSignal = signal<CallFilterSettings>(EMPTY_SETTINGS);
  private readonly loadedSignal = signal(false);

  readonly settings = this.settingsSignal.asReadonly();
  readonly loaded = this.loadedSignal.asReadonly();

  loadIfNeeded(): void {
    if (this.loadedSignal()) return;
    this.api.get().subscribe((settings) => {
      this.settingsSignal.set(settings);
      this.loadedSignal.set(true);
    });
  }

  setMode(mode: FilterMode): Observable<CallFilterSettings> {
    return this.api.setMode(mode).pipe(tap((settings) => this.settingsSignal.set(settings)));
  }

  addWhitelistUrl(host: string): Observable<CallFilterSettings> {
    return this.api.addWhitelistUrl(host).pipe(tap((settings) => this.settingsSignal.set(settings)));
  }

  toggleWhitelistUrl(id: string, enabled: boolean): Observable<CallFilterSettings> {
    return this.api.toggleWhitelistUrl(id, enabled).pipe(tap((settings) => this.settingsSignal.set(settings)));
  }

  removeWhitelistUrl(id: string): Observable<CallFilterSettings> {
    return this.api.removeWhitelistUrl(id).pipe(tap((settings) => this.settingsSignal.set(settings)));
  }

  addBlacklistUrl(host: string): Observable<CallFilterSettings> {
    return this.api.addBlacklistUrl(host).pipe(tap((settings) => this.settingsSignal.set(settings)));
  }

  removeBlacklistUrl(id: string): Observable<CallFilterSettings> {
    return this.api.removeBlacklistUrl(id).pipe(tap((settings) => this.settingsSignal.set(settings)));
  }
}
