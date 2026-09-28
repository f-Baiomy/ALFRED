/**
 * The Automatic driver's run orchestrator (FR-030 through FR-034a; mock.html's `startRun`/`tick`/
 * `runStep`/`finish`/`stopRun`, made real). Component-provided (not `providedIn: 'root'`) - a fresh
 * instance per cycle-page visit, since its state is one run's, not the app's.
 *
 * Only the inbound (top-level) steps are ever sent by this service - each is a `POST /resend`
 * through the existing resend pipeline, tagged with `relive: {runId, stepKey}` so backend-resend
 * adds `X-Alfred-Relive`/`X-Operation-Id` (research D2). The application then makes its own
 * outbound calls exactly as it always does; the proxy attributes each one to a child step (endpoint
 * + order, research D3) and broadcasts a `run-call` event over `/ws/relive` - this service never
 * calls a child step itself. A child never called (the app skipped it, or the run never reached the
 * ordinal ALFRED expected) settles as NOT_CALLED once its parent's wait window closes.
 *
 * Variable substitution reuses `resend-draft-chain.ts`'s `{{this.name}}` value-fill machinery rather
 * than re-implementing token scanning: a Relive `{{name}}` reference is aliased to `{{this.name}}`
 * for every name the run currently has a value for (FR-020) before delegating to `substituteTokens`;
 * an unrecognised or not-yet-produced name is left literal (T066 turns that into a block later).
 * `{{$...}}` dynamic tokens (`dynamic-tokens.ts`) are a separate namespace and resolved first.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription, filter, firstValueFrom } from 'rxjs';
import { CallEndpointSource } from '../models/call.model';
import { RuleAction } from '../models/interception.model';
import { CallsApiService } from '../services/calls-api.service';
import { ReliveApiService, StartRunRequest } from '../services/relive-api.service';
import { ReliveSocketEvent, ReliveSocketService } from '../services/relive-socket.service';
import { ResendApiService, ResendResponseSnapshot, ResendResult } from '../services/resend-api.service';
import { resolveDynamicTokens } from '../../shared/utils/dynamic-tokens';
import { modeOf } from '../../shared/utils/relive-call-rule';
import { ActualCallOutcome, outcomeOf } from '../../shared/utils/relive-outcome';
import { DifferenceEntry, ReliveCycle, Run, RunStatus, Step, StepResult, StepState } from '../../shared/utils/relive-types';
import { DraftResult } from '../../shared/utils/resend-draft';
import { extractValues, substituteTokens } from '../../shared/utils/resend-draft-chain';
import { evaluate } from '../../shared/utils/scenario-assertions';

/** How long to keep collecting `run-call` events after the inbound resend settles, before deciding
 *  a still-missing enabled child was never called - the reverse proxy handles a child's outbound
 *  call synchronously while the inbound request is in flight, so by the time the resend response
 *  comes back every child has already happened; this only covers the WS broadcast's own lag. */
const CHILD_EVENTS_GRACE_MS = 500;

type RunCallEvent = ReliveSocketEvent & { readonly type: 'run-call' };
type RunHold = NonNullable<Run['hold']>;

interface SubstitutedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const PLAIN_VAR_TOKEN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function substituteVars(text: string, vars: Readonly<Record<string, string>>): string {
  if (!text) return text;
  const withDynamic = resolveDynamicTokens(text, (name) => vars[name]);
  const aliased = withDynamic.replace(PLAIN_VAR_TOKEN, (token, name: string) => (name in vars ? `{{this.${name}}}` : token));
  return substituteTokens(aliased, vars).text;
}

function effectiveRequestBody(step: Step): string {
  const override = step.callRule.actions.find((a: RuleAction) => a.type === 'SET_REQUEST_BODY' && a.enabled !== false);
  return override?.body ?? step.recording.requestBody ?? '';
}

function substituteStepRequest(step: Step, vars: Readonly<Record<string, string>>): SubstitutedRequest {
  return {
    method: step.recording.method,
    url: substituteVars(step.recording.url, vars),
    headers: Object.fromEntries(Object.entries(step.recording.requestHeaders).map(([name, value]) => [name, substituteVars(value, vars)])),
    body: substituteVars(effectiveRequestBody(step), vars),
  };
}

function varRefsOf(step: Step): string[] {
  const text = `${step.recording.url} ${Object.values(step.recording.requestHeaders).join(' ')} ${step.recording.requestBody ?? ''}`;
  return [...new Set([...text.matchAll(PLAIN_VAR_TOKEN)].map((m) => m[1]))];
}

/** Variable names this step's recorded request actually references, with their current value - for `StepResult.variablesUsed`. */
function usedVarsOf(step: Step, vars: Readonly<Record<string, string>>): readonly { readonly name: string; readonly value: string }[] {
  return varRefsOf(step)
    .filter((name) => name in vars)
    .map((name) => ({ name, value: vars[name] }));
}

function topSteps(steps: readonly Step[]): Step[] {
  return steps.filter((s) => !s.parentKey);
}
function childSteps(steps: readonly Step[], parentKey: string): Step[] {
  return steps.filter((s) => s.parentKey === parentKey);
}

interface Dependent {
  readonly step: Step;
  readonly needs: readonly string[];
}

/**
 * Later top-level steps, not yet run, whose recorded request references a variable only `step`'s
 * own `extract` rules produce and which has no value yet - i.e. `step` failing before it could
 * extract left them with nothing to send (FR-034c, mock's `dependents`/`PRODUCES`).
 */
function dependentsOf(step: Step, topOrder: readonly Step[], results: Readonly<Record<string, StepResult>>, vars: Readonly<Record<string, string>>): Dependent[] {
  const produced = step.extract.map((e) => e.as);
  const lost = produced.filter((name) => !(name in vars));
  if (!lost.length) return [];
  const fromIndex = topOrder.findIndex((s) => s.key === step.key);
  return topOrder
    .slice(fromIndex + 1)
    .filter((s) => s.enabled && results[s.key]?.state === 'PENDING')
    .map((s) => ({ step: s, needs: varRefsOf(s).filter((name) => lost.includes(name)) }))
    .filter((d) => d.needs.length > 0);
}

function emptyResult(runId: string, stepKey: string, state: StepState): StepResult {
  return {
    runId,
    stepKey,
    attempt: 0,
    state,
    mode: 'REPLAY',
    attribution: 'UNATTRIBUTED',
    differences: [],
    rulesApplied: [],
    variablesUsed: [],
    variablesProduced: [],
    unexpectedCalls: [],
    pauses: [],
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof HttpErrorResponse) return e.message;
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NO_DIFFERENCES: readonly DifferenceEntry[] = [];

@Injectable()
export class ReliveRunService {
  private readonly api = inject(ReliveApiService);
  private readonly socket = inject(ReliveSocketService);
  private readonly resendApi = inject(ResendApiService);
  private readonly callsApi = inject(CallsApiService);

  readonly run = signal<Run | null>(null);
  readonly results = signal<Readonly<Record<string, StepResult>>>({});
  readonly variables = signal<Readonly<Record<string, string>>>({});
  readonly status = signal<RunStatus | null>(null);
  /** Set while the run is holding at a failed/differing step (FR-034), null otherwise. */
  readonly hold = signal<RunHold | null>(null);

  readonly progress = computed(() => {
    const values = Object.values(this.results());
    const total = values.length;
    const settled = values.filter((r) => !['PENDING', 'WAITING', 'RUNNING'].includes(r.state)).length;
    return { done: settled, total };
  });

  private steps: readonly Step[] = [];
  private topOrder: readonly Step[] = [];
  private topIdx = 0;
  private stopped = false;
  private eventsSub: Subscription | null = null;

  async start(cycle: ReliveCycle, request: StartRunRequest): Promise<void> {
    const run = await firstValueFrom(this.api.startRun(cycle.id, request));
    this.steps = run.definition.steps;
    this.stopped = false;
    this.run.set(run);
    this.status.set(run.status);

    const initialResults: Record<string, StepResult> = {};
    for (const step of this.steps) {
      initialResults[step.key] = emptyResult(run.id, step.key, step.enabled ? 'PENDING' : 'SKIPPED');
    }
    this.results.set(initialResults);

    const vars: Record<string, string> = {};
    for (const v of cycle.variables) vars[v.name] = v.value;
    for (const v of run.seedVariables) vars[v.name] = v.value;
    this.variables.set(vars);

    this.socket.holdLease(run.id);
    if (request.driver !== 'AUTOMATIC') return; // GUIDED driver: T075-T077

    await this.runLoop();
  }

  async stop(): Promise<void> {
    const run = this.run();
    if (!run || this.stopped) return;
    this.stopped = true;
    this.hold.set(null);
    this.eventsSub?.unsubscribe();
    this.eventsSub = null;

    const cancelled: Record<string, StepResult> = { ...this.results() };
    for (const [key, result] of Object.entries(cancelled)) {
      if (['PENDING', 'WAITING', 'RUNNING'].includes(result.state)) {
        cancelled[key] = { ...result, state: 'CANCELLED' };
      }
    }
    this.results.set(cancelled);

    const stopped = await firstValueFrom(this.api.stopRun(run.cycleId, run.id));
    this.run.set(stopped);
    this.status.set(stopped.status);
    this.socket.releaseLease(run.id);
  }

  /** "Continue with the next calls" (mock `haltContinue`): skips whatever the held step's failure
   *  left with nothing to send, clears the hold and resumes. */
  async continueRun(): Promise<void> {
    const held = this.hold();
    const run = this.run();
    if (!held || !run) return;
    const step = this.stepByKey(held.stepKey);
    if (step) this.skipDependents(step);
    await this.clearHold(run);
    this.topIdx++;
    await this.runLoop();
  }

  /** Re-runs the held step from scratch, one attempt higher (mock `haltRetry`). Only meaningful for
   *  a held top-level step - a held child is re-triggered by re-running its parent instead. */
  async retryStep(): Promise<void> {
    const held = this.hold();
    const run = this.run();
    if (!held || !run) return;
    const step = this.stepByKey(held.stepKey);
    if (!step) return;
    const attempt = (this.results()[step.key]?.attempt ?? 0) + 1;
    await this.clearHold(run);
    await this.runInboundStep(step, attempt);
    if (this.stopped || this.hold()) return;
    this.topIdx++;
    await this.runLoop();
  }

  /** Ends the run here (mock `haltEnd`): cancels whatever never ran and finishes. */
  async endRun(): Promise<void> {
    const run = this.run();
    if (!this.hold() || !run) return;
    await this.clearHold(run);
    const cancelled: Record<string, StepResult> = { ...this.results() };
    for (const [key, result] of Object.entries(cancelled)) {
      if (['PENDING', 'WAITING'].includes(result.state)) cancelled[key] = { ...result, state: 'CANCELLED' };
    }
    this.results.set(cancelled);
    await this.finish();
  }

  /** "Continue with the rest" on an ended run (mock `resumeRun`): re-fetches the run's full state
   *  (so a fresh page visit resuming a past run has it), re-takes the lease and continues right
   *  after `afterStepKey` - any step at or after that point left CANCELLED by an earlier stop goes
   *  back to PENDING, same variables, same run id (FR-034d). */
  async resume(cycleId: string, runId: string, afterStepKey: string): Promise<void> {
    const resumed = await firstValueFrom(this.api.resumeRun(cycleId, runId, afterStepKey));
    const full = await firstValueFrom(this.api.getRun(cycleId, runId));

    this.steps = full.definition.steps;
    this.stopped = false;
    this.hold.set(null);
    this.run.set(resumed);
    this.status.set(resumed.status);

    const results: Record<string, StepResult> = {};
    for (const step of this.steps) results[step.key] = emptyResult(full.id, step.key, step.enabled ? 'PENDING' : 'SKIPPED');
    for (const stepResult of full.stepResults) results[stepResult.stepKey] = stepResult;

    this.topOrder = topSteps(this.steps);
    const afterIdx = this.topOrder.findIndex((s) => s.key === afterStepKey);
    this.topIdx = afterIdx + 1;
    for (const step of this.topOrder.slice(this.topIdx)) {
      for (const key of [step.key, ...childSteps(this.steps, step.key).map((c) => c.key)]) {
        if (results[key]?.state === 'CANCELLED') results[key] = { ...results[key], state: 'PENDING' };
      }
    }
    this.results.set(results);

    const vars: Record<string, string> = {};
    for (const entry of full.variableTimeline) vars[entry.name] = entry.value;
    this.variables.set(vars);

    this.socket.holdLease(full.id);
    await this.runLoop();
  }

  /** Mid-run definition edit (FR-044a): the "apply to this run too" choice from the editor's dialog
   *  (the dialog itself is UI, not this service's job). Steps already run are rejected server-side
   *  (409) - this only ever affects steps this run hasn't reached yet. */
  async applyDefinitionEdit(definition: ReliveCycle, reason: string): Promise<void> {
    const run = this.run();
    if (!run) return;
    const updated = await firstValueFrom(this.api.updateRunDefinition(run.cycleId, run.id, definition, reason));
    this.run.set(updated);
    this.status.set(updated.status);
    this.steps = updated.definition.steps;
    this.topOrder = topSteps(this.steps);

    const results = { ...this.results() };
    for (const step of this.steps) {
      if (!results[step.key]) results[step.key] = emptyResult(updated.id, step.key, step.enabled ? 'PENDING' : 'SKIPPED');
    }
    this.results.set(results);
  }

  private async runLoop(): Promise<void> {
    this.topOrder = topSteps(this.steps);
    while (this.topIdx < this.topOrder.length) {
      if (this.stopped) return;
      const step = this.topOrder[this.topIdx];
      if (!step.enabled || this.results()[step.key]?.state === 'SKIPPED') {
        this.topIdx++; // disabled, or SKIPPED already by skipDependents (a missing extracted value)
        continue;
      }
      await this.runInboundStep(step);
      if (this.stopped || this.hold()) return; // held: continueRun/retryStep/endRun resumes or ends
      this.topIdx++;
    }
    await this.finish();
  }

  private async runInboundStep(step: Step, attempt = 1): Promise<void> {
    const run = this.run();
    if (!run) return;
    this.setResult(step.key, (r) => ({ ...r, state: 'RUNNING' }));
    const kids = childSteps(this.steps, step.key).filter((c) => c.enabled);
    for (const kid of kids) this.setResult(kid.key, (r) => ({ ...r, state: 'WAITING' }));

    // `state` here is the proxy's own call lifecycle (IN_PROGRESS then COMPLETED, ReliveRunsService.
    // broadcastRunCall) - only COMPLETED means the child has actually settled and has a logged call
    // to fetch; an IN_PROGRESS sighting is dropped so a still-running LIVE child isn't mistaken for
    // NOT_CALLED just because its own COMPLETED event hasn't arrived within the grace window yet.
    const collected = new Map<string, RunCallEvent>();
    this.eventsSub = this.socket.events$
      .pipe(filter((e): e is RunCallEvent => e.type === 'run-call' && e.runId === run.id && e.state === 'COMPLETED'))
      .subscribe((e) => collected.set(e.stepKey, e));

    const vars = this.variables();
    const substituted = substituteStepRequest(step, vars);
    const startedAt = Date.now();
    let resendResult: ResendResult | null = null;
    let error: string | null = null;
    try {
      resendResult = await firstValueFrom(
        this.resendApi.resend({
          direction: 'inbound',
          callId: step.source.callId,
          cycleId: step.source.cycleId,
          edits: { method: substituted.method, url: substituted.url, headers: substituted.headers, body: substituted.body },
          relive: { runId: run.id, stepKey: step.key },
        }),
      );
    } catch (e) {
      error = errorMessage(e);
    }

    if (kids.length > 0) await sleep(CHILD_EVENTS_GRACE_MS);
    this.eventsSub.unsubscribe();
    this.eventsSub = null;

    const own = this.buildOwnResult(step, substituted, resendResult, error, startedAt, attempt);
    await this.settleResult(run, step, own);

    for (const kid of kids) {
      const event = collected.get(kid.key);
      if (!event) {
        this.setResult(kid.key, (r) => ({ ...r, state: 'NOT_CALLED' }));
        continue;
      }
      await this.settleResult(run, kid, await this.buildChildResult(kid, event));
    }

    await this.applyFailurePolicy(run, step, own);
  }

  /** FR-034/034c: holds the run at a failed or differing step per the cycle's own settings, else
   *  (on failure only) skips whatever that step's missing extraction leaves with nothing to send -
   *  "keep going" is the same skip, just without waiting for a decision first. */
  private async applyFailurePolicy(run: Run, step: Step, result: StepResult): Promise<void> {
    const settings = run.definition.settings;
    if (result.state === 'FAILED' && !step.optional) {
      if (settings.onFailure === 'HOLD') return this.enterHold(run, step.key, 'FAILED');
      this.skipDependents(step);
      return;
    }
    if (result.state === 'COMPLETED_WITH_DIFFERENCES' && settings.onDifferences === 'HOLD') {
      await this.enterHold(run, step.key, 'DIFFERENCES');
    }
  }

  private skipDependents(step: Step): void {
    const deps = dependentsOf(step, this.topOrder, this.results(), this.variables());
    for (const dep of deps) {
      this.setResult(dep.step.key, (r) => ({
        ...r,
        state: 'SKIPPED',
        error: `Skipped - needs {{${dep.needs.join('}}, {{')}}}, which ${step.label} did not produce`,
      }));
      for (const kid of childSteps(this.steps, dep.step.key)) {
        this.setResult(kid.key, (r) => ({ ...r, state: 'NOT_CALLED' }));
      }
    }
  }

  private async enterHold(run: Run, stepKey: string, reason: 'FAILED' | 'DIFFERENCES'): Promise<void> {
    const held: RunHold = { stepKey, reason, since: new Date().toISOString() };
    this.hold.set(held);
    const updated = await firstValueFrom(this.api.setHold(run.cycleId, run.id, { stepKey, reason }));
    this.run.set(updated);
    this.status.set(updated.status);
  }

  private async clearHold(run: Run): Promise<void> {
    this.hold.set(null);
    const updated = await firstValueFrom(this.api.setHold(run.cycleId, run.id, null));
    this.run.set(updated);
    this.status.set(updated.status);
  }

  private stepByKey(key: string): Step | undefined {
    return this.steps.find((s) => s.key === key);
  }

  private buildOwnResult(
    step: Step,
    substituted: SubstitutedRequest,
    resendResult: ResendResult | null,
    error: string | null,
    startedAt: number,
    attempt: number,
  ): StepResult {
    const finishedAt = Date.now();
    const response = resendResult?.response ?? null;
    const actual: ActualCallOutcome = {
      transportError: !!error,
      timedOut: false,
      noAnswer: !response,
      status: response?.status ?? null,
    };
    const draftResult: DraftResult = {
      key: step.key,
      attempt,
      status: response?.status ?? null,
      durationMs: resendResult?.durationMs ?? null,
      newCallId: resendResult?.newCallId ?? null,
      error,
      response,
      extracted: {},
    };
    const assertionResults = evaluate(step.assertions, draftResult);
    const outcome = outcomeOf(actual, { status: step.recording.status }, assertionResults, NO_DIFFERENCES);
    const effective = { method: substituted.method, url: substituted.url, headers: substituted.headers, body: substituted.body };
    return {
      runId: this.run()!.id,
      stepKey: step.key,
      attempt,
      state: outcome,
      mode: modeOf(step.callRule) === 'REPLAY' ? 'REPLAY' : 'LIVE',
      attribution: 'HEADER',
      effectiveRequest: effective,
      actualRequest: effective,
      actualResponse: response,
      differences: NO_DIFFERENCES,
      rulesApplied: [],
      variablesUsed: usedVarsOf(step, this.variables()),
      variablesProduced: [],
      assertions: assertionResults,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: resendResult?.durationMs ?? finishedAt - startedAt,
      error,
      unexpectedCalls: [],
      requestChanged: null,
      pauses: [],
    };
  }

  private async buildChildResult(step: Step, event: RunCallEvent): Promise<StepResult> {
    const source: CallEndpointSource = event.direction === 'inbound' ? 'internal' : 'external';
    let response: ResendResponseSnapshot | null = null;
    try {
      const detail = await firstValueFrom(this.callsApi.getDetail(event.callId, source));
      response = detail.response ? { status: detail.response.status, headers: detail.response.headers ?? {}, body: detail.response.body ?? null } : null;
    } catch {
      response = null;
    }
    const draftResult: DraftResult = {
      key: step.key,
      attempt: 1,
      status: response?.status ?? null,
      durationMs: null,
      newCallId: event.callId,
      error: null,
      response,
      extracted: {},
    };
    const assertionResults = evaluate(step.assertions, draftResult);
    const actual: ActualCallOutcome = { transportError: false, timedOut: false, noAnswer: !response, status: response?.status ?? null };
    const outcome = outcomeOf(actual, { status: step.recording.status }, assertionResults, NO_DIFFERENCES);
    return {
      runId: this.run()!.id,
      stepKey: step.key,
      attempt: 1,
      state: outcome,
      // The event carries a lifecycle state, not the mode (see the events$ filter above) - the
      // proxy's own "choice" for a matched child is its configured mode verbatim (proxy/relive.py),
      // which `modeOf` already reads back from the same call rule the run was built from.
      mode: modeOf(step.callRule) === 'REPLAY' ? 'REPLAY' : 'LIVE',
      attribution: event.attribution as StepResult['attribution'],
      actualResponse: response,
      differences: NO_DIFFERENCES,
      rulesApplied: [],
      variablesUsed: usedVarsOf(step, this.variables()),
      variablesProduced: [],
      assertions: assertionResults,
      durationMs: null,
      error: null,
      unexpectedCalls: [],
      requestChanged: null,
      pauses: [],
    };
  }

  private async settleResult(run: Run, step: Step, result: StepResult): Promise<void> {
    this.setResult(step.key, () => result);
    await firstValueFrom(this.api.putStepAttempt(run.cycleId, run.id, step.key, result.attempt, result));

    if (!step.extract.length || !result.actualResponse) return;
    const extracted = extractValues(result.actualResponse as ResendResponseSnapshot, step.extract);
    const names = Object.keys(extracted);
    if (!names.length) return;
    const vars = { ...this.variables(), ...extracted };
    this.variables.set(vars);
    for (const name of names) {
      await firstValueFrom(this.api.setVariable(run.cycleId, run.id, name, vars[name], step.key));
    }
    this.setResult(step.key, (r) => ({ ...r, variablesProduced: names.map((name) => ({ name, value: vars[name] })) }));
  }

  private async finish(): Promise<void> {
    const run = this.run();
    if (!run) return;
    const states = Object.values(this.results()).map((r) => r.state);
    const status: RunStatus = states.includes('FAILED')
      ? 'FAILED'
      : states.includes('COMPLETED_WITH_DIFFERENCES')
        ? 'COMPLETED_WITH_DIFFERENCES'
        : 'COMPLETED';
    const finished = await firstValueFrom(this.api.finishRun(run.cycleId, run.id, status));
    this.run.set(finished);
    this.status.set(finished.status);
    this.socket.releaseLease(run.id);
  }

  private setResult(key: string, updater: (r: StepResult) => StepResult): void {
    const current = this.results();
    const existing = current[key];
    if (!existing) return;
    this.results.set({ ...current, [key]: updater(existing) });
  }
}
