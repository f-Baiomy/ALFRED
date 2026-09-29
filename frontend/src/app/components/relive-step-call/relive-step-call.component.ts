import { Component, Injectable, computed, effect, forwardRef, inject, input, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { CallCardComponent } from '../call-card/call-card.component';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallDetail, CallDetailPart, CallEndpointSource, CallLifecycleState, CallRecord } from '../../core/models/call.model';
import { CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE, CallListControlsState, CallSelectionState } from '../../core/state/call-selection.tokens';
import { CallsQuery } from '../../core/state/call-list-view';
import { Step, StepResult, StepState } from '../../shared/utils/relive-types';

const IN_PROGRESS: ReadonlySet<StepState> = new Set(['RUNNING', 'REPLAYED', 'LIVE', 'WAITING', 'INTERCEPTED']);

const NO_SELECTION: CallSelectionState = {
  isSelected: () => false,
  toggleSelected: () => undefined,
  startDragSelect: () => undefined,
  dragSelectOver: () => undefined,
  endDragSelect: () => undefined,
  subtreeSelection: () => 'none',
  setSubtreeSelected: () => undefined,
};

interface HttpParts {
  readonly method?: string;
  readonly url?: string;
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** The card asks this for headers and bodies. A logged call uses the same detail endpoint as Live Calls. */
@Injectable()
class ReliveStepCallControls {
  host?: ReliveStepCallComponent;
  readonly expanded = computed(() => false);
  readonly collapseAllVersion = computed(() => 0);

  getCallDetail(callId: string, source?: CallEndpointSource, part?: CallDetailPart): Observable<CallDetail> {
    return this.host?.detail(callId, source, part) ?? of({});
  }
}

/**
 * The Live Calls card for one relive step. A run looks up the call that execution logged
 * (`X-Operation-Id: relive-<runId>-<stepKey>`). The Steps tab looks up the call the step was
 * recorded from. Either way the card, its interception diff, and its resend trail are the logged
 * call. The stored step payload is only the fallback when that call is not in the log.
 */
@Component({
  selector: 'app-relive-step-call',
  standalone: true,
  imports: [CallCardComponent],
  template: `
    @if (record(); as call) {
      <app-call-card [call]="call" />
    } @else if (!settled()) {
      <div class="rl-faint">Loading the call…</div>
    }
  `,
  providers: [
    ReliveStepCallControls,
    { provide: CALL_SELECTION_STATE, useValue: NO_SELECTION },
    {
      provide: CALL_LIST_CONTROLS_STATE,
      useFactory: (controls: ReliveStepCallControls): CallListControlsState => controls as unknown as CallListControlsState,
      deps: [forwardRef(() => ReliveStepCallControls)],
    },
  ],
})
export class ReliveStepCallComponent {
  private readonly callsApi = inject(CallsApiService);

  readonly step = input.required<Step>();
  /** Absent on the Steps tab, which shows the recorded call rather than one run's attempt. */
  readonly result = input<StepResult | null>(null);

  private readonly logged = signal<CallRecord | null>(null);
  readonly settled = signal(false);
  readonly record = computed(() => {
    const logged = this.logged();
    if (logged) return logged;
    if (!this.settled()) return null;
    const result = this.result();
    return result ? stepCallRecord(this.step(), result) : null;
  });

  constructor() {
    inject(ReliveStepCallControls).host = this;
    effect((onCleanup) => {
      const step = this.step();
      const result = this.result();
      this.logged.set(null);
      this.settled.set(false);
      const sub = resolveLoggedCall(this.callsApi, step, result).subscribe((call) => {
        this.logged.set(call);
        this.settled.set(true);
      });
      onCleanup(() => sub.unsubscribe());
    }, { allowSignalWrites: true });
  }

  detail(callId: string, source?: CallEndpointSource, part?: CallDetailPart): Observable<CallDetail> {
    const logged = this.logged();
    if (logged && logged.id === callId) {
      return this.callsApi.getDetail(callId, source ?? logged.source ?? 'external', part);
    }
    const result = this.result();
    return result ? of(stepCallDetail(this.step(), result, part)) : of({});
  }
}

/** The operation id ResendService stamps on the call this step made. */
export function reliveOperationId(runId: string, stepKey: string): string {
  return `relive-${runId}-${stepKey}`;
}

export function resolveLoggedCall(api: CallsApiService, step: Step, result: StepResult | null): Observable<CallRecord | null> {
  if (result?.runId) {
    const operationId = reliveOperationId(result.runId, step.key);
    const primary = endpointSource(step);
    return findByOperation(api, operationId, primary, result).pipe(
      switchMap((found) => (found ? of(found) : findByOperation(api, operationId, otherSource(primary), result))),
    );
  }
  if (!step.source.callId) return of(null);
  const primary = endpointSource(step);
  return summary(api, step.source.callId, primary).pipe(
    switchMap((found) => (found ? of(found) : summary(api, step.source.callId, otherSource(primary)))),
  );
}

function findByOperation(api: CallsApiService, operationId: string, source: CallEndpointSource, result: StepResult): Observable<CallRecord | null> {
  return api.getCalls(operationQuery(operationId), source).pipe(
    map((page) => pickCall(page.calls, result)),
    catchError(() => of(null)),
  );
}

function summary(api: CallsApiService, callId: string, source: CallEndpointSource): Observable<CallRecord | null> {
  return api.getSummary(callId, source).pipe(catchError(() => of(null)));
}

function endpointSource(step: Step): CallEndpointSource {
  return step.direction === 'inbound' ? 'internal' : 'external';
}

function otherSource(source: CallEndpointSource): CallEndpointSource {
  return source === 'internal' ? 'external' : 'internal';
}

function operationQuery(operationId: string): CallsQuery {
  return { search: '', supplier: '', sort: 'newest', offset: 0, limit: 20, sessionId: '', operationId, requestId: '' };
}

/** Retries share one operation id. The call closest to this attempt's start is the one the row shows. */
export function pickCall(calls: readonly CallRecord[], result: StepResult): CallRecord | null {
  if (!calls.length) return null;
  const target = result.startedAt ? Date.parse(result.startedAt) : NaN;
  if (Number.isNaN(target)) return calls[0];
  return [...calls].sort((a, b) => Math.abs(Date.parse(a.timestamp) - target) - Math.abs(Date.parse(b.timestamp) - target))[0];
}

export function stepCallRecord(step: Step, result: StepResult): CallRecord {
  const request = requestOf(step, result);
  const response = responseOf(result);
  const responded = hasHttp(response);
  const inProgress = IN_PROGRESS.has(result.state) || (result.state === 'PAUSED' && !responded);
  const failed = !inProgress && !responded && (result.state === 'FAILED' || !!result.error);
  const headers = request.headers;
  const state: CallLifecycleState = inProgress ? 'IN_PROGRESS' : failed ? 'ERROR' : 'COMPLETED';
  const inbound = step.direction === 'inbound';
  return {
    id: `relive:${result.runId}:${step.key}:${result.attempt}`,
    original_url: step.recording.url,
    url: request.url || step.recording.url,
    method: request.method || step.recording.method,
    timestamp: result.startedAt || step.recording.timestamp || '',
    duration_ms: typeof result.durationMs === 'number' ? result.durationMs : (undefined as unknown as number),
    response: responded && response ? { status: response.status ?? 0, headers: response.headers, body: response.body } : undefined,
    error: failed ? result.error || 'Failed' : undefined,
    state,
    session_id: headerValue(headers, 'x-session-id') ?? step.recording.sessionId ?? null,
    operation_id: headerValue(headers, 'x-operation-id') ?? step.recording.operationId ?? null,
    service_name: inbound ? step.serviceName || step.recording.serviceName || null : step.serviceName || null,
    source: inbound ? 'internal' : 'external',
    relive: result.runId ? { runId: result.runId, stepKey: step.key } : null,
  };
}

/** One block, or the whole call when `part` is omitted (export / resend hydrate the full detail). */
export function stepCallDetail(step: Step, result: StepResult, part?: CallDetailPart): CallDetail {
  const request = requestOf(step, result);
  const response = responseOf(result);
  const requestMsg = { headers: request.headers, body: request.body };
  const responseMsg = hasHttp(response) && response
    ? { status: response.status ?? 0, headers: response.headers, body: response.body }
    : undefined;
  switch (part) {
    case 'request-headers':
      return { request: { headers: request.headers } };
    case 'request-body':
      return { request: { body: request.body } };
    case 'response-headers':
      return { response: responseMsg ? { status: responseMsg.status, headers: responseMsg.headers } : undefined };
    case 'response-body':
      return { response: responseMsg ? { status: responseMsg.status, body: responseMsg.body } : undefined };
    default:
      return { request: requestMsg, response: responseMsg };
  }
}

function requestOf(step: Step, result: StepResult): HttpParts {
  const stored = storedHttp(result.actualRequest) ?? storedHttp(result.effectiveRequest);
  if (!stored) {
    return {
      method: step.recording.method,
      url: step.recording.url,
      status: null,
      headers: { ...step.recording.requestHeaders },
      body: step.recording.requestBody ?? undefined,
    };
  }
  return {
    method: stored.method ?? step.recording.method,
    url: stored.url ?? step.recording.url,
    status: null,
    headers: stored.headers,
    body: stored.body,
  };
}

function responseOf(result: StepResult): HttpParts | null {
  return storedHttp(result.actualResponse);
}

function storedHttp(value: unknown): HttpParts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    method: typeof record['method'] === 'string' ? record['method'] : undefined,
    url: typeof record['url'] === 'string' ? record['url'] : undefined,
    status: typeof record['status'] === 'number' ? record['status'] : null,
    headers: headersOf(record['headers']),
    body: bodyOf(record['body']),
  };
}

function hasHttp(http: HttpParts | null): boolean {
  if (!http) return false;
  return http.status != null || http.body != null || Object.keys(http.headers).length > 0;
}

function headersOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw == null) continue;
    headers[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return headers;
}

function bodyOf(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}
