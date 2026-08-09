import { Component, inject, signal } from '@angular/core';
import { ProfilePickerComponent } from '../profile-picker/profile-picker.component';
import { BulkReassignDialogService } from '../../core/services/bulk-reassign-dialog.service';

/** Styled single-field form for the "Change assigned to" bulk action - one profile, applied to every selected cycle. */
@Component({
  selector: 'app-bulk-reassign-dialog',
  standalone: true,
  imports: [ProfilePickerComponent],
  templateUrl: './bulk-reassign-dialog.component.html',
})
export class BulkReassignDialogComponent {
  private readonly service = inject(BulkReassignDialogService);
  readonly state = this.service.state;

  readonly assignedTo = signal<string | null>(null);

  cancel(): void {
    this.service.cancel();
    this.assignedTo.set(null);
  }

  save(): void {
    this.service.submit(this.assignedTo());
    this.assignedTo.set(null);
  }
}
