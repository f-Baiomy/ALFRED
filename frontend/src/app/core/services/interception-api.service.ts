import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  ActionTypeInfo,
  InterceptionRule,
  InterceptionRuleDraft,
  PauseDecision,
  PausedCall,
} from '../models/interception.model';
import { AppConfigService } from './app-config.service';

@Injectable({ providedIn: 'root' })
export class InterceptionApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);

  private get baseUrl(): string {
    return `${this.config.backendUrl}/interception`;
  }

  listRules(): Observable<InterceptionRule[]> {
    return this.http.get<InterceptionRule[]>(`${this.baseUrl}/rules`);
  }

  createRule(draft: InterceptionRuleDraft): Observable<InterceptionRule> {
    return this.http.post<InterceptionRule>(`${this.baseUrl}/rules`, draft);
  }

  updateRule(id: string, draft: InterceptionRuleDraft): Observable<InterceptionRule> {
    return this.http.put<InterceptionRule>(`${this.baseUrl}/rules/${id}`, draft);
  }

  deleteRule(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/rules/${id}`);
  }

  setRuleEnabled(id: string, enabled: boolean): Observable<InterceptionRule> {
    return this.http.post<InterceptionRule>(`${this.baseUrl}/rules/${id}/enabled`, { enabled });
  }

  reorder(ids: readonly string[]): Observable<InterceptionRule[]> {
    return this.http.post<InterceptionRule[]>(`${this.baseUrl}/rules/reorder`, { ids });
  }

  getMasterSwitch(): Observable<{ enabled: boolean }> {
    return this.http.get<{ enabled: boolean }>(`${this.baseUrl}/enabled`);
  }

  setMasterSwitch(enabled: boolean): Observable<{ enabled: boolean }> {
    return this.http.post<{ enabled: boolean }>(`${this.baseUrl}/enabled`, { enabled });
  }

  /** Served by the backend so the action list has exactly one source (see InterceptionRulesController). */
  actionTypes(): Observable<ActionTypeInfo[]> {
    return this.http.get<ActionTypeInfo[]>(`${this.baseUrl}/action-types`);
  }

  listPaused(): Observable<PausedCall[]> {
    return this.http.get<PausedCall[]>(`${this.baseUrl}/paused`);
  }

  /** Stops the countdown on a paused call and holds it until an explicit decision. */
  takeControl(callId: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/paused/${callId}/control`, {});
  }

  decide(callId: string, decision: PauseDecision): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/paused/${callId}/decision`, decision);
  }

  releaseAll(): Observable<{ released: number }> {
    return this.http.post<{ released: number }>(`${this.baseUrl}/paused/release-all`, {});
  }
}
