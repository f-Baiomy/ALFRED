import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { EditCycleDialogComponent } from '../../components/edit-cycle-dialog/edit-cycle-dialog.component';
import { SessionCycle } from '../../core/models/call.model';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { EditCycleDialogService } from '../../core/services/edit-cycle-dialog.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';

@Component({
  selector: 'app-session-cycles-list',
  standalone: true,
  imports: [DatePipe, ConfirmDialogComponent, EditCycleDialogComponent],
  templateUrl: './session-cycles-list.component.html',
})
export class SessionCyclesListComponent {
  private readonly router = inject(Router);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly editDialog = inject(EditCycleDialogService);
  readonly state = inject(SessionCyclesStateService);

  readonly newName = signal('');
  readonly newAssignedTo = signal('');
  readonly creating = signal(false);

  /** Paused + zero captured calls is shown as "Empty" rather than "Paused" - purely a display label, not a stored status. */
  statusLabel(cycle: SessionCycle): 'Recording' | 'Paused' {
    return cycle.status === 'RECORDING' ? 'Recording' : 'Paused';
  }

  statusClass(cycle: SessionCycle): string {
    return cycle.status === 'RECORDING' ? 'cycle-status-recording' : 'cycle-status-paused';
  }

  createCycle(): void {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    this.state.create({ name, assignedTo: this.newAssignedTo().trim() || null }).subscribe(() => {
      this.creating.set(false);
      this.newName.set('');
      this.newAssignedTo.set('');
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
}
