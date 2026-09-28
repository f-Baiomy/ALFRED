import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Observable, catchError, of, switchMap } from 'rxjs';
import { ReliveAddCallsDialogComponent, RELIVE_ADD_CALLS_REQUESTER, ReliveAddCallsResume } from '../../components/relive-add-calls/relive-add-calls-dialog.component';
import { RuleEditorComponent } from '../../components/rule-editor/rule-editor.component';
import { ReliveStepDrawerComponent } from '../../components/relive-step-drawer/relive-step-drawer.component';
import { ReliveRequestDiffersDialogComponent } from '../../components/relive-request-differs-dialog/relive-request-differs-dialog.component';
import { ReliveExternalNoticeComponent } from '../../components/relive-external-notice/relive-external-notice.component';
import { ReliveRulesTabComponent } from '../../components/relive-rules-tab/relive-rules-tab.component';
import { ReliveRerunSummaryComponent, ReliveStartRequest } from '../../components/relive-prerun-summary/relive-prerun-summary.component';
import { ReliveRebuildDialogComponent } from '../../components/relive-rebuild-dialog/relive-rebuild-dialog.component';
import { ReliveVariablesComponent } from '../../components/relive-variables/relive-variables.component';
import { ReliveRunTimelineComponent } from '../../components/relive-run-timeline/relive-run-timeline.component';
import { ReliveHistoryComponent } from '../../components/relive-history/relive-history.component';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ReliveStepTreeComponent } from '../../components/relive-step-tree/relive-step-tree.component';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionRuleDraft } from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { ReliveRunService } from '../../core/state/relive-run.service';
import { externalReach } from '../../shared/utils/relive-external-reach';
import { CycleRule, CycleVariable, ReliveCycle, Run, Step, StepResult } from '../../shared/utils/relive-types';
import { CanDeactivateRelive } from './relive-unsaved-changes.guard';
import { reliveVariableNames } from '../../shared/utils/relive-variable-names';
import { ReliveCycleEditorState } from './relive-cycle-editor.state';
import { ReliveRuleDialogService } from './relive-rule-dialog.service';

type ReliveTab = 'steps' | 'variables' | 'rules' | 'run' | 'history';

/**
 * The single-cycle editor/run page (mock.html `cycleView()`): header with editable name and
 * description, the badge row, the tabs, and Save/Rebuild/Duplicate/Run. The Steps tab's tree
 * (T025), the Run tab's live timeline (US3) and the Rebuild flow (T028/US6) are filled in by
 * later tasks - this shell renders their placeholders until then.
 */
@Component({
  selector: 'app-relive-cycle',
  standalone: true,
  imports: [
    RouterLink,
    ReliveStepTreeComponent,
    ReliveAddCallsDialogComponent,
    ReliveStepDrawerComponent,
    RuleEditorComponent,
    ReliveRequestDiffersDialogComponent,
    ReliveExternalNoticeComponent,
    ReliveRulesTabComponent,
    ReliveRerunSummaryComponent,
    ReliveRebuildDialogComponent,
    ReliveVariablesComponent,
    ReliveRunTimelineComponent,
    ReliveHistoryComponent,
  ],
  providers: [ReliveCycleEditorState, ReliveRunService],
  templateUrl: './relive-cycle.component.html',
})
export class ReliveCycleComponent implements CanDeactivateRelive {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly picker = inject(CallPickerService);
  private readonly callSource = inject(ReliveCallSourceService);
  private readonly api = inject(ReliveApiService);
  private readonly interceptionState = inject(InterceptionStateService);
  readonly state = inject(ReliveCycleEditorState);
  readonly reliveVariableHints = computed(() => {
    const draft = this.state.draft();
    return draft
      ? [...reliveVariableNames(draft).entries()].map(([name, secret]) => ({ name, secret }))
      : [];
  });
  readonly reliveVariableHintsJson = computed(() => JSON.stringify(this.reliveVariableHints()));
  readonly enabledCycleRuleCount = computed(() => this.state.draft()?.cycleRules.filter((rule) => rule.enabled !== false).length ?? 0);
  readonly runService = inject(ReliveRunService);
  readonly lastRunVariables = signal<Readonly<Record<string, string>> | null>(null);
  readonly displayedVariableCount = computed(() => {
    const draft = this.state.draft();
    if (!draft) return 0;
    const runValues = this.runService.run() ? this.runService.variables() : this.lastRunVariables();
    return new Set([...draft.variables.map((variable) => variable.name), ...Object.keys(runValues ?? {})]).size;
  });
  readonly ruleDialog = inject(ReliveRuleDialogService);
  /** Provided to `<app-rule-editor>` via this component's own template - see the getter below.
   *  A getter (not a field) so it always closes over the CURRENT draft/ruleDialog request. */
  get ruleEditorTarget(): { save(draft: InterceptionRuleDraft, ruleId: string | null): Observable<InterceptionRuleDraft | null> } {
    return this.ruleDialog.targetFor((scope, targetKey, draft) => this.applyRuleSave(scope, targetKey, draft));
  }

  private applyRuleSave(scope: 'CYCLE' | 'CALL' | 'UNEXPECTED', targetKey: string | null, draft: InterceptionRuleDraft): void {
    if (scope === 'CALL' && targetKey) {
      this.state.update((cycle) => ({
        ...cycle,
        steps: cycle.steps.map((s) => (s.key === targetKey ? { ...s, callRule: { ...s.callRule, ...draft } } : s)),
      }));
      return;
    }
    if (scope === 'CYCLE') {
      this.state.update((cycle) => {
        const index = targetKey === null ? -1 : Number(targetKey);
        const rules =
          index >= 0 && index < cycle.cycleRules.length
            ? cycle.cycleRules.map((r, i) => (i === index ? { ...r, ...draft } : r))
            : [...cycle.cycleRules, draft as (typeof cycle.cycleRules)[number]];
        return { ...cycle, cycleRules: rules };
      });
      return;
    }
    if (scope === 'UNEXPECTED') {
      this.state.update((cycle) => {
        const index = targetKey === null ? -1 : Number(targetKey);
        const rules = cycle.unexpectedCalls.rules;
        const updated =
          index >= 0 && index < rules.length
            ? rules.map((r, i) => (i === index ? { ...r, ...draft } : r))
            : [...rules, draft as (typeof rules)[number]];
        return { ...cycle, unexpectedCalls: { ...cycle.unexpectedCalls, rules: updated } };
      });
    }
  }

  /** What `<app-rule-editor>` opens with - the target's rule document as an unsaved draft
   *  (never a saved `InterceptionRule`, since none of these three kinds are ever saved globally). */
  readonly ruleEditorSnapshot = computed(() => {
    const req = this.ruleDialog.request();
    const draft = this.state.draft();
    if (!req || !draft) return null;
    let ruleDraft: InterceptionRuleDraft | null = null;
    if (req.scope === 'CALL') {
      const step = draft.steps.find((s) => s.key === req.targetKey);
      ruleDraft = step?.callRule ?? null;
    } else if (req.scope === 'CYCLE') {
      ruleDraft = req.targetKey !== null ? (draft.cycleRules[Number(req.targetKey)] ?? null) : null;
    } else {
      ruleDraft = req.targetKey !== null ? (draft.unexpectedCalls.rules[Number(req.targetKey)] ?? null) : null;
    }
    return { ruleId: null, draft: ruleDraft ?? { name: '', match: {}, actions: [] }, answerPath: [] };
  });

  openCallRule(stepKey: string): void {
    this.ruleDialog.open('CALL', stepKey, null);
  }

  readonly requestDiffersStepKey = signal<string | null>(null);
  readonly requestDiffersStep = computed(() => {
    const key = this.requestDiffersStepKey();
    return key ? (this.state.draft()?.steps.find((s) => s.key === key) ?? null) : null;
  });

  openRequestDiffers(stepKey: string): void {
    this.requestDiffersStepKey.set(stepKey);
  }

  closeRequestDiffers(): void {
    this.requestDiffersStepKey.set(null);
  }

  orderLabelFor(step: Step): string | null {
    const draft = this.state.draft();
    if (!draft || !step.parentKey) return null;
    const parent = draft.steps.find((s) => s.key === step.parentKey);
    if (!parent) return null;
    const siblings = draft.steps.filter((s) => s.parentKey === step.parentKey && hostOf(s) === hostOf(step));
    const index = siblings.findIndex((s) => s.key === step.key);
    return `#${index + 1} in ${parent.label}`;
  }

  readonly tab = signal<ReliveTab>('steps');
  readonly addCallsOpen = signal(false);

  readonly topSteps = computed(() => this.state.draft()?.steps.filter((s) => !s.parentKey) ?? []);
  readonly childSteps = computed(() => this.state.draft()?.steps.filter((s) => s.parentKey) ?? []);
  readonly externalCount = computed(() => {
    const draft = this.state.draft();
    return draft ? externalReach(draft).size : 0;
  });
  readonly selectedStep = computed(() => {
    const key = this.state.selectedStepKey();
    return key ? (this.state.draft()?.steps.find((s) => s.key === key) ?? null) : null;
  });

  /** Request-changed holds (T056) for THIS run only, out of the existing Paused Calls feed. */
  readonly changedPauses = computed(() => {
    const runId = this.runService.run()?.id;
    if (!runId) return [];
    return this.interceptionState.pausedCalls().filter((c) => c.relive?.runId === runId && c.relive?.at === 'CHANGED');
  });

  /** A past run opened from the History tab (T072) - shown read-only in the same timeline
   *  component the live run uses, since it's pure input/output either way. */
  readonly historyRun = signal<{ readonly run: Run; readonly results: Readonly<Record<string, StepResult>> } | null>(null);
  readonly actionError = signal<string | null>(null);
  private handlingPicker = false;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.state.load(id);
      this.restoreLatestRunVariables(id);
    }
    effect(() => {
      const draft = this.state.draft();
      if (draft && this.picker.hasResult(RELIVE_ADD_CALLS_REQUESTER)) void this.handleReturnFromPicker(draft);
    });
  }

  /** After "Pick from anywhere" sends the user off to pick and back (research: the pick bar
   *  pattern) - append whatever they picked, the same way "Add calls" does directly. */
  private async handleReturnFromPicker(draft: ReliveCycle): Promise<void> {
    if (this.handlingPicker) return;
    const result = this.picker.peekResult(RELIVE_ADD_CALLS_REQUESTER);
    if (!result || (result.resume as ReliveAddCallsResume | null)?.cycleId !== draft.id) return;
    this.handlingPicker = true;
    try {
      if (result.picked.length) {
        const steps = await this.callSource.freezePicked(result.picked, draft.settings);
        this.appendSteps(steps);
      }
      this.picker.takeResult(RELIVE_ADD_CALLS_REQUESTER);
    } catch {
      this.actionError.set('Could not load the picked calls. Reload this page to retry.');
    } finally {
      this.handlingPicker = false;
    }
  }

  openAddCalls(): void {
    this.addCallsOpen.set(true);
  }

  appendSteps(steps: readonly Step[]): void {
    this.state.update((draft) => ({ ...draft, steps: [...draft.steps, ...steps] }));
  }

  updateStep(step: Step): void {
    this.state.update((draft) => ({ ...draft, steps: draft.steps.map((s) => (s.key === step.key ? step : s)) }));
  }

  async resetCycle(): Promise<void> {
    const confirmed = await this.confirmDialog.confirm('Reset every step to its recording? Every call rule edit is removed. This can\'t be undone.', 'Reset');
    if (confirmed) this.state.resetCycle();
  }

  async resetStep(key: string): Promise<void> {
    const step = this.state.draft()?.steps.find((s) => s.key === key);
    const defaultDescription = step?.parentKey ? 'REPLAY' : 'LIVE (sent to the app)';
    const confirmed = await this.confirmDialog.confirm(
      `Reset ${step?.label ?? 'this step'}'s call rule? Everything you changed - actions, edited mock data, pauses, conditions, the match - is removed and rebuilt from the recording with the cycle default: ${defaultDescription}. This can't be undone.`,
      'Reset call rule',
    );
    if (confirmed) this.state.resetStep(key);
  }

  duplicateStep(key: string): void {
    this.state.duplicateStep(key);
  }

  setTab(tab: ReliveTab): void {
    this.tab.set(tab);
  }

  setSteps(steps: readonly Step[]): void {
    this.state.update((draft) => ({ ...draft, steps: [...steps] }));
  }

  setCycle(updated: ReliveCycle): void {
    this.state.update(() => updated);
  }

  selectStep(key: string): void {
    this.state.selectedStepKey.set(this.state.selectedStepKey() === key ? null : key);
  }

  setVariables(variables: readonly CycleVariable[]): void {
    this.state.update((draft) => ({ ...draft, variables }));
  }

  /** Row-actions on a paused call currently only surface that a request-changed hold exists - the
   *  release/abort/edit decision itself is the existing Paused Calls inspector's job. */
  openPausedCallInInterception(_callId: string): void {
    this.router.navigate(['/interception']);
  }

  resumeFromStep(afterStepKey: string): void {
    const cycle = this.state.saved();
    const run = this.runService.run();
    if (!cycle || !run) return;
    this.runService.resume(cycle.id, run.id, afterStepKey);
  }

  /** "Run from here" (T075): a NEW run, seeded from whichever run's row it was clicked on (the
   *  live one, or a past one opened from History) - never the run currently on screen unless
   *  that's the same one. */
  runFromHere(stepKey: string, seedFromRun: Run): void {
    const cycle = this.state.saved();
    if (!cycle) return;
    this.historyRun.set(null);
    this.runService.start(cycle, { driver: 'AUTOMATIC', fromStepKey: stepKey, seedFromRunId: seedFromRun.id, unattributedChoices: {} });
    this.setTab('run');
  }

  /** The historical run's own variables, for the read-only timeline's "Run from here" check -
   *  seed values plus every value the run's timeline recorded, latest wins. */
  finalVariablesOf(run: Run): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const v of run.definition.variables) vars[v.name] = v.value;
    for (const v of run.seedVariables) vars[v.name] = v.value;
    for (const entry of run.variableTimeline) vars[entry.name] = entry.value;
    return vars;
  }

  private restoreLatestRunVariables(cycleId: string): void {
    this.api.listRuns(cycleId, 1).pipe(
      switchMap((runs) => runs.length ? this.api.getRun(cycleId, runs[0].id) : of(null)),
      catchError(() => of(null)),
    ).subscribe((run) => {
      if (run) this.lastRunVariables.set(this.finalVariablesOf(run));
    });
  }

  /** "Mock with it" (T074): a draft edit like any other in the Steps tab - applied to `state`'s
   *  draft, left dirty for the user to Save (mock.html's `applyMockWith` behaves the same way). */
  applyMockWith(event: { readonly stepKey: string; readonly callRule: CycleRule }): void {
    this.state.update((draft) => ({
      ...draft,
      steps: draft.steps.map((s) => (s.key === event.stepKey ? { ...s, callRule: event.callRule } : s)),
    }));
  }

  openHistoryRun(runId: string): void {
    const cycle = this.state.saved();
    if (!cycle) return;
    this.api.getRun(cycle.id, runId).subscribe((run) => {
      const results: Record<string, StepResult> = {};
      for (const r of run.stepResults) {
        const existing = results[r.stepKey];
        if (!existing || r.attempt > existing.attempt) results[r.stepKey] = r;
      }
      this.historyRun.set({ run, results });
      this.setTab('run');
    });
  }

  closeHistoryRun(): void {
    this.historyRun.set(null);
  }

  setName(name: string): void {
    this.state.update((draft) => ({ ...draft, name }));
  }

  setDescription(description: string): void {
    this.state.update((draft) => ({ ...draft, description }));
  }

  save(): void {
    this.state.save();
  }

  duplicate(): void {
    this.state.duplicateCycle()?.subscribe();
  }

  readonly rebuildOpen = signal(false);

  /** Rebuild (T070) persists straight to the SAVED cycle - a dirty draft would silently discard
   *  local edits, so ask first rather than opening the dialog on top of them. */
  async openRebuild(): Promise<void> {
    if (this.state.dirty()) {
      const confirmed = await this.confirmDialog.confirm('Rebuild replaces the saved cycle directly - save or discard your changes first. Discard them now?', 'Discard and continue');
      if (!confirmed) return;
      const saved = this.state.saved();
      if (saved) this.state.update(() => saved);
    }
    this.rebuildOpen.set(true);
  }

  readonly prerunOpen = signal(false);

  openPrerun(): void {
    this.actionError.set(null);
    this.prerunOpen.set(true);
  }

  closePrerun(): void {
    this.prerunOpen.set(false);
  }

  async startRun(request: ReliveStartRequest): Promise<void> {
    this.actionError.set(null);
    try {
      const cycle = this.state.dirty() ? await this.state.saveAsync() : this.state.saved();
      if (!cycle) throw new Error('Cycle has not loaded yet.');
      if (!cycle.steps.some((step) => step.enabled)) throw new Error('Add calls before starting a run.');
      this.historyRun.set(null);
      const running = this.runService.start(cycle, { driver: request.driver, unattributedChoices: {} });
      this.setTab('run');
      await running;
    } catch (error: any) {
      this.actionError.set(this.state.saveError() ?? error?.error?.message ?? error?.message ?? 'Could not start the run. Check the cycle and try again.');
    }
  }

  async canDeactivate(): Promise<boolean> {
    if (!this.state.dirty()) return true;
    return this.confirmDialog.confirm('Leave without saving your changes?', 'Leave');
  }
}

function hostOf(step: Step): string {
  try {
    return new URL(step.recording.url).host;
  } catch {
    return step.recording.url;
  }
}
