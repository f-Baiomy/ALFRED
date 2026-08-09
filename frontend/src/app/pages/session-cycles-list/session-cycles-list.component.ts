import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AssignedToFilterComponent } from '../../components/assigned-to-filter/assigned-to-filter.component';
import { BulkReassignDialogComponent } from '../../components/bulk-reassign-dialog/bulk-reassign-dialog.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { EditCycleDialogComponent } from '../../components/edit-cycle-dialog/edit-cycle-dialog.component';
import { ProfilePickerComponent } from '../../components/profile-picker/profile-picker.component';
import { SelectOption, SelectPickerComponent } from '../../components/select-picker/select-picker.component';
import { SessionCycle } from '../../core/models/call.model';
import { BulkReassignDialogService } from '../../core/services/bulk-reassign-dialog.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { EditCycleDialogService } from '../../core/services/edit-cycle-dialog.service';
import { CycleSortMode, SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { ProfilesStateService } from '../../core/state/profiles-state.service';

const SORT_OPTIONS: readonly SelectOption[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'status', label: 'Recording first' },
];

@Component({
  selector: 'app-session-cycles-list',
  standalone: true,
  imports: [
    DatePipe,
    ConfirmDialogComponent,
    EditCycleDialogComponent,
    BulkReassignDialogComponent,
    AssignedToFilterComponent,
    ProfilePickerComponent,
    SelectPickerComponent,
  ],
  templateUrl: './session-cycles-list.component.html',
})
export class SessionCyclesListComponent {
  private readonly router = inject(Router);
  readonly sortOptions = SORT_OPTIONS;
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly editDialog = inject(EditCycleDialogService);
  private readonly bulkReassignDialog = inject(BulkReassignDialogService);
  readonly state = inject(SessionCyclesStateService);
  readonly profilesState = inject(ProfilesStateService);

  readonly newName = signal('');
  readonly newAssignedTo = signal<string | null>(null);
  readonly creating = signal(false);
  readonly bulkActionMessage = signal<string | null>(null);

  /** Paused + zero captured calls is shown as "Empty" rather than "Paused" - purely a display label, not a stored status. */
  statusLabel(cycle: SessionCycle): 'Recording' | 'Paused' {
    return cycle.status === 'RECORDING' ? 'Recording' : 'Paused';
  }

  statusClass(cycle: SessionCycle): string {
    return cycle.status === 'RECORDING' ? 'cycle-status-recording' : 'cycle-status-paused';
  }

  /** Resolves assignedTo (a profile id) to that profile's name - falls back to the raw id if the profile was since deleted. */
  assignedToLabel(cycle: SessionCycle): string {
    return this.profilesState.labelFor(cycle.assignedTo) ?? '—';
  }

  onSearchInput(value: string): void {
    this.state.setSearchQuery(value);
  }

  onSortChange(value: string): void {
    this.state.setSortMode(value as CycleSortMode);
  }

  loadMore(): void {
    this.state.loadMore();
  }

  createCycle(): void {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    this.state.create({ name, assignedTo: this.newAssignedTo() }).subscribe(() => {
      this.creating.set(false);
      this.newName.set('');
      this.newAssignedTo.set(null);
    });
  }

  toggleRecording(cycle: SessionCycle): void {
    if (cycle.status === 'RECORDING') {
      this.state.pauseRecording(cycle.id).subscribe();
    } else {
      this.state.startRecording(cycle.id).subscribe();
    }
  }

  async edit(cycle: SessionCycle): Promise<void> {
    const result = await this.editDialog.open(cycle);
    if (!result) return;
    this.state.update(cycle.id, result).subscribe();
  }

  async deleteCycle(cycle: SessionCycle): Promise<void> {
    if (cycle.status === 'RECORDING') return;
    const confirmed = await this.confirmDialog.confirm(`Delete "${cycle.name}"? This also deletes its captured calls.`);
    if (!confirmed) return;
    this.state.delete(cycle.id).subscribe();
  }

  open(cycle: SessionCycle): void {
    this.router.navigate(['/cycles', cycle.id]);
  }

  openInNewTab(cycle: SessionCycle, event: Event): void {
    event.stopPropagation();
    window.open(`/cycles/${cycle.id}`, '_blank');
  }

  toggleSelected(cycle: SessionCycle, event: Event): void {
    event.stopPropagation();
    this.state.toggleSelected(cycle);
  }

  selectAll(): void {
    this.state.selectAll();
  }

  clearSelection(): void {
    this.state.clearSelection();
    this.bulkActionMessage.set(null);
  }

  bulkRecord(): void {
    const ids = this.state.selectedCycles().map((c) => c.id);
    this.state.bulkStartRecording(ids).subscribe(() => {
      this.bulkActionMessage.set(`Started recording on ${ids.length} cycle${ids.length === 1 ? '' : 's'}.`);
    });
  }

  bulkPause(): void {
    const ids = this.state.selectedCycles().map((c) => c.id);
    this.state.bulkPauseRecording(ids).subscribe(() => {
      this.bulkActionMessage.set(`Paused ${ids.length} cycle${ids.length === 1 ? '' : 's'}.`);
    });
  }

  async bulkReassign(): Promise<void> {
    const ids = this.state.selectedCycles().map((c) => c.id);
    const assignedTo = await this.bulkReassignDialog.open(ids.length);
    if (assignedTo === undefined) return;
    this.state.bulkReassign(ids, assignedTo).subscribe(() => {
      this.bulkActionMessage.set(`Updated "Assigned to" on ${ids.length} cycle${ids.length === 1 ? '' : 's'}.`);
    });
  }

  async bulkDelete(): Promise<void> {
    const ids = this.state.selectedCycles().map((c) => c.id);
    const confirmed = await this.confirmDialog.confirm(
      `Delete ${ids.length} cycle${ids.length === 1 ? '' : 's'}? This also deletes their captured calls. Any still recording will be skipped.`
    );
    if (!confirmed) return;
    this.state.bulkDelete(ids).subscribe(({ deleted, skippedRecording }) => {
      this.state.clearSelection();
      this.bulkActionMessage.set(
        `Deleted ${deleted} cycle${deleted === 1 ? '' : 's'}` +
          (skippedRecording > 0 ? ` (skipped ${skippedRecording} still recording).` : '.')
      );
    });
  }
}
