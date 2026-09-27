import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ReliveAddCallsDialogComponent, RELIVE_ADD_CALLS_REQUESTER, ReliveAddCallsResume } from '../../components/relive-add-calls/relive-add-calls-dialog.component';
import { ReliveStepDrawerComponent } from '../../components/relive-step-drawer/relive-step-drawer.component';
import { ReliveStepTreeComponent } from '../../components/relive-step-tree/relive-step-tree.component';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { externalReach } from '../../shared/utils/relive-external-reach';
import { Step } from '../../shared/utils/relive-types';
import { CanDeactivateRelive } from './relive-unsaved-changes.guard';
import { ReliveCycleEditorState } from './relive-cycle-editor.state';

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
  imports: [RouterLink, ReliveStepTreeComponent, ReliveAddCallsDialogComponent, ReliveStepDrawerComponent],
  providers: [ReliveCycleEditorState],
  templateUrl: './relive-cycle.component.html',
})
export class ReliveCycleComponent implements CanDeactivateRelive {
  private readonly route = inject(ActivatedRoute);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly picker = inject(CallPickerService);
  readonly state = inject(ReliveCycleEditorState);

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
