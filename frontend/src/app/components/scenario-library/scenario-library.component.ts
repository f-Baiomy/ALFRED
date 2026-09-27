import { Component, inject, output, signal } from '@angular/core';
import { ScenarioApiService } from '../../core/services/scenario-api.service';
import { ScenarioStateService } from '../../core/services/scenario-state.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { Scenario } from '../../shared/utils/scenario-types';

/**
 * D1 - the scenario list: name, last run summary, open/rename/delete. Lives in the resend dialog's
 * `.br-scenario-slot` (see INTEGRATION.md) as well as anywhere else a scenario picker is wanted.
 */
@Component({
  selector: 'app-scenario-library',
  standalone: true,
  templateUrl: './scenario-library.component.html',
})
export class ScenarioLibraryComponent {
  private readonly api = inject(ScenarioApiService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  readonly state = inject(ScenarioStateService);

  /** Emits the FULL scenario (definition included) once fetched - GET /scenarios list omits it. */
  readonly opened = output<Scenario>();

  readonly renamingId = signal<string | null>(null);
  readonly renameValue = signal('');
  readonly busyId = signal<string | null>(null);
  readonly actionError = signal('');

  constructor() {
    this.state.load();
    this.state.watchForChanges();
  }

  open(scenario: Scenario): void {
    this.busyId.set(scenario.id);
    this.actionError.set('');
    this.api.get(scenario.id).subscribe({
      next: (full) => {
        this.busyId.set(null);
        this.opened.emit(full);
      },
      error: () => {
        this.busyId.set(null);
        this.actionError.set(`Could not open "${scenario.name}".`);
      },
    });
  }

  startRename(scenario: Scenario): void {
    this.renamingId.set(scenario.id);
    this.renameValue.set(scenario.name);
  }

  cancelRename(): void {
    this.renamingId.set(null);
  }

  confirmRename(scenario: Scenario): void {
    const name = this.renameValue().trim();
    if (!name) return;
    this.busyId.set(scenario.id);
    this.api.get(scenario.id).subscribe({
      next: (full) => {
        this.api.update(scenario.id, { name, description: full.description, definition: full.definition! }).subscribe({
          next: () => {
            this.busyId.set(null);
            this.renamingId.set(null);
            this.state.refresh();
          },
          error: () => {
            this.busyId.set(null);
            this.actionError.set(`Could not rename "${scenario.name}".`);
          },
        });
      },
      error: () => {
        this.busyId.set(null);
        this.actionError.set(`Could not rename "${scenario.name}".`);
      },
    });
  }

  async remove(scenario: Scenario): Promise<void> {
    const confirmed = await this.confirmDialog.confirm(`Delete scenario "${scenario.name}"? This also deletes its run history.`, 'Delete');
    if (!confirmed) return;
    this.busyId.set(scenario.id);
    this.state.remove(scenario.id);
    this.busyId.set(null);
  }
}
