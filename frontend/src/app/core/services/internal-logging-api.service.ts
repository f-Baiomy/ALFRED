import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';

export interface LoggingEnabledDto {
  /** The live on/off switch - whether wildfly-proxy is currently logging. */
  readonly enabled: boolean;
  /** The deploy-time flag (settings.md's inbound_logging_enabled) - false means the feature doesn't exist for this deployment at all (wildfly-proxy was never started), so the Settings panel should be hidden entirely rather than show a live toggle. */
  readonly featureEnabled: boolean;
}

/**
 * Thin wrapper around GET/POST /internal-calls/logging-enabled - lets the Settings page flip the
 * same switch toggle-wildfly-reverse-proxy.sh/.bat already control from a terminal. Forwarding to
 * WildFly through wildfly-proxy is never affected either way, only whether it also logs.
 */
@Injectable({ providedIn: 'root' })
export class InternalLoggingApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  getEnabled(): Observable<LoggingEnabledDto> {
    return this.http.get<LoggingEnabledDto>(`${this.config.backendUrl}/internal-calls/logging-enabled`);
  }

  setEnabled(enabled: boolean): Observable<LoggingEnabledDto> {
    return this.http.post<LoggingEnabledDto>(`${this.config.backendUrl}/internal-calls/logging-enabled`, { enabled });
  }
}
