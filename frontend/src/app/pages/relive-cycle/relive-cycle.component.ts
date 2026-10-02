import { Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Observable, Subscription, catchError, firstValueFrom, interval, of, switchMap, takeWhile } from 'rxjs';
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
import { ReliveApiService, StartRunRequest } from '../../core/services/relive-api.service';
import { outboundMissingFingerprint, outboundOnOldFingerprint } from '../../core/services/relive-fingerprint';
import { ReliveStepTreeComponent } from '../../components/relive-step-tree/relive-step-tree.component';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionRuleDraft, PauseDecision } from '../../core/models/interception.model';
import { InterceptionApiService } from '../../core/services/interception-api.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { ReliveRunService } from '../../core/state/relive-run.service';
import { externalReach } from '../../shared/utils/relive-external-reach';
import { CycleRule, CycleVariable, ReliveCycle, Run, Step, StepResult } from '../../shared/utils/relive-types';
import { CanDeactivateRelive } from './relive-unsaved-changes.guard';
import { reliveVariableNames } from '../../shared/utils/relive-variable-names';
import { ReliveCycleEditorState } from './relive-cycle-editor.state';
import { ReliveRuleDialogService } from './relive-rule-dialog.service';
import { recordedCallPreviewOf } from '../../shared/utils/recorded-call-match';

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
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly picker = inject(CallPickerService);
  private readonly callSource = inject(ReliveCallSourceService);
  private readonly api = inject(ReliveApiService);
  private readonly interceptionState = inject(InterceptionStateService);
  private readonly interceptionApi = inject(InterceptionApiService);
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

  /** The open call rule's frozen request, so the condition row shows URL, headers and body. */
  readonly callRulePreview = computed(() => {
    const req = this.ruleDialog.request();
    const draft = this.state.draft();
    if (!req || req.scope !== 'CALL' || !draft) return null;
    const step = draft.steps.find((s) => s.key === req.targetKey);
    return recordedCallPreviewOf(step?.recording);
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

  /** Calls of THIS run held in the proxy - request-changed holds and child checkpoints - out of
   *  the existing Paused Calls feed, decided in the run view (FR-035e). */
  readonly changedPauses = computed(() => {
    const runId = this.runService.run()?.id;
    if (!runId) return [];
    return this.interceptionState.pausedCalls().filter((c) => c.relive?.runId === runId);
  });

  decidePaused(event: { readonly callId: string; readonly decision: PauseDecision }): void {
    this.interceptionApi.decide(event.callId, event.decision).subscribe({
      error: () => this.actionError.set('That call is no longer waiting - it was already decided or timed out.'),
    });
  }

  /** A past run opened from the History tab (T072), in the same timeline as a live run.
   *  One that is still RUNNING can be stopped from this view. */
  readonly historyRun = signal<{ readonly run: Run; readonly results: Readonly<Record<string, StepResult>> } | null>(null);
  readonly stopping = signal(false);
  /** The run on screen when it is still going, otherwise the one this page is driving. */
  readonly stoppableRun = computed(() => {
    const opened = this.historyRun()?.run;
    if (opened?.status === 'RUNNING') return opened;
    const live = this.runService.run();
    return live?.status === 'RUNNING' ? live : null;
  });
  readonly actionError = signal<string | null>(null);
  private handlingPicker = false;
  /** Refresh of a RUNNING run shown from History while this page is already driving a different one. */
  private historyWatch: Subscription | null = null;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.state.load(id);
      this.restoreLatestRun(id);
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
    if (!this.state.saved()) return;
    // Same pre-run check as Run (FR-016/SC-003): a later step can still reach a real system.
    this.pendingRunFrom.set({ fromStepKey: stepKey, seedFromRunId: seedFromRun.id });
    this.openPrerun();
  }

  /** Set while the pre-run dialog was opened by "Run from here". */
  private readonly pendingRunFrom = signal<{ readonly fromStepKey: string; readonly seedFromRunId: string } | null>(null);

  /** The historical run's own variables, for the read-only timeline's "Run from here" check -
   *  seed values plus every value the run's timeline recorded, latest wins. */
  finalVariablesOf(run: Run): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const v of run.definition.variables) vars[v.name] = v.value;
    for (const v of run.seedVariables) vars[v.name] = v.value;
    for (const entry of run.variableTimeline) vars[entry.name] = entry.value;
    return vars;
  }

  /** Latest run's variables, and the run itself when this page is not already driving it.
   *  A reload destroys the in-browser driver and, 15s after the socket drops, the server marks
   *  the run interrupted. Re-take the lease as soon as the list says it is still running, then
   *  show that run and keep following it. A step already sent is settled from the logged call
   *  instead of being sent again. If the interrupt already won, still open the Run tab on the
   *  step where it stopped. */
  private restoreLatestRun(cycleId: string): void {
    this.api.listRuns(cycleId, 1).pipe(
      switchMap((runs) => {
        const latest = runs[0];
        if (!latest) return of(null);
        if (latest.status === 'RUNNING') this.runService.retain(latest.id);
        return this.api.getRun(cycleId, latest.id);
      }),
      catchError(() => of(null)),
    ).subscribe((run) => {
      if (!run) return;
      this.lastRunVariables.set(this.finalVariablesOf(run));
      if (this.runService.run()?.status === 'RUNNING' || this.historyRun()) return;
      if (run.status === 'RUNNING') {
        this.runService.adopt(run);
        this.runService.continueAdopted();
        this.setTab('run');
        return;
      }
      this.runService.release(run.id);
      if (run.status === 'INTERRUPTED') {
        this.runService.adopt(run);
        this.setTab('run');
      }
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

  /** A past run opens as a snapshot. A run that is still going opens on the live driver:
   *  the snapshot hides that driver and leaves the in-progress step on its last saved result.
   *  continueAdopted settles a step already sent from the logged call and does not send it again.
   *  A different run this page is actively driving is left alone. */
  openHistoryRun(runId: string): void {
    const cycle = this.state.saved();
    if (!cycle) return;
    const driving = this.runService.run();
    if (driving?.id === runId) {
      this.attachLiveRun(driving.status === 'RUNNING');
      return;
    }
    this.api.getRun(cycle.id, runId).subscribe((run) => {
      if (run.status !== 'RUNNING') {
        this.showHistorySnapshot(cycle.id, run);
        return;
      }
      const current = this.runService.run();
      if (current?.status === 'RUNNING' && current.id !== run.id) {
        this.showHistorySnapshot(cycle.id, run);
        return;
      }
      if (!(current?.id === run.id && current.status === 'RUNNING')) this.runService.adopt(run);
      this.attachLiveRun(true);
    });
  }

  /** Drop the history snapshot and show the run this page is driving. `follow` resumes the loop
   *  when it is not already going; a hold and an already-started loop stay as they are. */
  private attachLiveRun(follow: boolean): void {
    this.stopHistoryWatch();
    this.historyRun.set(null);
    this.setTab('run');
    if (follow) this.runService.continueAdopted();
  }

  /** A history snapshot is one fetch, so a run that is still going keeps moving underneath it.
   *  Follow that run until it settles. The run this page itself is driving is never shown this way. */
  private showHistorySnapshot(cycleId: string, run: Run & { readonly stepResults: readonly StepResult[] }): void {
    this.stopHistoryWatch();
    this.historyRun.set({ run, results: latestResults(run.stepResults) });
    this.setTab('run');
    if (run.status !== 'RUNNING') return;
    this.historyWatch = interval(1000).pipe(
      switchMap(() => this.api.getRun(cycleId, run.id).pipe(catchError(() => of(null)))),
      takeWhile((next) => next?.status === 'RUNNING', true),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((next) => {
      if (!next || this.historyRun()?.run.id !== next.id) return;
      this.historyRun.set({ run: next, results: latestResults(next.stepResults) });
    });
  }

  private stopHistoryWatch(): void {
    this.historyWatch?.unsubscribe();
    this.historyWatch = null;
  }

  /** Stops the run opened from History, or the one this page is still driving. */
  async stopDisplayedRun(): Promise<void> {
    const shown = this.stoppableRun();
    const cycle = this.state.saved();
    if (!shown || !cycle || this.stopping()) return;
    this.stopHistoryWatch();
    this.stopping.set(true);
    this.actionError.set(null);
    try {
      const live = this.runService.run();
      if (live?.id === shown.id) {
        await this.runService.stop();
        const stopped = this.runService.run();
        const opened = this.historyRun();
        if (stopped && opened?.run.id === stopped.id) {
          this.historyRun.set({ run: { ...opened.run, ...stopped }, results: { ...this.runService.results() } });
        }
        return;
      }
      await firstValueFrom(this.api.stopRun(cycle.id, shown.id));
      const full = await firstValueFrom(this.api.getRun(cycle.id, shown.id));
      this.historyRun.set({ run: full, results: latestResults(full.stepResults) });
    } catch (error: any) {
      this.actionError.set(error?.error?.error ?? error?.message ?? 'Could not stop the run.');
    } finally {
      this.stopping.set(false);
    }
  }

  closeHistoryRun(): void {
    this.stopHistoryWatch();
    this.historyRun.set(null);
  }

  setName(name: string): void {
    this.state.update((draft) => ({ ...draft, name }));
  }

  setDescription(description: string): void {
    this.state.update((draft) => ({ ...draft, description }));
  }

  /** FR-044a: an edit saved while a run of this cycle is going asks whether it applies to that
   *  run too (steps it has not run yet; the run's snapshot is republished) or only to next runs. */
  async save(): Promise<void> {
    let saved: ReliveCycle;
    try {
      saved = await this.state.saveAsync();
    } catch {
      return; // saveError is already shown
    }
    const live = this.runService.run();
    if (live?.status !== 'RUNNING' || live.cycleId !== saved.id) return;
    const thisRun = await this.confirmDialog.confirm(
      'A run of this cycle is in progress. Apply these changes to this run too? Steps it already ran never change.',
      'Apply to this run too',
      'Only next runs',
    );
    if (!thisRun) return;
    try {
      await this.runService.applyDefinitionEdit(saved, 'Edited while the run was going');
    } catch (error: unknown) {
      const conflict = (error as { status?: number })?.status === 409;
      this.actionError.set(conflict
        ? 'A changed step already ran in this run, so the change applies to next runs only.'
        : 'Could not apply the change to this run. It applies to next runs.');
    }
  }

  readonly keeping = signal(false);

  /** "Save as cycle" on a Relive now quick run, during or after its run (FR-003c). Pending edits
   *  are saved first so nothing typed is lost. */
  async keepQuickRun(): Promise<void> {
    const saved = this.state.saved();
    if (!saved || this.keeping()) return;
    this.keeping.set(true);
    this.actionError.set(null);
    try {
      if (this.state.dirty()) await this.state.saveAsync();
      await firstValueFrom(this.api.keep(saved.id));
      this.state.load(saved.id);
    } catch (error: unknown) {
      this.actionError.set(error instanceof Error ? error.message : 'Could not save this quick run as a cycle.');
    } finally {
      this.keeping.set(false);
    }
  }

  duplicate(): void {
    this.state.duplicateCycle()?.subscribe();
  }

  readonly oldFingerprints = computed(() => outboundOnOldFingerprint(this.state.draft()?.steps ?? []));
  readonly missingFingerprints = computed(() => outboundMissingFingerprint(this.state.draft()?.steps ?? []));
  readonly rebuildingFingerprints = signal(false);
  readonly stampingFingerprints = signal(false);

  /** Computes hashes that were never stored. A dirty draft is left alone; Save already restamps. */
  stampFingerprints(): void {
    const saved = this.state.saved();
    if (!saved || this.state.dirty() || this.stampingFingerprints() || this.rebuildingFingerprints()) return;
    this.stampingFingerprints.set(true);
    this.actionError.set(null);
    this.api.fingerprint(saved.id).subscribe({
      next: () => {
        this.stampingFingerprints.set(false);
        this.state.load(saved.id);
      },
      error: (error: { error?: { message?: string } }) => {
        this.stampingFingerprints.set(false);
        this.actionError.set(error?.error?.message ?? 'Could not fingerprint supplier steps.');
      },
    });
  }

  /** Recomputes stored hashes that are not SEMANTIC_V1. A dirty draft is left alone; Save already restamps. */
  rebuildFingerprints(): void {
    const saved = this.state.saved();
    if (!saved || this.state.dirty() || this.rebuildingFingerprints() || this.stampingFingerprints()) return;
    this.rebuildingFingerprints.set(true);
    this.actionError.set(null);
    this.api.fingerprint(saved.id, true).subscribe({
      next: () => {
        this.rebuildingFingerprints.set(false);
        this.state.load(saved.id);
      },
      error: (error: { error?: { message?: string } }) => {
        this.rebuildingFingerprints.set(false);
        this.actionError.set(error?.error?.message ?? 'Could not rebuild fingerprints.');
      },
    });
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
    this.pendingRunFrom.set(null);
  }

  /** A run loads the stored fingerprints. It does not compute the ones that are still missing. */
  private async launchRun(cycle: ReliveCycle, request: StartRunRequest): Promise<void> {
    this.setTab('run');
    await this.runService.start(cycle, request);
  }

  async startRun(request: ReliveStartRequest): Promise<void> {
    this.actionError.set(null);
    // Read before any await: the dialog's own close clears it.
    const from = this.pendingRunFrom();
    this.pendingRunFrom.set(null);
    try {
      const cycle = this.state.dirty() ? await this.state.saveAsync() : this.state.saved();
      if (!cycle) throw new Error('Cycle has not loaded yet.');
      if (!cycle.steps.some((step) => step.enabled)) throw new Error('Add calls before starting a run.');
      this.stopHistoryWatch();
      this.historyRun.set(null);
      await this.launchRun(cycle, { driver: from ? 'AUTOMATIC' : request.driver, unattributedChoices: {}, ...(from ?? {}) });
    } catch (error: any) {
      this.actionError.set(this.state.saveError() ?? error?.error?.message ?? error?.message ?? 'Could not start the run. Check the cycle and try again.');
    }
  }

  async canDeactivate(): Promise<boolean> {
    if (!this.state.dirty()) return true;
    return this.confirmDialog.confirm('Leave without saving your changes?', 'Leave');
  }
}

function latestResults(results: readonly StepResult[]): Record<string, StepResult> {
  const latest: Record<string, StepResult> = {};
  for (const result of results) {
    const existing = latest[result.stepKey];
    if (!existing || result.attempt > existing.attempt) latest[result.stepKey] = result;
  }
  return latest;
}

function hostOf(step: Step): string {
  try {
    return new URL(step.recording.url).host;
  } catch {
    return step.recording.url;
  }
}
