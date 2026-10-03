import { Component, computed, inject, input, output, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { BodyEditorComponent } from '../body-editor/body-editor.component';
import { CallStepStripComponent, CallStripStep } from '../call-step-strip/call-step-strip.component';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';
import { JsonBrowseComponent, BrowsePick } from '../json-browse/json-browse.component';
import { JsonPathInputComponent } from '../json-path-input/json-path-input.component';
import { RuleEditorComponent } from '../rule-editor/rule-editor.component';
import { RuleEditorTarget } from '../rule-editor/rule-editor-target';
import { ReliveChecksEditorComponent } from '../relive-checks-editor/relive-checks-editor.component';
import { NameSuggestComponent } from '../name-suggest/name-suggest.component';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';
import { CallFocusService } from '../../core/services/call-focus.service';
import { CallInterception, InterceptionRuleDraft, OriginalHttp } from '../../core/models/interception.model';
import { recordedCallPreviewOf } from '../../shared/utils/recorded-call-match';
import { recordingSampleCall } from '../relive-step-call/relive-step-call.component';
import { PathEntry, jsonPathIndex, parseJson } from '../../shared/utils/json-paths';
import { applyMode, checkpointOf, modeOf, onRequestChangedOf, requestBodyOf, setCheckpoint, setMockResponse, setRequestBody } from '../../shared/utils/relive-call-rule';
import { maskRelive } from '../../shared/utils/relive-mask';
import { CycleRule, CycleVariable, OnRequestChanged, Step, StepMode } from '../../shared/utils/relive-types';
import { extractValues } from '../../shared/utils/resend-draft-chain';
import { StepChecks, checkCount, stepChecks } from '../../shared/utils/relive-checks';
import { NameSuggestion, headerSuggestions, responseCookieSuggestions } from '../../shared/utils/name-suggestions';
import { ExtractRule } from '../../shared/utils/scenario-types';
import { recordedValueOf } from '../../shared/utils/relive-chains';

type Box = 'recorded' | 'mode' | 'edits' | 'variables' | 'rule' | 'answer' | 'values';

const TOKEN = /\{\{\s*(?:\$\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Every `{{name}}` / `{{$.name}}` a step's call rule refers to - the only place its overrides live. */
export function variablesUsedBy(step: Step): string[] {
  const text = JSON.stringify(step.callRule.actions ?? []);
  return [...new Set([...text.matchAll(TOKEN)].map((m) => m[1]))];
}

export interface ExtractPreview {
  readonly found: boolean;
  readonly value: string | null;
  readonly fallback: boolean;
  readonly usedBy: readonly string[];
}

/**
 * How a Relive step runs, as one more panel of the Live Calls call card (beside "Resent from…" and
 * the ⚡ intercepted panel, same frame and numbered strip). Replaces the old side drawer: the card
 * already shows the recorded call, so this panel only holds what the run changes - mode, the
 * edited request, variables, the call rule (the Interception rule editor, inline), ALFRED's answer
 * and the values / checks - with the recording vs what this step sends / answers diffed below.
 */
@Component({
  selector: 'app-relive-step-panel',
  standalone: true,
  imports: [
    BodyEditorComponent,
    CallStepStripComponent,
    InterceptionPanelComponent,
    JsonBrowseComponent,
    JsonPathInputComponent,
    RuleEditorComponent,
    ReliveChecksEditorComponent,
    NameSuggestComponent,
    SelectPickerComponent,
  ],
  templateUrl: './relive-step-panel.component.html',
})
export class ReliveStepPanelComponent {
  private readonly callFocus = inject(CallFocusService);

  readonly step = input.required<Step>();
  /** Every step of the cycle - who saves a variable this step uses, and who uses a value it saves. */
  readonly steps = input<readonly Step[]>([]);
  readonly variables = input<readonly CycleVariable[]>([]);
  readonly cycleRules = input<readonly CycleRule[]>([]);
  /** "#n in <parent>" for a child step (the cycle page computes it). */
  readonly orderLabel = input<string | null>(null);
  readonly reliveVariableHints = input<readonly { name: string; secret: boolean }[]>([]);

  readonly stepChange = output<Step>();
  readonly resetRequested = output<string>();
  readonly openCallRule = output<string>();
  readonly openRequestDiffers = output<string>();
  /** A REPLAY child's request was edited for the first time (FR-014d) - asked once the edit is done. */
  readonly requestEdited = output<string>();

  readonly extractFromOptions: readonly SelectOption[] = [
    { value: 'JSON', label: 'JSON field' },
    { value: 'HEADER', label: 'Header' },
    { value: 'COOKIE', label: 'Cookie' },
    { value: 'XML', label: 'XML / SOAP element' },
    { value: 'REGEX', label: 'Pattern (regex)' },
  ];
  readonly extractMissingOptions: readonly SelectOption[] = [
    { value: 'SKIP', label: 'Skip if missing' },
    { value: 'FALLBACK', label: 'Fallback if missing' },
  ];

  readonly open = signal(true);
  readonly box = signal<Box>('mode');
  readonly half = signal<'request' | 'response'>('request');
  readonly revealed = signal(false);
  readonly browsing = signal(false);
  readonly browseAs = signal<'value' | 'check'>('value');
  /** Bumped by "Undo changes" so the inline rule editor reloads from the step's saved rule. */
  readonly ruleEditorRevision = signal(0);
  private firstEditPending = false;

  readonly mode = computed(() => modeOf(this.step().callRule));
  readonly isChild = computed(() => !!this.step().parentKey);
  readonly checkpoint = computed(() => checkpointOf(this.step().callRule));
  readonly onRequestChanged = computed(() => onRequestChangedOf(this.step().callRule));
  readonly editedBody = computed(() => requestBodyOf(this.step().callRule));
  readonly requestBody = computed(() => this.editedBody() ?? this.step().recording.requestBody ?? '');
  readonly mockAnswer = computed(() => {
    const action = this.step().callRule.actions.find((a) => (a.type === 'MOCK_RESPONSE' || a.type === 'REPLACE_RESPONSE') && a.enabled !== false);
    return action ? { status: action.status ?? this.step().recording.status, body: action.body ?? '' } : null;
  });
  readonly answerEdited = computed(() => {
    const answer = this.mockAnswer();
    const rec = this.step().recording;
    return !!answer && (answer.status !== rec.status || answer.body !== (rec.responseBody ?? ''));
  });

  readonly used = computed(() => {
    const step = this.step();
    const index = this.steps().findIndex((s) => s.key === step.key);
    return variablesUsedBy(step).map((name) => {
      const saver = this.steps().slice(0, Math.max(0, index)).reverse().find((s) => s.extract.some((rule) => rule.as === name));
      const cycle = this.variables().find((v) => v.name === name);
      const recorded = saver ? extractValues(responseOf(saver), saver.extract.filter((rule) => rule.as === name))[name] ?? null : null;
      return {
        name,
        source: saver ? `saved by "${saver.label}"` : cycle ? 'a cycle variable' : null,
        value: saver ? recorded : (cycle?.value ?? null),
        secret: cycle?.secret ?? false,
      };
    });
  });

  readonly extractPreviews = computed<readonly ExtractPreview[]>(() => {
    const step = this.step();
    const index = this.steps().findIndex((s) => s.key === step.key);
    const later = this.steps().slice(index + 1);
    return step.extract.map((rule) => {
      const found = rule.path.trim() ? extractValues(responseOf(step), [{ ...rule, missing: 'SKIP' }])[rule.as] : undefined;
      const swapped = rule.recordedValue;
      const sendsRecorded = (s: Step) => !!swapped && [s.recording.url, s.recording.requestBody ?? '', ...Object.values(s.recording.requestHeaders)].some((text) => text.includes(swapped));
      const usedBy = rule.as ? later.filter((s) => variablesUsedBy(s).includes(rule.as) || sendsRecorded(s)).map((s) => s.label) : [];
      if (found !== undefined) return { found: true, value: found, fallback: false, usedBy };
      return { found: false, value: rule.missing === 'FALLBACK' ? (rule.fallback ?? '') : null, fallback: rule.missing === 'FALLBACK', usedBy };
    });
  });

  /** The step's checks (groups of rule conditions) - an older Assertion[] read as one group. */
  readonly checks = computed<StepChecks>(() => stepChecks(this.step().assertions));
  readonly checkTotal = computed(() => checkCount(this.checks()));

  /** Names a header / cookie "Save a value" box offers - from the recorded response. */
  extractNames(from: ExtractRule['from']): readonly NameSuggestion[] {
    const headers = this.step().recording.responseHeaders;
    return from === 'COOKIE' ? responseCookieSuggestions(headers) : headerSuggestions(headers);
  }

  readonly extractIndex = computed<readonly PathEntry[] | null>(() => {
    const doc = parseJson(this.step().recording.responseBody);
    return doc === undefined ? null : jsonPathIndex(doc);
  });
  readonly responseDoc = computed(() => parseJson(this.step().recording.responseBody));

  readonly strip = computed<readonly CallStripStep[]>(() => {
    const step = this.step();
    const mode = this.mode();
    const cp = this.checkpoint();
    const ruleCount = step.callRule.actions.filter((a) => a.enabled !== false).length;
    const pauses = [cp.before ? 'pause before' : '', cp.after ? 'pause after' : ''].filter(Boolean).join(' · ');
    const checks = this.checkTotal();
    return [
      { key: 'recorded', title: 'Recorded call', line: `${step.recording.method} · ${step.recording.status} · ${step.recording.durationMs} ms` },
      { key: 'mode', title: 'Mode', line: modeLine(mode, this.isChild()) },
      { key: 'edits', title: 'Your edits', line: this.editedBody() !== null ? 'request body edited' : 'none' },
      { key: 'variables', title: 'Variables', line: this.used().length ? this.used().map((u) => u.name).join(', ') : 'none' },
      { key: 'rule', title: 'Call rule', line: `${ruleCount} action${ruleCount === 1 ? '' : 's'}${pauses ? ' · ' + pauses : ''}` },
      { key: 'answer', title: 'Answer', line: this.mockAnswer() ? `ALFRED · ${this.mockAnswer()!.status}${this.answerEdited() ? ' · edited' : ''}` : this.isChild() ? 'the supplier' : 'your app' },
      {
        key: 'values',
        title: 'Values',
        line: [step.extract.length ? `saves ${step.extract.map((r) => r.as || '?').join(', ')}` : '', checks ? `${checks} check${checks === 1 ? '' : 's'}` : '']
          .filter(Boolean).join(' · ') || 'none',
      },
    ];
  });

  readonly summary = computed(() => {
    const parts = [modeLine(this.mode(), this.isChild())];
    if (this.editedBody() !== null) parts.push('request edited');
    if (this.answerEdited()) parts.push('answer edited');
    if (this.used().length) parts.push(`uses ${this.used().map((u) => u.name).join(', ')}`);
    const cp = this.checkpoint();
    if (cp.before) parts.push('pause before');
    if (cp.after) parts.push('pause after');
    if (this.step().extract.length) parts.push(`saves ${this.step().extract.map((r) => r.as || '?').join(', ')}`);
    if (this.checkTotal()) parts.push(`${this.checkTotal()} check${this.checkTotal() === 1 ? '' : 's'}`);
    return parts.join(' · ');
  });

  readonly enabledCycleRules = computed(() => this.cycleRules().filter((rule) => rule.enabled !== false));

  /** Recording vs what this step sends / answers - the same diff the ⚡ panel draws for a rule-edited call. */
  readonly compare = computed<CallInterception>(() => {
    const step = this.step();
    const rec = step.recording;
    const answer = this.mockAnswer();
    return {
      applied: [],
      originalRequest: this.maskHttp({ method: rec.method, url: rec.url, headers: rec.requestHeaders, body: rec.requestBody ?? '' }),
      finalRequest: this.maskHttp({ method: rec.method, url: rec.url, headers: rec.requestHeaders, body: this.requestBody() }),
      originalResponse: this.maskHttp({ status: rec.status, headers: rec.responseHeaders, body: rec.responseBody ?? '' }),
      finalResponse: answer ? this.maskHttp({ status: answer.status, headers: rec.responseHeaders, body: answer.body }) : null,
    };
  });

  readonly requestLabels = {
    title: 'Request',
    before: 'Recorded',
    after: 'This step sends',
    legend: 'Red is the recording; green is what this step sends instead.',
  };
  readonly responseLabels = computed(() => ({
    title: 'Response',
    before: 'Recorded',
    after: 'ALFRED answers',
    legend: 'Red is the recording; green is the answer ALFRED gives instead.',
  }));

  readonly ruleSnapshot = computed(() => ({ ruleId: null, draft: this.step().callRule as InterceptionRuleDraft, answerPath: [] as number[] }));
  /** Recreates the inline rule editor whenever the step's rule changes outside it (mode, edits, Undo). */
  readonly ruleEditorKey = computed(() => [this.step().key, this.step().callRule, this.ruleEditorRevision()]);
  readonly recordedPreview = computed(() => recordedCallPreviewOf(this.step().recording));
  readonly recordingSample = computed(() => recordingSampleCall(this.step()));

  /** What the inline rule editor's footer saves into: this step's call rule, never the global rules. */
  readonly ruleTarget: RuleEditorTarget = {
    pauseCarriesOn: true,
    save: (draft: InterceptionRuleDraft): Observable<InterceptionRuleDraft | null> => {
      const step = this.step();
      this.stepChange.emit({ ...step, callRule: { ...step.callRule, ...draft } });
      return of(draft);
    },
  };

  toggle(): void {
    this.open.set(!this.open());
  }

  select(key: string): void {
    this.leaveEdits();
    this.box.set(key as Box);
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

  setUnattributed(choice: Step['unattributed']): void {
    this.stepChange.emit({ ...this.step(), unattributed: choice });
  }

  /** Saved as "Replace the request body" in the call rule; the recorded text clears the edit. */
  setRequestBody(text: string): void {
    const step = this.step();
    const next = text === (step.recording.requestBody ?? '') ? null : text;
    if (next === requestBodyOf(step.callRule)) return;
    if (requestBodyOf(step.callRule) === null && next !== null && step.parentKey && modeOf(step.callRule) === 'REPLAY') {
      this.firstEditPending = true;
    }
    this.stepChange.emit({ ...step, callRule: setRequestBody(step.callRule, next) });
  }

  resetRequestBody(): void {
    this.setRequestBody(this.step().recording.requestBody ?? '');
    this.firstEditPending = false;
  }

  setAnswer(status: number, body: string): void {
    const step = this.step();
    this.stepChange.emit({ ...step, callRule: setMockResponse(step.callRule, step.recording, status, body) });
  }

  resetAnswer(): void {
    const rec = this.step().recording;
    this.setAnswer(rec.status, rec.responseBody ?? '');
  }

  togglePause(at: 'before' | 'after'): void {
    const step = this.step();
    const cp = checkpointOf(step.callRule);
    this.stepChange.emit({ ...step, callRule: setCheckpoint(step.callRule, at, !(at === 'before' ? cp.before : cp.after)) });
  }

  requestDiffersLabel(): string {
    const labels: Record<OnRequestChanged, string> = { FAIL: 'Mock a failure', ASK: 'Ask me', REPLAY: 'Replay recording anyway', LIVE: 'Call live ⚠' };
    return labels[this.onRequestChanged()];
  }

  undoRuleChanges(): void {
    this.ruleEditorRevision.update((n) => n + 1);
  }

  addExtractRule(rule: ExtractRule = { from: 'JSON', path: '', as: '', missing: 'SKIP' }): void {
    this.stepChange.emit({ ...this.step(), extract: [...this.step().extract, rule] });
  }

  updateExtractRule(index: number, patch: Partial<ExtractRule>): void {
    const step = this.step();
    this.stepChange.emit({ ...step, extract: step.extract.map((r, i) => {
      if (i !== index) return r;
      const next: ExtractRule = { ...r, ...patch };
      // A value a run swaps in must stand for what THIS path found in the recording - re-read it,
      // or a rule pointed somewhere else would keep replacing the old value.
      if (r.recordedValue === undefined || (patch.from === undefined && patch.path === undefined)) return next;
      const recordedValue = recordedValueOf(step, next);
      const { recordedValue: _stale, ...rest } = next;
      return recordedValue ? { ...rest, recordedValue } : rest;
    }) });
  }

  removeExtractRule(index: number): void {
    this.stepChange.emit({ ...this.step(), extract: this.step().extract.filter((_, i) => i !== index) });
  }

  setChecks(checks: StepChecks): void {
    this.stepChange.emit({ ...this.step(), assertions: checks });
  }

  /** Fields ticked in the response browser become saved values or checks on them. */
  onBrowsePicked(picks: readonly BrowsePick[]): void {
    const step = this.step();
    if (this.browseAs() === 'value') {
      const taken = new Set(step.extract.map((r) => r.as));
      const added = picks.map((pick) => ({ from: 'JSON' as const, path: pick.path, as: uniqueName(nameOf(pick.path), taken), missing: 'SKIP' as const }));
      this.stepChange.emit({ ...step, extract: [...step.extract, ...added] });
    } else {
      // Each ticked field becomes a check of its own, equal to its recorded value.
      const checks = this.checks();
      const added = picks.map((pick) => ({ combine: 'ALL' as const, onMiss: 'DEFAULT' as const, conditions: [{ subject: 'RESPONSE_JSON_FIELD' as const, name: pick.path, operator: 'EQUALS' as const, value: pick.value }] }));
      this.stepChange.emit({ ...step, assertions: { ...checks, groups: [...checks.groups, ...added] } });
    }
    this.browsing.set(false);
  }

  openOriginal(): void {
    const step = this.step();
    this.callFocus.go({ callId: step.source.callId, cycleId: step.source.cycleId, direction: step.source.direction, serviceName: step.serviceName ?? null });
  }

  toggleReveal(): void {
    this.revealed.set(!this.revealed());
  }

  readonly hasSecrets = computed(() => this.variables().some((v) => v.secret));

  mask(text: string): string {
    if (this.revealed()) return text;
    const secrets = this.variables().filter((v) => v.secret).map((v) => v.name);
    const values = Object.fromEntries(this.variables().map((v) => [v.name, v.value]));
    return maskRelive(text, secrets, values);
  }

  /** FR-014d: ask what happens when a REPLAY child's request differs - once the edit is finished. */
  private leaveEdits(): void {
    if (!this.firstEditPending) return;
    this.firstEditPending = false;
    this.requestEdited.emit(this.step().key);
  }

  private maskHttp(http: OriginalHttp): OriginalHttp {
    return {
      ...http,
      headers: Object.fromEntries(Object.entries(http.headers ?? {}).map(([name, value]) => [name, this.mask(value)])),
      body: http.body ? this.mask(http.body) : http.body,
    };
  }
}

function modeLine(mode: StepMode, child: boolean): string {
  if (mode === 'REPLAY') return 'REPLAY · ALFRED answers';
  if (mode === 'LIVE_MOCKED') return 'LIVE · mocked reply';
  return child ? 'LIVE · real supplier' : 'LIVE · sent to your app';
}

function responseOf(step: Step): { status: number; headers: Readonly<Record<string, string>>; body: string | null } {
  return { status: step.recording.status, headers: step.recording.responseHeaders, body: step.recording.responseBody ?? null };
}

function nameOf(path: string): string {
  const last = path.split(/[.[\]]/).filter((part) => part && !/^\d+$/.test(part) && part !== '$').pop() ?? 'value';
  return last.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'value';
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}
