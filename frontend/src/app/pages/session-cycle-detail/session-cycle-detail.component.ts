import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BulkActionsBarComponent } from '../../components/bulk-actions-bar/bulk-actions-bar.component';
import { CallListComponent } from '../../components/call-list/call-list.component';
import { EditCycleDialogComponent } from '../../components/edit-cycle-dialog/edit-cycle-dialog.component';
import { ExportDialogComponent } from '../../components/export-dialog/export-dialog.component';
import { HeaderComponent } from '../../components/header/header.component';
import { StatsBarComponent } from '../../components/stats-bar/stats-bar.component';
import { EditCycleDialogService } from '../../core/services/edit-cycle-dialog.service';
import {
  BULK_SELECTION_STATE,
  CALL_LIST_CONTROLS_STATE,
  CALL_REMOVAL_STATE,
  CALL_SELECTION_STATE,
} from '../../core/state/call-selection.tokens';
import { SessionCycleDetailStateService } from '../../core/state/session-cycle-detail-state.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';

/**
 * One open session-cycle: its own poll+live-merge+selection+search/sort/group/stats state
 * (SessionCycleDetailStateService, component-provided so switching cycles doesn't leak state),
 * reusing HeaderComponent/StatsBarComponent/CallListComponent/CallCardComponent/
 * BulkActionsBarComponent/ExportDialogComponent verbatim via tokens - the exact same components
 * the main dashboard uses, pointed at a different backing service. Any feature added to any of
 * those components shows up here automatically, with no cycle-specific fork to keep in sync.
 */
@Component({
  selector: 'app-session-cycle-detail',
  standalone: true,
  imports: [RouterLink, HeaderComponent, StatsBarComponent, CallListComponent, BulkActionsBarComponent, ExportDialogComponent, EditCycleDialogComponent],
  providers: [
    SessionCycleDetailStateService,
    { provide: CALL_SELECTION_STATE, useExisting: SessionCycleDetailStateService },
    { provide: BULK_SELECTION_STATE, useExisting: SessionCycleDetailStateService },
    { provide: CALL_LIST_CONTROLS_STATE, useExisting: SessionCycleDetailStateService },
    { provide: CALL_REMOVAL_STATE, useExisting: SessionCycleDetailStateService },
  ],
  templateUrl: './session-cycle-detail.component.html',
})
export class SessionCycleDetailComponent {
  readonly state = inject(SessionCycleDetailStateService);
  private readonly cyclesState = inject(SessionCyclesStateService);
  private readonly editDialog = inject(EditCycleDialogService);

  readonly cycle = computed(() => this.cyclesState.cycles().find((c) => c.id === this.state.cycleId()) ?? null);

  toggleRecording(): void {
    const cycle = this.cycle();
    if (!cycle) return;
    if (cycle.status === 'RECORDING') {
      this.cyclesState.pauseRecording(cycle.id).subscribe();
    } else {
      this.cyclesState.startRecording(cycle.id).subscribe();
    }
  }

  async edit(): Promise<void> {
    const cycle = this.cycle();
    if (!cycle) return;
    const result = await this.editDialog.open(cycle);
    if (!result) return;
    this.cyclesState.update(cycle.id, result).subscribe();
  }
}
