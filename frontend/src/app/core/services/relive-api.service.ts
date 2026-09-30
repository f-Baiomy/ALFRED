import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AppConfigService } from './app-config.service';
import {
  CycleRule,
  CycleVersion,
  LiveCall,
  ReliveCycle,
  ReliveCycleSummary,
  Run,
  StepResult,
  UnattributedChoice,
  ValidationFinding,
} from '../../shared/utils/relive-types';

export type ReliveWriteRequest = Omit<ReliveCycle, 'id' | 'createdAt' | 'updatedAt' | 'transient' | 'lastRun'>;

type WireCycleRule = { readonly rule: Omit<CycleRule, 'copiedFrom'>; readonly copiedFrom: CycleRule['copiedFrom'] };

/** The backend stores a rule document and its origin in separate fields. The editor uses a flat rule. */
function toWireRule(rule: CycleRule): WireCycleRule {
  const { copiedFrom, ...document } = rule;
  return { rule: document, copiedFrom: copiedFrom ?? null };
}

function fromWireRule(value: CycleRule | WireCycleRule): CycleRule {
  if ('rule' in value) return { ...value.rule, copiedFrom: value.copiedFrom } as CycleRule;
  return value;
}

function toWireCycle(cycle: ReliveWriteRequest | ReliveCycle) {
  return {
    ...cycle,
    steps: cycle.steps.map((step) => ({ ...step, callRule: toWireRule(step.callRule) })),
    cycleRules: cycle.cycleRules.map(toWireRule),
    unexpectedCalls: { ...cycle.unexpectedCalls, rules: cycle.unexpectedCalls.rules.map(toWireRule) },
  };
}

function fromWireCycle(cycle: ReliveCycle): ReliveCycle {
  if (!cycle?.steps) return cycle;
  return {
    ...cycle,
    steps: cycle.steps.map((step) => ({ ...step, callRule: fromWireRule(step.callRule) })),
    cycleRules: cycle.cycleRules?.map(fromWireRule) ?? [],
    unexpectedCalls: cycle.unexpectedCalls
      ? { ...cycle.unexpectedCalls, rules: cycle.unexpectedCalls.rules?.map(fromWireRule) ?? [] }
      : cycle.unexpectedCalls,
  };
}

function fromWireRun<T extends Run>(run: T): T {
  return run?.definition ? { ...run, definition: fromWireCycle(run.definition) } : run;
}

export interface StartRunRequest {
  readonly driver: 'AUTOMATIC' | 'GUIDED';
  readonly fromStepKey?: string | null;
  readonly seedFromRunId?: string | null;
  readonly unattributedChoices: Readonly<Record<string, UnattributedChoice>>;
}

/** contracts/rest-api.md - one method per endpoint, in `scenario-api.service.ts`'s style. */
@Injectable({ providedIn: 'root' })
export class ReliveApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(AppConfigService);
  private get base(): string {
    return `${this.config.backendUrl}/relive-cycles`;
  }

  // ---- Cycles ----

  list(): Observable<ReliveCycleSummary[]> {
    return this.http.get<ReliveCycleSummary[]>(this.base);
  }

  get(id: string): Observable<ReliveCycle> {
    return this.http.get<ReliveCycle>(`${this.base}/${encodeURIComponent(id)}`).pipe(map(fromWireCycle));
  }

  create(cycle: ReliveWriteRequest, asTransient = false, deferFingerprint = false): Observable<ReliveCycle> {
    const params: string[] = [];
    if (asTransient) params.push('transient=true');
    if (deferFingerprint) params.push('deferFingerprint=true');
    const url = params.length ? `${this.base}?${params.join('&')}` : this.base;
    return this.http.post<ReliveCycle>(url, toWireCycle(cycle)).pipe(map(fromWireCycle));
  }

  /** Hashes outbound steps that were saved with {@code deferFingerprint}. A second call is cheap.
   *  `rebuild` recomputes every outbound hash to the current algorithm. */
  fingerprint(id: string, rebuild = false): Observable<ReliveCycle> {
    const url = rebuild
      ? `${this.base}/${encodeURIComponent(id)}/fingerprints?rebuild=true`
      : `${this.base}/${encodeURIComponent(id)}/fingerprints`;
    return this.http.post<ReliveCycle>(url, {}).pipe(map(fromWireCycle));
  }

  /** Sets `If-Match` to `ifMatch` (the cycle's last-read `updatedAt`) for optimistic concurrency;
   *  a `reason` snapshots the previous definition as a version first. */
  update(id: string, cycle: ReliveWriteRequest, ifMatch: string, reason?: string): Observable<ReliveCycle> {
    const url = reason ? `${this.base}/${encodeURIComponent(id)}?reason=${encodeURIComponent(reason)}` : `${this.base}/${encodeURIComponent(id)}`;
    const headers = new HttpHeaders({ 'If-Match': ifMatch });
    return this.http.put<ReliveCycle>(url, toWireCycle(cycle), { headers }).pipe(map(fromWireCycle));
  }

  duplicate(id: string, name?: string): Observable<ReliveCycle> {
    return this.http.post<ReliveCycle>(`${this.base}/${encodeURIComponent(id)}/duplicate`, name ? { name } : {}).pipe(map(fromWireCycle));
  }

  delete(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${encodeURIComponent(id)}`);
  }

  validate(id: string): Observable<ValidationFinding[]> {
    return this.http.post<ValidationFinding[]>(`${this.base}/${encodeURIComponent(id)}/validate`, {});
  }

  listVersions(id: string): Observable<CycleVersion[]> {
    return this.http.get<CycleVersion[]>(`${this.base}/${encodeURIComponent(id)}/versions`).pipe(
      map((versions) => versions.map((version) => ({ ...version, definition: fromWireCycle(version.definition) }))),
    );
  }

  restoreVersion(id: string, version: number): Observable<ReliveCycle> {
    return this.http.post<ReliveCycle>(`${this.base}/${encodeURIComponent(id)}/versions/${version}/restore`, {}).pipe(map(fromWireCycle));
  }

  // ---- Runs ----

  startRun(cycleId: string, request: StartRunRequest): Observable<Run> {
    return this.http.post<Run>(`${this.base}/${encodeURIComponent(cycleId)}/runs`, request).pipe(map(fromWireRun));
  }

  listRuns(cycleId: string, limit = 50): Observable<Run[]> {
    return this.http.get<Run[]>(`${this.base}/${encodeURIComponent(cycleId)}/runs?limit=${limit}`).pipe(map((runs) => runs.map(fromWireRun)));
  }

  getRun(cycleId: string, runId: string): Observable<Run & { readonly stepResults: readonly StepResult[]; readonly secrets: readonly string[] }> {
    return this.http.get<Run & { readonly stepResults: readonly StepResult[]; readonly secrets: readonly string[] }>(
      `${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}`,
    ).pipe(map(fromWireRun));
  }

  putStepAttempt(cycleId: string, runId: string, stepKey: string, attempt: number, result: StepResult): Observable<void> {
    return this.http.put<void>(
      `${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepKey)}/attempts/${attempt}`,
      result,
    );
  }

  setVariable(cycleId: string, runId: string, name: string, value: string, stepKey: string | null): Observable<void> {
    return this.http.post<void>(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/variables`, {
      name,
      value,
      stepKey,
    });
  }

  getRunVariables(cycleId: string, runId: string): Observable<Record<string, string>> {
    return this.http.get<Record<string, string>>(
      `${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/variables`,
    );
  }

  stopRun(cycleId: string, runId: string): Observable<Run> {
    return this.http.post<Run>(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/stop`, {}).pipe(map(fromWireRun));
  }

  updateRunDefinition(cycleId: string, runId: string, definition: ReliveCycle, reason: string): Observable<Run> {
    return this.http.put<Run>(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/definition`, {
      definition: toWireCycle(definition),
      reason,
    }).pipe(map(fromWireRun));
  }

  setHold(cycleId: string, runId: string, hold: { stepKey: string; reason: 'FAILED' | 'DIFFERENCES' } | null): Observable<Run> {
    return this.http.put<Run>(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/hold`, hold).pipe(map(fromWireRun));
  }

  resumeRun(cycleId: string, runId: string, afterStepKey: string): Observable<Run> {
    return this.http.post<Run>(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/resume`, { afterStepKey }).pipe(map(fromWireRun));
  }

  finishRun(cycleId: string, runId: string, status: string): Observable<Run> {
    return this.http.post<Run>(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/finish`, { status }).pipe(map(fromWireRun));
  }

  saveStepEdits(cycleId: string, runId: string, stepKey: string, edits: unknown): Observable<ReliveCycle> {
    return this.http.post<ReliveCycle>(
      `${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepKey)}/save-edits`,
      edits,
    ).pipe(map(fromWireCycle));
  }

  compareRuns(cycleId: string, runIdA: string, runIdB: string): Observable<unknown> {
    return this.http.get(`${this.base}/${encodeURIComponent(cycleId)}/runs/${encodeURIComponent(runIdA)}/compare/${encodeURIComponent(runIdB)}`);
  }

  // ---- Live calls ----

  /** `totalBytes` is read off the `X-Live-Calls-Bytes` response header (contracts/rest-api.md,
   *  FR-015c) - the size warning needs it without a separate request. */
  listLiveCalls(cycleId: string, limit = 100): Observable<{ readonly calls: readonly LiveCall[]; readonly totalBytes: number }> {
    return this.http
      .get<LiveCall[]>(`${this.base}/${encodeURIComponent(cycleId)}/live-calls?limit=${limit}`, { observe: 'response' })
      .pipe(map((res) => ({ calls: res.body ?? [], totalBytes: Number(res.headers.get('X-Live-Calls-Bytes') ?? 0) })));
  }

  getLiveCall(cycleId: string, liveId: string): Observable<LiveCall> {
    return this.http.get<LiveCall>(`${this.base}/${encodeURIComponent(cycleId)}/live-calls/${encodeURIComponent(liveId)}`);
  }

  deleteLiveCall(cycleId: string, liveId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/${encodeURIComponent(cycleId)}/live-calls/${encodeURIComponent(liveId)}`);
  }

  useAsRecording(cycleId: string, liveId: string, stepKey: string): Observable<ReliveCycle> {
    return this.http.post<ReliveCycle>(`${this.base}/${encodeURIComponent(cycleId)}/live-calls/${encodeURIComponent(liveId)}/use-as-recording`, {
      stepKey,
    }).pipe(map(fromWireCycle));
  }
}
