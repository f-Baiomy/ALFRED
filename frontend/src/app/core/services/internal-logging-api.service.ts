import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';

export interface InternalCallServiceDto {
  readonly name: string;
  /** Alfred's own port for this project - what callers use. null only for the reserved "unknown" entry. */
  readonly listenPort: number | null;
  /** The project's own, unchanged port that Alfred forwards to. null only for "unknown". */
  readonly upstreamPort: number | null;
  /** Live, independently-toggleable on/off switch for this name alone. */
  readonly enabled: boolean;
}

export interface FeatureEnabledDto {
  /** The deploy-time flag (settings.properties's reverse_proxy_enabled) - false means the feature doesn't exist for this deployment at all (reverse-proxy was never started), so the Settings panel should be hidden entirely. */
  readonly enabled: boolean;
}

/**
 * Thin wrapper around GET /internal-calls/feature-enabled, GET /internal-calls/services, and
 * POST /internal-calls/services/{name}/logging-enabled - lets the Settings page flip the same
 * per-project switches toggle-wildfly-reverse-proxy.sh/.bat already control from a terminal.
 * Forwarding to a project's upstream through reverse-proxy is never affected either way, only
 * whether that one name also gets logged.
 */
@Injectable({ providedIn: 'root' })
export class InternalLoggingApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  getFeatureEnabled(): Observable<FeatureEnabledDto> {
    return this.http.get<FeatureEnabledDto>(`${this.config.backendUrl}/internal-calls/feature-enabled`);
  }

  getServices(): Observable<InternalCallServiceDto[]> {
    return this.http.get<InternalCallServiceDto[]>(`${this.config.backendUrl}/internal-calls/services`);
  }

  setEnabled(name: string, enabled: boolean): Observable<InternalCallServiceDto[]> {
    return this.http.post<InternalCallServiceDto[]>(
      `${this.config.backendUrl}/internal-calls/services/${encodeURIComponent(name)}/logging-enabled`,
      { enabled },
    );
  }
}
