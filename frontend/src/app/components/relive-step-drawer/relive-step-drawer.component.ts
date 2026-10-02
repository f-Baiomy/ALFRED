import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CallFocus, CallFocusService } from '../../core/services/call-focus.service';
import { CallInterception, OriginalHttp, RuleAction } from '../../core/models/interception.model';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';
import { JsonPathInputComponent } from '../json-path-input/json-path-input.component';
import { ScenarioAssertionEditorComponent } from '../scenario-assertion-editor/scenario-assertion-editor.component';
import { applyMode, checkpointOf, modeOf, onRequestChangedOf, requestBodyOf, setCheckpoint, setMockResponse, setRequestBody } from '../../shared/utils/relive-call-rule';
import { ActionLine, HostCardInfo, describeAction, hostCard } from '../../shared/utils/relive-call-rule-describe';
import { recordedCallPreviewOf } from '../../shared/utils/recorded-call-match';
import { PathEntry, jsonPathIndex, parseJson } from '../../shared/utils/json-paths';
import { maskRelive } from '../../shared/utils/relive-mask';
import { LogEntry, OnRequestChanged, Step, StepMode, StepResult } from '../../shared/utils/relive-types';
import { Assertion, ExtractRule } from '../../shared/utils/scenario-types';

type DrawerTab = 'configure' | 'request' | 'response' | 'extract' | 'overview' | 'effective' | 'actual' | 'rules' | 'log' | 'compare';

/** Reduces whatever shape a StepResult's actual request/response happens to carry down to what
 *  InterceptionPanelComponent needs - present but non-numeric/non-string members are dropped. */
function toOriginalHttp(value: unknown): OriginalHttp | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { status?: unknown; headers?: unknown; body?: unknown };
  return {
    status: typeof v.status === 'number' ? v.status : null,
    headers: (v.headers && typeof v.headers === 'object' ? (v.headers as Record<string, string>) : {}) as Readonly<Record<string, string>>,
    body: typeof v.body === 'string' ? v.body : null,
  };
}

function bodyOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'body' in (value as Record<string, unknown>)) {
    const body = (value as { body?: unknown }).body;
    return typeof body === 'string' ? body : JSON.stringify(body ?? '', null, 2);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The step drawer's Configure tab (FR-006, FR-010a; mock.html `drawer()`/`configTab()`/
 * `callRuleSection()`). Request and Response show the recording read-only for now - a future task
 * makes Request editable; Extract & assert is wired in US5.
 */
@Component({
  selector: 'app-relive-step-drawer',
  standalone: true,
  imports: [InterceptionPanelComponent, JsonPathInputComponent, ScenarioAssertionEditorComponent],
  templateUrl: './relive-step-drawer.component.html',
})
export class ReliveStepDrawerComponent {
  private readonly callFocus = inject(CallFocusService);

  readonly step = input.required<Step>();
  /** "#n in <parent label>" for a child step - the cycle page computes it (siblings sharing this
   *  step's endpoint), since the drawer only ever sees one step at a time. Null for an inbound step. */
  readonly orderLabel = input<string | null>(null);

  readonly stepChange = output<Step>();
  readonly closed = output<void>();
  /** "Reset call rule" (FR-010b) - the parent shows the confirmation popup before calling
   *  `ReliveCycleEditorState.resetStep`; this only asks for it. */
  readonly resetRequested = output<string>();
  readonly duplicateRequested = output<string>();
  readonly openCallRule = output<string>();
  readonly openRequestDiffers = output<string>();
  /** The request of a REPLAY child was edited for the first time (FR-014d: ask right away what
   *  happens when it differs from the recording). */
  readonly requestEdited = output<string>();

  /** Set once a run has settled this step - switches the drawer into T061's run tabs. */
  readonly result = input<StepResult | null>(null);
  /** The run's own log, filtered to this step's key by the caller (or passed unfiltered - `log()`
   *  filters again defensively). */
  readonly runLog = input<readonly LogEntry[]>([]);
  /** The cycle's own secret variable names and current values (FR-022a) - `mask()` replaces every
   *  occurrence of one of these values with '•••', on top of the existing global redaction rules. */
  readonly secretNames = input<readonly string[]>([]);
  readonly variableValues = input<Readonly<Record<string, string>>>({});

  private readonly explicitTab = signal<DrawerTab | null>(null);
  readonly tab = computed<DrawerTab>(() => this.explicitTab() ?? (this.result() ? 'overview' : 'configure'));

  /** Per-view reveal (FR-022): never saved, resets when the drawer closes. */
  readonly revealed = signal(false);

  readonly log = computed(() => this.runLog().filter((e) => e.stepKey === this.step().key));

  /** The body this step sends: the edit saved in its call rule, else the recording's. */
  readonly requestBody = computed(() => requestBodyOf(this.step().callRule) ?? this.step().recording.requestBody ?? '');
  readonly requestEditedFlag = computed(() => requestBodyOf(this.step().callRule) !== null);
  /** The answer the call rule gives instead of the host (REPLAY mock or LIVE-mocked reply). */
  readonly mockAnswer = computed(() => {
    const action = this.step().callRule.actions.find((a) => (a.type === 'MOCK_RESPONSE' || a.type === 'REPLACE_RESPONSE') && a.enabled !== false);
    return action ? { status: action.status ?? 200, body: action.body ?? '' } : null;
  });

  /** "Saved as 'Replace the request body' in the call rule" (T037). Blank or unchanged text
   *  goes back to the recording. */
  saveRequestBody(text: string): void {
    const step = this.step();
    const recorded = step.recording.requestBody ?? '';
    const next = text === recorded ? null : text;
    if (next === requestBodyOf(step.callRule)) return;
    const firstEdit = requestBodyOf(step.callRule) === null && next !== null;
    this.stepChange.emit({ ...step, callRule: setRequestBody(step.callRule, next) });
    if (firstEdit && step.parentKey && modeOf(step.callRule) === 'REPLAY') this.requestEdited.emit(step.key);
  }

  /** Edits the enabled mock's (or reply's) status and body - kept even when switched to LIVE and back. */
  saveMockAnswer(status: number, body: string): void {
    const step = this.step();
    this.stepChange.emit({ ...step, callRule: setMockResponse(step.callRule, step.recording, status, body) });
  }

  /** T062 (research D16): recorded vs this run, built once so `InterceptionPanelComponent` can
   *  reuse the exact diff/highlight machinery a rule-edited call already gets. */
  readonly comparePhase = signal<'request' | 'response'>('response');
  readonly compareInterception = computed<CallInterception | null>(() => {
    const res = this.result();
    if (!res) return null;
    const rec = this.step().recording;
    return {
      applied: [],
      originalRequest: this.maskHttp({ method: rec.method, url: rec.url, headers: rec.requestHeaders, body: rec.requestBody ?? '' }),
      originalResponse: this.maskHttp({ status: rec.status, headers: rec.responseHeaders, body: rec.responseBody ?? '' }),
      finalRequest: this.maskHttp(toOriginalHttp(res.actualRequest)),
      finalResponse: this.maskHttp(toOriginalHttp(res.actualResponse)),
    };
  });

  private maskHttp(http: OriginalHttp | null): OriginalHttp | null {
    if (!http) return null;
    return {
      ...http,
      headers: Object.fromEntries(Object.entries(http.headers ?? {}).map(([name, value]) => [name, this.mask(value)])),
      body: http.body ? this.mask(http.body) : http.body,
    };
  }

  setComparePhase(phase: 'request' | 'response'): void {
    this.comparePhase.set(phase);
  }

  /** T065: the recorded response's own JSON paths, for the "＋ Extract a value…" path input's
   *  autocomplete - the same index `JsonPathInputComponent` already knows how to render. */
  readonly extractIndex = computed<readonly PathEntry[] | null>(() => {
    const doc = parseJson(this.step().recording.responseBody);
    return doc === undefined ? null : jsonPathIndex(doc);
  });

  addExtractRule(): void {
    const rule: ExtractRule = { from: 'JSON', path: '', as: '', missing: 'SKIP' };
    this.stepChange.emit({ ...this.step(), extract: [...this.step().extract, rule] });
  }

  updateExtractRule(index: number, patch: Partial<ExtractRule>): void {
    const extract = this.step().extract.map((r, i) => (i === index ? { ...r, ...patch } : r));
    this.stepChange.emit({ ...this.step(), extract });
  }

  removeExtractRule(index: number): void {
    this.stepChange.emit({ ...this.step(), extract: this.step().extract.filter((_, i) => i !== index) });
  }

  setAssertions(assertions: readonly Assertion[]): void {
    this.stepChange.emit({ ...this.step(), assertions });
  }

  readonly mode = computed(() => modeOf(this.step().callRule));
  readonly checkpoint = computed(() => checkpointOf(this.step().callRule));
  readonly onRequestChanged = computed(() => onRequestChangedOf(this.step().callRule));
  readonly requestActions = computed<readonly ActionLine[]>(() =>
    describeActions(this.step().callRule.actions, 'request', recordedCallPreviewOf(this.step().recording)));
  readonly responseActions = computed<readonly ActionLine[]>(() =>
    describeActions(this.step().callRule.actions, 'response', recordedCallPreviewOf(this.step().recording)));
  readonly host = computed<HostCardInfo>(() => hostCard(this.step().callRule.actions, this.step().serviceName || 'the app'));

  setTab(tab: DrawerTab): void {
    this.explicitTab.set(tab);
  }

  bodyOf(value: unknown): string {
    return bodyOf(value);
  }

  statusOf(result: StepResult): number | null {
    const response = result.actualResponse;
    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status?: unknown }).status;
      return typeof status === 'number' ? status : null;
    }
    return null;
  }

  unexpectedCount(result: StepResult): number {
    return result.differences.filter((d) => d.kind === 'UNEXPECTED').length;
  }

  expectedCount(result: StepResult): number {
    return result.differences.filter((d) => d.kind === 'EXPECTED').length;
  }

  noiseCount(result: StepResult): number {
    return result.differences.filter((d) => d.kind === 'NOISE_AUTO' || d.kind === 'NOISE_USER').length;
  }

  setLabel(label: string): void {
    this.stepChange.emit({ ...this.step(), label });
  }

  setOptional(optional: boolean): void {
    this.stepChange.emit({ ...this.step(), optional });
  }

  setMode(mode: StepMode): void {
    const step = this.step();
    if (modeOf(step.callRule) === mode) return;
    this.stepChange.emit({ ...step, callRule: applyMode(step.callRule, mode, step.recording) });
  }

  togglePause(at: 'before' | 'after'): void {
    const step = this.step();
    const cp = checkpointOf(step.callRule);
    const on = at === 'before' ? cp.before : cp.after;
    this.stepChange.emit({ ...step, callRule: setCheckpoint(step.callRule, at, !on) });
  }

  setUnattributed(choice: Step['unattributed']): void {
    this.stepChange.emit({ ...this.step(), unattributed: choice });
  }

  requestDiffersLabel(): string {
    const labels: Record<OnRequestChanged, string> = { FAIL: 'Mock a failure', ASK: 'Ask me', REPLAY: 'Replay recording anyway', LIVE: 'Call live ⚠' };
    return labels[this.onRequestChanged()];
  }

  openOriginal(): void {
    const step = this.step();
    // CallFocusService.revealIn is a no-op when the source has no cycleId (a call picked from
    // Live Calls, which a Step's `source` allows) - go() handles both origins.
    const focus: CallFocus = { callId: step.source.callId, cycleId: step.source.cycleId, direction: step.source.direction, serviceName: step.serviceName ?? null };
    this.callFocus.go(focus);
  }

  requestReset(): void {
    this.resetRequested.emit(this.step().key);
  }

  requestDuplicate(): void {
    this.duplicateRequested.emit(this.step().key);
  }

  requestOpenCallRule(): void {
    this.openCallRule.emit(this.step().key);
  }

  requestOpenRequestDiffers(): void {
    this.openRequestDiffers.emit(this.step().key);
  }

  close(): void {
    this.revealed.set(false);
    this.closed.emit();
  }

  toggleReveal(): void {
    this.revealed.set(!this.revealed());
  }

  mask(text: string): string {
    if (this.revealed()) return text;
    return maskRelive(text, this.secretNames(), this.variableValues());
  }
}

function describeActions(actions: readonly RuleAction[], phase: 'request' | 'response', preview: ReturnType<typeof recordedCallPreviewOf>): ActionLine[] {
  // Response-phase types by name (mirrors actionPhase()'s name-based fallback in interception.model.ts,
  // good enough for a read-only preview - the authoritative phase comes from the server's action
  // catalog, used everywhere an action is actually added/removed).
  const isResponse = (type: string) => type.includes('RESPONSE') && type !== 'MOCK_RESPONSE';
  return actions.filter((a) => (phase === 'response') === isResponse(a.type)).map((action) => describeAction(action, preview));
}
