import { Component, inject, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { CopyToCyclesDialogService } from '../../core/services/copy-to-cycles-dialog.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { SessionCycle } from '../../core/models/call.model';
import { ProfilePickerComponent } from '../profile-picker/profile-picker.component';

/**
 * Lets a bulk selection of calls (from either the dashboard or a session-cycle detail page - same
 * BulkActionsBarComponent, same button) be duplicated into any number of other cycles. Reads the
 * cycle list from SessionCyclesStateService (already root-provided and polling) rather than
 * fetching its own copy.
 *
 * Also lets a brand-new cycle be created right here (same name/assignedTo fields and
 * SessionCyclesStateService.create() call as the "+ New Cycle" form on the Session Cycles page) -
 * without this, duplicating calls into a cycle that doesn't exist yet meant closing this dialog,
 * navigating away to create one, then coming back and reselecting the same calls. A newly created
 * cycle is auto-checked, since creating it here only ever means "and copy into this."
 */
@Component({
  selector: 'app-copy-to-cycles-dialog',
  standalone: true,
  imports: [ProfilePickerComponent],
  templateUrl: './copy-to-cycles-dialog.component.html',
})
export class CopyToCyclesDialogComponent {
  private readonly service = inject(CopyToCyclesDialogService);
  private readonly api = inject(SessionCyclesApiService);
  private readonly cyclesState = inject(SessionCyclesStateService);

  readonly calls = this.service.state;
  readonly cycles = this.cyclesState.cycles;

  readonly selectedCycleIds = signal<ReadonlySet<string>>(new Set());
  readonly copying = signal(false);
  readonly resultMessage = signal<string | null>(null);

  readonly newCycleName = signal('');
  readonly newCycleAssignedTo = signal<string | null>(null);
  readonly creatingCycle = signal(false);

  isSelected(cycle: SessionCycle): boolean {
    return this.selectedCycleIds().has(cycle.id);
  }

  toggle(cycle: SessionCycle): void {
    const next = new Set(this.selectedCycleIds());
    if (next.has(cycle.id)) {
      next.delete(cycle.id);
    } else {
      next.add(cycle.id);
    }
    this.selectedCycleIds.set(next);
  }

  close(): void {
    this.service.close();
    this.selectedCycleIds.set(new Set());
    this.resultMessage.set(null);
    this.newCycleName.set('');
    this.newCycleAssignedTo.set(null);
  }

  createCycle(): void {
    const name = this.newCycleName().trim();
    if (!name) return;
    this.creatingCycle.set(true);
    this.cyclesState.create({ name, assignedTo: this.newCycleAssignedTo() }).subscribe((cycle) => {
      this.creatingCycle.set(false);
      this.newCycleName.set('');
      this.newCycleAssignedTo.set(null);
      const next = new Set(this.selectedCycleIds());
      next.add(cycle.id);
      this.selectedCycleIds.set(next);
    });
  }

  copy(): void {
    const calls = this.calls();
    const ids = [...this.selectedCycleIds()];
    if (!calls || calls.length === 0 || ids.length === 0) return;

    this.copying.set(true);
    forkJoin(ids.map((id) => this.api.copyCallsInto(id, calls))).subscribe((results) => {
      this.copying.set(false);
      const added = results.reduce((sum, r) => sum + r.added, 0);
      const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
      this.resultMessage.set(
        `Copied ${added} call${added === 1 ? '' : 's'} into ${ids.length} cycle${ids.length === 1 ? '' : 's'}` +
          (skipped > 0 ? ` (skipped ${skipped} already there).` : '.')
      );
    });
  }
}
