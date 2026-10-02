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
 * Relive variables use `{{$.name}}`; bare `{{name}}` reads the global variable store. Rule-local
 * `{{this.name}}` tokens still use the existing value-fill machinery.
 * `{{$...}}` dynamic tokens (`dynamic-tokens.ts`) are a separate namespace and resolved first.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Subscription, filter, firstValueFrom } from 'rxjs';
import { CallEndpointSource, CallRecord } from '../models/call.model';
import { RuleAction } from '../models/interception.model';
import { CallsApiService } from '../services/calls-api.service';
import { GlobalVariablesService } from '../services/global-variables.service';
import { ReliveApiService, StartRunRequest } from '../services/relive-api.service';
import { ReliveSocketEvent, ReliveSocketService } from '../services/relive-socket.service';
import { ResendApiService, ResendResponseSnapshot, ResendResult } from '../services/resend-api.service';
import { resolveDynamicTokens } from '../../shared/utils/dynamic-tokens';
import { checkpointOf, modeOf } from '../../shared/utils/relive-call-rule';
import { RawDifference, classify } from '../../shared/utils/relive-noise';
import { ActualCallOutcome, outcomeOf } from '../../shared/utils/relive-outcome';
import type { CallsQuery } from '../state/call-list-view';
import { DifferenceEntry, NoiseRule, ReliveCycle, RuleApplied, Run, RunStatus, Step, StepResult, StepState } from '../../shared/utils/relive-types';
import { DraftResult } from '../../shared/utils/resend-draft';
import { extractValues, substituteTokens } from '../../shared/utils/resend-draft-chain';
import { finishedResponseDifference } from '../../shared/utils/relive-canonical-body';
import { evaluate } from '../../shared/utils/scenario-assertions';

/** How long to keep collecting `run-call` events after the inbound resend settles, before deciding
 *  a still-missing enabled child was never called - the reverse proxy handles a child's outbound
 *  call synchronously while the inbound request is in flight, so by the time the resend response
 *  comes back every child has already happened; this only covers the WS broadcast's own lag. */
const CHILD_EVENTS_GRACE_MS = 500;
/** How often a reattached page looks for the call a previous page already sent. */
const DISPATCH_POLL_MS = 400;
/** Proxy and browser clocks can disagree by a little. A call logged just after the dispatch
 *  marker still belongs to that attempt; a retry's previous call is much older. */
const DISPATCH_CLOCK_SKEW_MS = 2000;

type RunCallEvent = ReliveSocketEvent & { readonly type: 'run-call' };
type CheckpointDecision = 'CONTINUE' | 'REPLAY' | 'SKIP';
type RunHold = NonNullable<Run['hold']>;

export interface UnexpectedRunCall {
  readonly callId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly at: string;
}

interface SubstitutedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const PLAIN_VAR_TOKEN = /\{\{([A-Za-z][A-Za-z0-9_.-]*)\}\}/g;
const RELIVE_VAR_TOKEN = /\{\{\$\.([A-Za-z][A-Za-z0-9_.-]*)\}\}/g;

function substituteVars(text: string, vars: Readonly<Record<string, string>>, globals: Readonly<Record<string, string>>): string {
  if (!text) return text;
  const withDynamic = resolveDynamicTokens(text, (name) => name.startsWith('$.') ? vars[name.slice(2)] : globals[name]);
  const withRelive = withDynamic.replace(RELIVE_VAR_TOKEN, (token, name: string) => vars[name] ?? token);
  const withGlobal = withRelive.replace(PLAIN_VAR_TOKEN, (token, name: string) => name.startsWith('this.') ? token : globals[name] ?? token);
  return substituteTokens(withGlobal, vars).text;
}

function effectiveRequestBody(step: Step): string {
  const override = step.callRule.actions.find((a: RuleAction) => a.type === 'SET_REQUEST_BODY' && a.enabled !== false);
  return override?.body ?? step.recording.requestBody ?? '';
}

function substituteStepRequest(step: Step, vars: Readonly<Record<string, string>>, globals: Readonly<Record<string, string>>): SubstitutedRequest {
  return {
    method: step.recording.method,
    url: substituteVars(step.recording.url, vars, globals),
    headers: Object.fromEntries(Object.entries(step.recording.requestHeaders).map(([name, value]) => [name, substituteVars(value, vars, globals)])),
    body: substituteVars(effectiveRequestBody(step), vars, globals),
  };
}

function varRefsOf(step: Step): string[] {
  const text = `${step.recording.url} ${Object.values(step.recording.requestHeaders).join(' ')} ${step.recording.requestBody ?? ''}`;
  return [...new Set([...text.matchAll(RELIVE_VAR_TOKEN)].map((m) => m[1]))];
}

/** References still literal after substitution - unknown or not-yet-produced. */
function unresolvedNames(substituted: SubstitutedRequest): string[] {
  const text = `${substituted.url} ${Object.values(substituted.headers).join(' ')} ${substituted.body}`;
  return [...new Set([
    ...[...text.matchAll(RELIVE_VAR_TOKEN)].map((m) => `$.${m[1]}`),
    ...[...text.matchAll(PLAIN_VAR_TOKEN)].map((m) => m[1]).filter((name) => !name.startsWith('this.')),
  ])];
}

/** Variable names this step's recorded request actually references, with their current value - for `StepResult.variablesUsed`. */
function usedVarsOf(step: Step, vars: Readonly<Record<string, string>>): readonly { readonly name: string; readonly value: string }[] {
  return varRefsOf(step)
    .filter((name) => name in vars)
    .map((name) => ({ name, value: vars[name] }));
}

/** This step's response extract rules, run once against its actual response (T060/FR-041a). */
function extractedVars(response: ResendResponseSnapshot | null, rules: Step['extract']): readonly { readonly name: string; readonly value: string }[] {
  if (!rules.length || !response) return [];
  return Object.entries(extractValues(response, rules)).map(([name, value]) => ({ name, value }));
}

/** One MATCH or one DIFFERENT for the completed response. Field assertions stay on `evaluate`.
 *  This grade does not choose the supplier step. A noise-only body leaves no row. */
function rawDifferences(
  step: Step,
  response: ResendResponseSnapshot | null,
  noiseRules: readonly NoiseRule[],
  variablesUsed: readonly { readonly name: string; readonly value: string }[],
  variablesProduced: readonly { readonly name: string; readonly value: string }[],
): RawDifference[] {
  if (!response) return [];
  const verdict = finishedResponseDifference(
    { status: step.recording.status, headers: step.recording.responseHeaders, body: step.recording.responseBody },
    { status: response.status, headers: response.headers, body: response.body },
    { noiseRules, variablesUsed, variablesProduced },
  );
  if (!verdict) return [];
  return [{ part: 'body', path: 'response', recorded: verdict.recorded, actual: verdict.actual }];
}

function differencesOf(
  step: Step,
  response: ResendResponseSnapshot | null,
  noiseRules: readonly NoiseRule[],
  variablesUsed: readonly { readonly name: string; readonly value: string }[],
  variablesProduced: readonly { readonly name: string; readonly value: string }[],
): readonly DifferenceEntry[] {
  return classify(
    rawDifferences(step, response, noiseRules, variablesUsed, variablesProduced),
    { noiseRules, expected: [], variablesUsed, variablesProduced },
  );
}

function topSteps(steps: readonly Step[]): Step[] {
  return steps.filter((s) => !s.parentKey);
}
function childSteps(steps: readonly Step[], parentKey: string): Step[] {
  return steps.filter((s) => s.parentKey === parentKey);
}

/** Method + host + pathname, ignoring query - the same signature `relive-match.ts`'s `pairSteps`
 *  matches steps against each other with, applied here to one step's recording vs. one arrived
 *  `run-call` event's own endpoint (T077's Guided matching). */
function endpointSignatureOf(method: string, url: string): string {
  try {
    const parsed = new URL(url);
    return `${method.toUpperCase()} ${parsed.host}${parsed.pathname}`;
  } catch {
    return `${method.toUpperCase()} ${url}`;
  }
}

function endpointMatches(step: Step, event: RunCallEvent): boolean {
  if (!event.method || !event.url) return false;
  return endpointSignatureOf(step.recording.method, step.recording.url) === endpointSignatureOf(event.method, event.url);
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

function callsQuery(operationId: string, limit: number): CallsQuery {
  return { search: '', supplier: '', sort: 'newest', offset: 0, limit, sessionId: '', operationId, requestId: '' };
}

@Injectable()
export class ReliveRunService {
  private readonly api = inject(ReliveApiService);
  private readonly socket = inject(ReliveSocketService);
  private readonly resendApi = inject(ResendApiService);
  private readonly callsApi = inject(CallsApiService);
  private readonly globalVariables = inject(GlobalVariablesService);

  readonly run = signal<Run | null>(null);
  readonly results = signal<Readonly<Record<string, StepResult>>>({});
  readonly variables = signal<Readonly<Record<string, string>>>({});
  readonly status = signal<RunStatus | null>(null);
  /** Set while the run is holding at a failed/differing step (FR-034), null otherwise. */
  readonly hold = signal<RunHold | null>(null);
  /** Outbound calls the proxy attributed to this run but that matched no recorded child step
   *  (`relive.attribution === 'UNEXPECTED'`, proxy/relive.py `_handle_unexpected`) - live for the
   *  whole run, not scoped to whichever inbound step happens to be sending right now. */
  readonly unexpectedCalls = signal<readonly UnexpectedRunCall[]>([]);
  /** Set while an INBOUND step's own checkpoint (`checkpointOf(step.callRule)`, FR-035a-c) is
   *  waiting on a decision - "nothing is held in the proxy" for these (research D11): the tab
   *  itself is what's paused, before it sends the resend or before it commits the result. A
   *  child's own PAUSE_REQUEST/PAUSE_RESPONSE is held in the proxy instead (T057's other half,
   *  the existing Paused Calls flow - see `relive-run-timeline`'s `changedPauses`). */
  readonly pause = signal<{ readonly stepKey: string; readonly at: 'BEFORE' | 'AFTER' } | null>(null);

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
  private guidedSub: Subscription | null = null;
  private eventsSub: Subscription | null = null;
  private runEventsSub: Subscription | null = null;
  private pauseResolve: ((decision: CheckpointDecision) => void) | null = null;
  /** True once this instance is driving, so a second reattach cannot start another loop. */
  private loopStarted = false;
  /** The first step `runLoop` takes was already sent by the page a reload destroyed. */
  private reattachFirstStep = false;

  async start(cycle: ReliveCycle, request: StartRunRequest): Promise<void> {
    const run = await firstValueFrom(this.api.startRun(cycle.id, request));
    this.steps = run.definition.steps;
    this.stopped = false;
    this.run.set(run);
    this.status.set(run.status);
    this.unexpectedCalls.set([]);

    // "Run from here" (T075, FR-036): every step of an earlier top-level step is shown as carried
    // over rather than executed - the run starts fresh at `fromStepKey`, seeded with that run's
    // variables (already copied server-side into `seedVariables` via `seedFromRunId`).
    const topOrder = topSteps(this.steps);
    const fromIdx = run.fromStepKey ? topOrder.findIndex((s) => s.key === run.fromStepKey) : -1;
    this.topIdx = fromIdx < 0 ? 0 : fromIdx;
    const carriedOverTopKeys = new Set(topOrder.slice(0, this.topIdx).map((s) => s.key));

    const initialResults: Record<string, StepResult> = {};
    for (const step of this.steps) {
      const topKey = step.parentKey ?? step.key;
      const state: StepState = carriedOverTopKeys.has(topKey) ? 'NOT_CALLED' : step.enabled ? 'PENDING' : 'SKIPPED';
      initialResults[step.key] = emptyResult(run.id, step.key, state);
    }
    this.results.set(initialResults);

    const vars: Record<string, string> = {};
    for (const v of cycle.variables) vars[v.name] = v.value;
    for (const v of run.seedVariables) vars[v.name] = v.value;
    this.variables.set(vars);

    this.watchUnexpected(run.id);

    this.loopStarted = true;
    this.reattachFirstStep = false;
    this.socket.holdLease(run.id);
    if (request.driver !== 'AUTOMATIC') {
      this.startGuided(run);
      return;
    }

    await this.runLoop();
  }

  /** Re-send the lease before the run detail has loaded, so a reload cancels the 15s interrupt
   *  instead of losing the run while `getRun` is still in flight. */
  retain(runId: string): void {
    this.socket.holdLease(runId);
  }

  release(runId: string): void {
    this.socket.releaseLease(runId);
  }

  private watchUnexpected(runId: string): void {
    this.runEventsSub?.unsubscribe();
    this.runEventsSub = this.socket.events$
      .pipe(filter((e): e is RunCallEvent => e.type === 'run-call' && e.runId === runId && e.attribution === 'UNEXPECTED'))
      .subscribe((e) => {
        if (this.unexpectedCalls().some((u) => u.callId === e.callId)) return;
        this.unexpectedCalls.set([...this.unexpectedCalls(), { callId: e.callId, direction: e.direction, at: new Date().toISOString() }]);
      });
  }

  /**
   * The Guided driver (T077, FR-030a-c): nothing here ever sends a call - the app is driven by
   * hand in the real browser, and the reverse proxy attributes its inbound calls to this run
   * whenever it's the sole active Guided run for the project (`proxy/relive.py`'s own
   * `apply_inbound`, already built for research D2 - no proxy change needed). This only matches
   * each arriving inbound call to the next expected top-level step by endpoint, in order.
   */
  private startGuided(run: Run): void {
    this.topOrder = topSteps(this.steps);
    this.guidedSub?.unsubscribe();
    this.guidedSub = this.socket.events$
      .pipe(filter((e): e is RunCallEvent => e.type === 'run-call' && e.runId === run.id && e.state === 'COMPLETED'))
      .subscribe((e) => this.handleGuidedCall(e));
  }

  private async handleGuidedCall(event: RunCallEvent): Promise<void> {
    if (this.stopped) return;
    const run = this.run();
    if (!run) return;

    if (event.direction === 'outbound') {
      // A child of an already-matched inbound step - the proxy's own existing project/host
      // attribution (unchanged by this driver) already gave it a stepKey when it could.
      const step = event.stepKey ? this.stepByKey(event.stepKey) : undefined;
      if (step) {
        await this.settleResult(run, step, await this.buildChildResult(step, event));
        await this.refreshRunVariables(run);
      }
      return;
    }

    // The reverse proxy names the step it matched (it also applied that step's call rule), so its
    // choice wins. A repeat of the step just matched is a new attempt, not the next step.
    const lastMatched = this.topIdx > 0 ? this.topOrder[this.topIdx - 1] : undefined;
    if (event.stepKey && lastMatched?.key === event.stepKey) {
      const attempt = (this.results()[lastMatched.key]?.attempt ?? 1) + 1;
      await this.settleResult(run, lastMatched, { ...(await this.buildChildResult(lastMatched, event)), attempt });
      await this.refreshRunVariables(run);
      return;
    }
    const remaining = this.topOrder.slice(this.topIdx);
    const matchIdx = event.stepKey
      ? remaining.findIndex((s) => s.key === event.stepKey)
      : remaining.findIndex((s) => s.enabled && endpointMatches(s, event));
    if (matchIdx < 0) {
      if (!this.unexpectedCalls().some((u) => u.callId === event.callId)) {
        this.unexpectedCalls.set([...this.unexpectedCalls(), { callId: event.callId, direction: 'inbound', at: new Date().toISOString() }]);
      }
      return;
    }

    // Out of order (research/US8): a call matching a later step marks the ones in between SKIPPED.
    for (const skipped of remaining.slice(0, matchIdx)) {
      this.setResult(skipped.key, (r) => ({ ...r, state: 'SKIPPED' }));
      for (const kid of childSteps(this.steps, skipped.key)) this.setResult(kid.key, (r) => ({ ...r, state: 'NOT_CALLED' }));
    }

    const matched = remaining[matchIdx];
    this.topIdx += matchIdx + 1;
    this.setResult(matched.key, (r) => ({ ...r, state: 'RUNNING' }));
    await this.settleResult(run, matched, await this.buildChildResult(matched, event));
    await this.refreshRunVariables(run);
  }

  /** "End run" for the Guided driver (T077): unlike Automatic's `endRun()`, there's no hold to
   *  clear - whatever hasn't matched a call yet just stops waiting. */
  async endGuidedRun(): Promise<void> {
    const run = this.run();
    if (!run) return;
    this.guidedSub?.unsubscribe();
    this.guidedSub = null;
    const results: Record<string, StepResult> = { ...this.results() };
    for (const [key, r] of Object.entries(results)) {
      if (r.state === 'PENDING' || r.state === 'WAITING') results[key] = { ...r, state: 'NOT_CALLED' };
    }
    this.results.set(results);
    await this.finish();
  }

  async stop(): Promise<void> {
    const run = this.run();
    if (!run || this.stopped) return;
    this.stopped = true;
    this.hold.set(null);
    this.eventsSub?.unsubscribe();
    this.eventsSub = null;
    this.runEventsSub?.unsubscribe();
    this.runEventsSub = null;
    this.guidedSub?.unsubscribe();
    this.guidedSub = null;
    this.pause.set(null);
    const pauseResolve = this.pauseResolve;
    this.pauseResolve = null;
    pauseResolve?.('SKIP'); // unblocks a checkpointed runInboundStep - it checks `stopped` right after

    const cancelled: Record<string, StepResult> = { ...this.results() };
    for (const [key, result] of Object.entries(cancelled)) {
      if (['PENDING', 'WAITING', 'RUNNING', 'PAUSED'].includes(result.state)) {
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

  /** Rejoin a run this page is not driving (opened from History, or the cycle page was left and
   *  opened again). Restores the settled steps and, when the run is waiting on the user, the hold.
   *  An INTERRUPTED run is shown too — a reload drops the socket and the server ends the run 15s
   *  later, and hiding that leaves the Run tab empty. A no-op when this service already drives
   *  `full`, so a live cursor is never replaced by the last persisted snapshot. */
  adopt(full: Run & { readonly stepResults: readonly StepResult[] }): void {
    if (this.run()?.id === full.id && this.run()!.status === 'RUNNING') return;
    if (full.status !== 'RUNNING' && full.status !== 'INTERRUPTED') return;
    if (this.run()?.status === 'RUNNING') return;
    this.loopStarted = false;
    this.reattachFirstStep = false;
    this.steps = full.definition.steps;
    this.stopped = false;
    this.run.set(full);
    this.status.set(full.status);
    this.hold.set(full.hold ?? null);
    this.pause.set(null);

    const results: Record<string, StepResult> = {};
    for (const step of this.steps) results[step.key] = emptyResult(full.id, step.key, step.enabled ? 'PENDING' : 'SKIPPED');
    for (const stepResult of full.stepResults) {
      const existing = results[stepResult.stepKey];
      if (!existing || stepResult.attempt >= existing.attempt) results[stepResult.stepKey] = stepResult;
    }
    this.results.set(results);

    this.topOrder = topSteps(this.steps);
    const cursorKey = full.hold?.stepKey ?? this.topOrder.find((step) => {
      const state = results[step.key]?.state;
      return step.enabled && (state === 'PENDING' || state === 'RUNNING' || state === 'WAITING' || state === 'PAUSED');
    })?.key;
    const idx = cursorKey ? this.topOrder.findIndex((step) => step.key === cursorKey) : -1;
    this.topIdx = idx < 0 ? this.topOrder.length : idx;

    const vars: Record<string, string> = {};
    for (const variable of full.definition.variables) vars[variable.name] = variable.value;
    for (const variable of full.seedVariables) vars[variable.name] = variable.value;
    for (const entry of full.variableTimeline) vars[entry.name] = entry.value;
    this.variables.set(vars);

    if (full.status === 'RUNNING') this.socket.holdLease(full.id);
  }

  /** Keep a reattached RUNNING run moving. A step this page already finds in flight is settled
   *  from the call the proxy logged, not sent again. A hold stays a hold. */
  continueAdopted(): Promise<void> {
    const run = this.run();
    if (!run || run.status !== 'RUNNING' || this.stopped || this.hold() || this.loopStarted) return Promise.resolve();
    this.loopStarted = true;
    this.watchUnexpected(run.id);
    if (run.driver !== 'AUTOMATIC') {
      this.startGuided(run);
      return Promise.resolve();
    }
    this.reattachFirstStep = true;
    return this.runLoop();
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

    this.loopStarted = true;
    this.reattachFirstStep = false;
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

  /** Answers the currently open inbound-step checkpoint (mock `pContinue`/`pReplay`/`pSkip`) - a
   *  no-op when nothing is paused. */
  resolveCheckpoint(decision: CheckpointDecision): void {
    if (!this.pause()) return;
    this.pause.set(null);
    const resolve = this.pauseResolve;
    this.pauseResolve = null;
    resolve?.(decision);
  }

  private awaitCheckpoint(stepKey: string, at: 'BEFORE' | 'AFTER'): Promise<CheckpointDecision> {
    this.pause.set({ stepKey, at });
    this.setResult(stepKey, (r) => ({ ...r, state: 'PAUSED' }));
    return new Promise((resolve) => {
      this.pauseResolve = resolve;
    });
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
      const recoverIfDispatched = this.reattachFirstStep;
      this.reattachFirstStep = false;
      await this.runInboundStep(step, 1, recoverIfDispatched);
      if (this.stopped || this.hold()) return; // held: continueRun/retryStep/endRun resumes or ends
      this.topIdx++;
    }
    await this.finish();
  }

  private async runInboundStep(step: Step, attempt = 1, recoverIfDispatched = false): Promise<void> {
    const run = this.run();
    if (!run) return;
    const stored = this.results()[step.key];
    const storedState = stored?.state;
    const dispatchedAt = storedState === 'RUNNING' ? (stored?.startedAt ?? null) : null;
    if (recoverIfDispatched && storedState === 'RUNNING' && (stored?.attempt ?? 0) > 0) attempt = stored.attempt;
    const recover = recoverIfDispatched && await this.shouldRecover(step, storedState);
    this.setResult(step.key, (r) => ({ ...r, state: 'RUNNING' }));

    const checkpoint = checkpointOf(step.callRule);
    if (checkpoint.before && !recover) {
      const decision = await this.awaitCheckpoint(step.key, 'BEFORE');
      if (this.stopped) return;
      if (decision === 'SKIP') return this.skipStep(step);
      this.setResult(step.key, (r) => ({ ...r, state: 'RUNNING' }));
    }

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
    const substituted = substituteStepRequest(step, vars, {
      ...this.globalVariables.state().fallbacks,
      ...this.globalVariables.state().variables,
    });
    const unresolved = unresolvedNames(substituted);
    const startedAt = Date.now();
    let resendResult: ResendResult | null = null;
    let error: string | null = !recover && unresolved.length ? `unresolved {{${unresolved[0]}}}` : null;
    if (recover) {
      const waited = await this.waitForLoggedCall(step, dispatchedAt);
      if (this.stopped) {
        this.eventsSub?.unsubscribe();
        this.eventsSub = null;
        return;
      }
      resendResult = waited.result;
      error = waited.error;
      await this.absorbLoggedChildren(run, kids, collected);
    } else {
      try {
        if (!unresolved.length) {
          // Stored before the supplier is contacted, so a reload can tell "already sent" from
          // "not started yet" and will not post this step again.
          await this.markDispatched(run, step, attempt);
          resendResult = await firstValueFrom(
            this.resendApi.resend({
              direction: step.source.direction,
              callId: step.source.callId,
              cycleId: step.source.cycleId,
              edits: { method: substituted.method, url: substituted.url, headers: substituted.headers, body: substituted.body },
              relive: { runId: run.id, stepKey: step.key },
            }),
          );
        }
      } catch (e) {
        error = errorMessage(e);
      }
    }

    if (kids.length > 0) await sleep(CHILD_EVENTS_GRACE_MS);
    if (recover) await this.absorbLoggedChildren(run, kids, collected);
    this.eventsSub.unsubscribe();
    this.eventsSub = null;

    const own = this.buildOwnResult(step, substituted, resendResult, error, startedAt, attempt);

    if (checkpoint.after) {
      this.setResult(step.key, () => own); // show the result while paused, same as mock's pauseBox
      const decision = await this.awaitCheckpoint(step.key, 'AFTER');
      if (this.stopped) return;
      if (decision === 'REPLAY') return this.runInboundStep(step, attempt + 1);
      if (decision === 'SKIP') return this.skipStep(step);
    }

    await this.settleResult(run, step, own);

    for (const kid of kids) {
      const event = collected.get(kid.key);
      if (!event) {
        this.setResult(kid.key, (r) => ({ ...r, state: 'NOT_CALLED' }));
        continue;
      }
      await this.settleResult(run, kid, await this.buildChildResult(kid, event));
    }

    await this.refreshRunVariables(run);

    await this.applyFailurePolicy(run, step, own);
  }

  /** A reload's step was already posted when the server has a RUNNING attempt, or when the proxy
   *  has already logged the resend. A step that is only PENDING and has no logged call was never sent. */
  private async shouldRecover(step: Step, storedState: StepState | undefined): Promise<boolean> {
    if (storedState === 'RUNNING') return true;
    if (storedState !== 'PENDING' && storedState !== 'WAITING') return false;
    return (await this.loggedCall(step, null)) != null;
  }

  /** Remember that this attempt is about to be sent, before `POST /resend` leaves the browser. */
  private async markDispatched(run: Run, step: Step, attempt: number): Promise<void> {
    const marked: StepResult = {
      ...emptyResult(run.id, step.key, 'RUNNING'),
      attempt,
      startedAt: new Date().toISOString(),
    };
    this.setResult(step.key, () => marked);
    await firstValueFrom(this.api.putStepAttempt(run.cycleId, run.id, step.key, attempt, marked));
  }

  /** The resend's operation id (`relive-{runId}-{stepKey}`), logged on the call the proxy saw. */
  private async loggedCall(step: Step, startedAt: string | null): Promise<CallRecord | null> {
    const run = this.run();
    if (!run) return null;
    const operationId = `relive-${run.id}-${step.key}`;
    const page = await firstValueFrom(this.callsApi.getCalls(callsQuery(operationId, 5), this.endpointSource(step)));
    const matches = page.calls.filter((call) => this.sameAttempt(call, startedAt));
    return matches.find((call) => this.callFinished(call)) ?? matches[0] ?? null;
  }

  private async waitForLoggedCall(step: Step, startedAt: string | null): Promise<{ result: ResendResult | null; error: string | null }> {
    for (;;) {
      if (this.stopped) return { result: null, error: null };
      try {
        const call = await this.loggedCall(step, startedAt);
        if (call && this.callFinished(call)) return await this.resendResultFrom(call, step);
      } catch {
        // A list blip while reattaching must not turn into a second send.
      }
      await sleep(DISPATCH_POLL_MS);
    }
  }

  private async resendResultFrom(call: CallRecord, step: Step): Promise<{ result: ResendResult | null; error: string | null }> {
    const detail = await firstValueFrom(this.callsApi.getDetail(call.id, this.endpointSource(step)));
    if (call.error && !detail.response) return { result: null, error: call.error };
    const response = detail.response
      ? { status: detail.response.status, headers: detail.response.headers ?? {}, body: detail.response.body ?? null }
      : null;
    return {
      result: {
        newCallId: call.id,
        status: response?.status ?? 0,
        durationMs: call.duration_ms ?? 0,
        sessionValuesUsed: [],
        response,
      },
      error: response ? null : (call.error ?? 'no response'),
    };
  }

  /** Children of a step this page did not send may already be logged. The websocket only carries
   *  events that arrive after this page subscribed, so also read the recent call list. */
  private async absorbLoggedChildren(run: Run, kids: readonly Step[], collected: Map<string, RunCallEvent>): Promise<void> {
    if (!kids.length) return;
    const wanted = new Set(kids.map((kid) => kid.key));
    for (const source of ['external', 'internal'] as const) {
      let page: { calls: readonly CallRecord[] };
      try {
        page = await firstValueFrom(this.callsApi.getCalls(callsQuery('', 100), source));
      } catch {
        continue;
      }
      for (const call of page.calls) {
        const stepKey = call.relive?.stepKey;
        if (!stepKey || call.relive?.runId !== run.id || !wanted.has(stepKey) || collected.has(stepKey)) continue;
        if (!this.callFinished(call)) continue;
        const attribution = (call.relive as { attribution?: string } | null | undefined)?.attribution ?? 'INFLIGHT';
        collected.set(stepKey, {
          type: 'run-call',
          runId: run.id,
          stepKey,
          callId: call.id,
          direction: source === 'internal' ? 'inbound' : 'outbound',
          attribution,
          state: 'COMPLETED',
        });
      }
    }
  }

  private endpointSource(step: Step): CallEndpointSource {
    return step.source.direction === 'outbound' ? 'external' : 'internal';
  }

  private sameAttempt(call: CallRecord, startedAt: string | null): boolean {
    if (!startedAt || call.state === 'IN_PROGRESS') return true;
    const callAt = Date.parse(call.timestamp);
    const markedAt = Date.parse(startedAt);
    if (Number.isNaN(callAt) || Number.isNaN(markedAt)) return true;
    return callAt >= markedAt - DISPATCH_CLOCK_SKEW_MS;
  }

  private callFinished(call: CallRecord): boolean {
    if (call.state === 'IN_PROGRESS') return false;
    return call.state === 'COMPLETED' || call.state === 'ERROR' || !!call.error || call.response?.status != null;
  }

  /** Marks a step SKIPPED at the user's own request (a checkpoint's Skip, not a dependency skip -
   *  see `skipDependents` for that one) and its children NOT_CALLED, same as mock `pSkip`. */
  private skipStep(step: Step): void {
    this.setResult(step.key, (r) => ({ ...r, state: 'SKIPPED' }));
    for (const kid of childSteps(this.steps, step.key)) {
      this.setResult(kid.key, (r) => ({ ...r, state: 'NOT_CALLED' }));
    }
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
        error: `Skipped - needs {{$.${dep.needs.join('}}, {{$.')}}}, which ${step.label} did not produce`,
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
    const variablesUsed = usedVarsOf(step, this.variables());
    const variablesProduced = extractedVars(response, step.extract);
    const noiseRules = [...this.run()!.definition.noise, ...step.noise];
    const differences = differencesOf(step, response, noiseRules, variablesUsed, variablesProduced);
    const outcome = outcomeOf(actual, { status: step.recording.status }, assertionResults, differences);
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
      differences,
      rulesApplied: [],
      variablesUsed,
      variablesProduced,
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
    let actualRequest: { readonly headers: Readonly<Record<string, string>>; readonly body: string | null } | null = null;
    let rulesApplied: RuleApplied[] = [];
    try {
      const detail = await firstValueFrom(this.callsApi.getDetail(event.callId, source));
      response = detail.response ? { status: detail.response.status, headers: detail.response.headers ?? {}, body: detail.response.body ?? null } : null;
      actualRequest = detail.request ? { headers: detail.request.headers ?? {}, body: detail.request.body ?? null } : null;
      rulesApplied = (detail.relive?.ruleIds ?? []).map((r) => ({ ruleId: r.ruleId, name: r.ruleName, tier: r.tier }));
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
    const variablesUsed = usedVarsOf(step, this.variables());
    const variablesProduced = extractedVars(response, step.extract);
    const noiseRules = [...this.run()!.definition.noise, ...step.noise];
    const differences = differencesOf(step, response, noiseRules, variablesUsed, variablesProduced);
    const outcome = outcomeOf(actual, { status: step.recording.status }, assertionResults, differences);
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
      actualRequest,
      actualResponse: response,
      differences,
      rulesApplied,
      variablesUsed,
      variablesProduced,
      assertions: assertionResults,
      durationMs: null,
      error: null,
      unexpectedCalls: [],
      requestChanged: null,
      pauses: [],
    };
  }

  /** Persists a settled result and applies whatever it extracted (T060 already computed both the
   *  differences and `variablesProduced` - extraction happens once, at build time, so `classify`
   *  sees this step's own newly-produced values, not just earlier steps'). */
  private async settleResult(run: Run, step: Step, result: StepResult): Promise<void> {
    this.setResult(step.key, () => result);
    await firstValueFrom(this.api.putStepAttempt(run.cycleId, run.id, step.key, result.attempt, result));

    if (!result.variablesProduced.length) return;
    const vars = { ...this.variables() };
    for (const v of result.variablesProduced) vars[v.name] = v.value;
    this.variables.set(vars);
    for (const v of result.variablesProduced) {
      await firstValueFrom(this.api.setVariable(run.cycleId, run.id, v.name, v.value, step.key));
    }
  }

  private async refreshRunVariables(run: Run): Promise<void> {
    this.variables.set(await firstValueFrom(this.api.getRunVariables(run.cycleId, run.id)));
  }

  private async finish(): Promise<void> {
    const run = this.run();
    if (!run) return;
    // An optional step's failure is recorded but never counts toward the run's own outcome (T076,
    // US8 scenario 3) - only a required step's FAILED/differences state can make the run FAILED or
    // COMPLETED_WITH_DIFFERENCES overall.
    const results = this.results();
    const states = this.steps.filter((s) => !s.optional).map((s) => results[s.key]?.state);
    const status: RunStatus = states.includes('FAILED')
      ? 'FAILED'
      : states.includes('COMPLETED_WITH_DIFFERENCES')
        ? 'COMPLETED_WITH_DIFFERENCES'
        : 'COMPLETED';
    const finished = await firstValueFrom(this.api.finishRun(run.cycleId, run.id, status));
    this.run.set(finished);
    this.status.set(finished.status);
    this.runEventsSub?.unsubscribe();
    this.runEventsSub = null;
    this.socket.releaseLease(run.id);
  }

  private setResult(key: string, updater: (r: StepResult) => StepResult): void {
    const current = this.results();
    const existing = current[key];
    if (!existing) return;
    this.results.set({ ...current, [key]: updater(existing) });
  }
}
