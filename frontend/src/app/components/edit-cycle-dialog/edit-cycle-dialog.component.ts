import { Component, effect, inject, signal } from '@angular/core';
import { EditCycleDialogService } from '../../core/services/edit-cycle-dialog.service';

/** Styled name + assignedTo edit form, replacing the previous window.prompt()-based rename (which had no assignedTo field at all). */
@Component({
  selector: 'app-edit-cycle-dialog',
  standalone: true,
  templateUrl: './edit-cycle-dialog.component.html',
})
export class EditCycleDialogComponent {
  private readonly service = inject(EditCycleDialogService);
  readonly state = this.service.state;

  readonly name = signal('');
  readonly assignedTo = signal('');

  constructor() {
    effect(
      () => {
        const cycle = this.state();
        if (!cycle) return;
        this.name.set(cycle.name);
        this.assignedTo.set(cycle.assignedTo ?? '');
      },
      { allowSignalWrites: true }
    );
  }

  cancel(): void {
    this.service.cancel();
  }

  save(): void {
    const name = this.name().trim();
    if (!name) return;
    this.service.submit({ name, assignedTo: this.assignedTo().trim() || null });
  }
}
