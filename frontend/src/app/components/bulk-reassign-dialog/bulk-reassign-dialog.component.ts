import { Component, inject, signal } from '@angular/core';
import { BulkReassignDialogService } from '../../core/services/bulk-reassign-dialog.service';

/** Styled single-field form for the "Change assigned to" bulk action - one value, applied to every selected cycle. */
@Component({
  selector: 'app-bulk-reassign-dialog',
  standalone: true,
  templateUrl: './bulk-reassign-dialog.component.html',
})
export class BulkReassignDialogComponent {
  private readonly service = inject(BulkReassignDialogService);
  readonly state = this.service.state;

  readonly assignedTo = signal('');

  cancel(): void {
    this.service.cancel();
    this.assignedTo.set('');
  }

  save(): void {
    this.service.submit(this.assignedTo().trim() || null);
    this.assignedTo.set('');
  }
}
