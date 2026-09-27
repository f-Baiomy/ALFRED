import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AppConfigService } from './app-config.service';
import { Scenario, ScenarioDefinition, ScenarioRun } from '../../shared/utils/scenario-types';

export interface ScenarioWriteRequest {
  readonly name: string;
  readonly description?: string;
  readonly definition: ScenarioDefinition;
}

/** contracts.md section 3 - GET/POST/PUT/DELETE /scenarios, and its per-scenario runs sub-resource. */
@Injectable({ providedIn: 'root' })
export class ScenarioApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);
  private get base(): string {
    return `${this.config.backendUrl}/scenarios`;
  }

  list(): Observable<Scenario[]> {
    return this.http.get<Scenario[]>(this.base);
  }

  get(id: string): Observable<Scenario> {
    return this.http.get<Scenario>(`${this.base}/${encodeURIComponent(id)}`);
  }

  create(request: ScenarioWriteRequest): Observable<Scenario> {
    return this.http.post<Scenario>(this.base, request);
  }

  update(id: string, request: ScenarioWriteRequest): Observable<Scenario> {
    return this.http.put<Scenario>(`${this.base}/${encodeURIComponent(id)}`, request);
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${encodeURIComponent(id)}`);
  }

  listRuns(scenarioId: string): Observable<ScenarioRun[]> {
    return this.http.get<ScenarioRun[]>(`${this.base}/${encodeURIComponent(scenarioId)}/runs`);
  }

  getRun(scenarioId: string, runId: string): Observable<ScenarioRun> {
    return this.http.get<ScenarioRun>(`${this.base}/${encodeURIComponent(scenarioId)}/runs/${encodeURIComponent(runId)}`);
  }

  /** `run` omits id/scenarioId - the backend assigns both and keeps only the newest 50 per scenario. */
  createRun(scenarioId: string, run: Omit<ScenarioRun, 'id' | 'scenarioId'>): Observable<ScenarioRun> {
    return this.http.post<ScenarioRun>(`${this.base}/${encodeURIComponent(scenarioId)}/runs`, run);
  }
}
