import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  ActionTypeInfo,
  CopyAnswerRequest,
  InterceptionRule,
  InterceptionRuleDraft,
  PauseDecision,
  PausedCall,
  RuleImportResult,
  StoredAnswer,
} from '../models/interception.model';
import { ExportedAnswer, RulesFile } from '../../shared/utils/interception-rules-file';
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

  /** The secret header and cookie names - the backend's SensitiveHeaders, the only copy there is. */
  sensitiveHeaders(): Observable<string[]> {
    return this.http.get<{ names: string[] }>(`${this.baseUrl}/sensitive-headers`).pipe(map((r) => r.names ?? []));
  }

  /**
   * One request for a whole file, not one per rule. Twenty creates would be twenty round trips,
   * twenty republishes to the proxy and twenty WebSocket pushes each refetching the rule list.
   */
  /** `answers` are the stored answers a version-2 file embeds; the backend gives each a fresh id. */
  importRules(
    rules: readonly InterceptionRuleDraft[],
    enable: boolean,
    answers: readonly ExportedAnswer[] = []
  ): Observable<RuleImportResult> {
    return this.http.post<RuleImportResult>(`${this.baseUrl}/rules/import`, {
      alfredInterceptionRules: 2,
      rules,
      answers,
      enable,
    });
  }

  /**
   * A version-2 rules file, built by the backend because only it has the stored answers' bodies to
   * embed. No ids means every rule.
   */
  exportRules(ids: readonly string[]): Observable<RulesFile> {
    const params = ids.length ? new HttpParams().set('ids', ids.join(',')) : new HttpParams();
    return this.http.get<RulesFile>(`${this.baseUrl}/rules/export`, { params });
  }

  /** Answers 201 with the answer, or 409 `SecretsDecisionRequired` until `keepSecrets` is given. */
  copyAnswerFromCall(request: CopyAnswerRequest): Observable<StoredAnswer> {
    return this.http.post<StoredAnswer>(`${this.baseUrl}/answers/from-call`, request);
  }

  getAnswer(id: string): Observable<StoredAnswer> {
    return this.http.get<StoredAnswer>(`${this.baseUrl}/answers/${encodeURIComponent(id)}`);
  }

  /** Summaries only - no request/response bodies. See getPausedDetail for why. */
  listPaused(): Observable<PausedCall[]> {
    return this.http.get<PausedCall[]>(`${this.baseUrl}/paused`);
  }

  /**
   * One card's bodies, fetched when it is actually opened.
   *
   * The list is re-read on every paused-changed event - several a second while somebody is
   * working, once per open tab - and a card carries a whole request and a whole response, measured
   * at 250-300 KB for a supplier search. Sending them in the list made that response 1.75 MB for
   * six held calls, rebuilt and thrown away several times a second, which exhausted the backend's
   * heap on its own. Same lazy shape the call list already uses (summary in the list, detail on
   * demand).
   */
  getPausedDetail(callId: string): Observable<PausedCall> {
    return this.http.get<PausedCall>(`${this.baseUrl}/paused/${callId}`);
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

  /** Dismisses one card. 409 while that call still holds its caller - decide on it first. */
  closeCard(callId: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/paused/${callId}`);
  }

  closeFinished(): Observable<{ closed: number }> {
    return this.http.post<{ closed: number }>(`${this.baseUrl}/paused/close-finished`, {});
  }
}
