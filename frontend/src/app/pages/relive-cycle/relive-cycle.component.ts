import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { ReliveAddCallsDialogComponent, RELIVE_ADD_CALLS_REQUESTER, ReliveAddCallsResume } from '../../components/relive-add-calls/relive-add-calls-dialog.component';
import { RuleEditorComponent } from '../../components/rule-editor/rule-editor.component';
import { ReliveStepDrawerComponent } from '../../components/relive-step-drawer/relive-step-drawer.component';
import { ReliveStepTreeComponent } from '../../components/relive-step-tree/relive-step-tree.component';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionRuleDraft } from '../../core/models/interception.model';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { externalReach } from '../../shared/utils/relive-external-reach';
import { Step } from '../../shared/utils/relive-types';
import { CanDeactivateRelive } from './relive-unsaved-changes.guard';
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
  imports: [RouterLink, ReliveStepTreeComponent, ReliveAddCallsDialogComponent, ReliveStepDrawerComponent, RuleEditorComponent],
  providers: [ReliveCycleEditorState],
  templateUrl: './relive-cycle.component.html',
})
export class ReliveCycleComponent implements CanDeactivateRelive {
  private readonly route = inject(ActivatedRoute);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly picker = inject(CallPickerService);
  readonly state = inject(ReliveCycleEditorState);
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
        const exists = targetKey && cycle.cycleRules.some((r) => (r as { id?: string }).id === targetKey);
        const rules = exists
          ? cycle.cycleRules.map((r) => ((r as { id?: string }).id === targetKey ? { ...r, ...draft } : r))
          : [...cycle.cycleRules, draft as typeof cycle.cycleRules[number]];
        return { ...cycle, cycleRules: rules };
      });
      return;
    }
    if (scope === 'UNEXPECTED') {
      this.state.update((cycle) => {
        const rules = cycle.unexpectedCalls.rules;
        const exists = targetKey && rules.some((r) => (r as { id?: string }).id === targetKey);
        const updated = exists
          ? rules.map((r) => ((r as { id?: string }).id === targetKey ? { ...r, ...draft } : r))
          : [...rules, draft as typeof rules[number]];
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
      ruleDraft = req.targetKey ? (draft.cycleRules.find((r) => (r as { id?: string }).id === req.targetKey) ?? null) : null;
    } else {
      ruleDraft = req.targetKey ? (draft.unexpectedCalls.rules.find((r) => (r as { id?: string }).id === req.targetKey) ?? null) : null;
    }
    return { ruleId: null, draft: ruleDraft ?? { name: '', match: {}, actions: [] }, answerPath: [] };
  });

  openCallRule(stepKey: string): void {
    this.ruleDialog.open('CALL', stepKey, null);
  }

  /** T038 (request-differs dialog) isn't built yet - opening the call rule editor directly is the
   *  interim way to change the request-differs condition. */
  openRequestDiffers(stepKey: string): void {
    this.openCallRule(stepKey);
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

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.state.load(id);
    this.handleReturnFromPicker();
  }

  /** After "Pick from anywhere" sends the user off to pick and back (research: the pick bar
   *  pattern) - append whatever they picked, the same way "Add calls" does directly. */
  private handleReturnFromPicker(): void {
    if (!this.picker.hasResult(RELIVE_ADD_CALLS_REQUESTER)) return;
    const result = this.picker.takeResult(RELIVE_ADD_CALLS_REQUESTER);
    if (!result || !result.picked.length) return;
    const resume = result.resume as ReliveAddCallsResume;
    const draft = this.state.draft();
    if (!draft || draft.id !== resume.cycleId) return;
    const steps = freezeCalls(
      result.picked.map((p) => p.call),
      new Map(),
      draft.settings,
    );
    this.appendSteps(steps);
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

  selectStep(key: string): void {
    this.state.selectedStepKey.set(this.state.selectedStepKey() === key ? null : key);
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
