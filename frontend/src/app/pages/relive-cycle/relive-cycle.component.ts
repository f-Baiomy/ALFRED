import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ReliveAddCallsDialogComponent, RELIVE_ADD_CALLS_REQUESTER, ReliveAddCallsResume } from '../../components/relive-add-calls/relive-add-calls-dialog.component';
import { ReliveStepTreeComponent } from '../../components/relive-step-tree/relive-step-tree.component';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
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
  imports: [RouterLink, ReliveStepTreeComponent, ReliveAddCallsDialogComponent],
  providers: [ReliveCycleEditorState],
  templateUrl: './relive-cycle.component.html',
})
export class ReliveCycleComponent implements CanDeactivateRelive {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ReliveApiService);
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
    const id = this.state.saved()?.id;
    if (!id) return;
    this.api.duplicate(id).subscribe();
  }

  async canDeactivate(): Promise<boolean> {
    if (!this.state.dirty()) return true;
    return this.confirmDialog.confirm('Leave without saving your changes?', 'Leave');
  }
}
