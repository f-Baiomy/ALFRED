import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { CallFocusService } from '../../core/services/call-focus.service';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, switchMap } from 'rxjs';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CallRefDetailService } from '../../core/services/call-ref-detail.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { CALL_ORIGIN, CallOrigin } from '../../core/state/call-origin.token';

function addRequester(cycleId: string): string {
  return `cycle-add:${cycleId}`;
}
import { ActionMenuComponent } from '../../components/action-menu/action-menu.component';
import { BulkActionsBarComponent } from '../../components/bulk-actions-bar/bulk-actions-bar.component';
import { CallListComponent } from '../../components/call-list/call-list.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { CopyToCyclesDialogComponent } from '../../components/copy-to-cycles-dialog/copy-to-cycles-dialog.component';
import { EditCycleDialogComponent } from '../../components/edit-cycle-dialog/edit-cycle-dialog.component';
import { ExportDialogComponent } from '../../components/export-dialog/export-dialog.component';
import { HeaderComponent } from '../../components/header/header.component';
import { ImportCallsDialogComponent } from '../../components/import-calls-dialog/import-calls-dialog.component';
import { StatsBarComponent } from '../../components/stats-bar/stats-bar.component';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { CycleExportService } from '../../core/services/cycle-export.service';
import { EditCycleDialogService } from '../../core/services/edit-cycle-dialog.service';
import { ImportCallsDialogService } from '../../core/services/import-calls-dialog.service';
import {
  BULK_SELECTION_STATE,
  CALL_LIST_CONTROLS_STATE,
  CALL_REMOVAL_STATE,
  CALL_REORDER_STATE,
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
  imports: [RouterLink, ActionMenuComponent, HeaderComponent, StatsBarComponent, CallListComponent, BulkActionsBarComponent, ExportDialogComponent, CopyToCyclesDialogComponent, ImportCallsDialogComponent, EditCycleDialogComponent, ConfirmDialogComponent],
  providers: [
    SessionCycleDetailStateService,
    { provide: CALL_SELECTION_STATE, useExisting: SessionCycleDetailStateService },
    { provide: BULK_SELECTION_STATE, useExisting: SessionCycleDetailStateService },
    { provide: CALL_LIST_CONTROLS_STATE, useExisting: SessionCycleDetailStateService },
    { provide: CALL_REMOVAL_STATE, useExisting: SessionCycleDetailStateService },
    { provide: CALL_REORDER_STATE, useExisting: SessionCycleDetailStateService },
    {
      provide: CALL_ORIGIN,
      useFactory: (): CallOrigin => {
        const state = inject(SessionCycleDetailStateService);
        const cycles = inject(SessionCyclesStateService);
        const name = computed(() => cycles.cycles().find((c) => c.id === state.cycleId())?.name ?? 'session cycle');
        return { cycleId: computed(() => state.cycleId() || null), label: computed(() => `Cycle "${name()}"`) };
      },
    },
  ],
  templateUrl: './session-cycle-detail.component.html',
})
export class SessionCycleDetailComponent {
  readonly state = inject(SessionCycleDetailStateService);
  private readonly cyclesState = inject(SessionCyclesStateService);
  private readonly editDialog = inject(EditCycleDialogService);
  private readonly importDialog = inject(ImportCallsDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  readonly cycleExport = inject(CycleExportService);

  readonly cycle = computed(() => this.cyclesState.cycles().find((c) => c.id === this.state.cycleId()) ?? null);
  readonly clearingCalls = signal(false);
  private readonly picker = inject(CallPickerService);
  private readonly refDetail = inject(CallRefDetailService);
  private readonly cyclesApi = inject(SessionCyclesApiService);
  readonly addMessage = signal<string | null>(null);

  constructor() {
    // `/cycles/<id>?requestId=<callId>` shows that one captured call - see CallFocusService.
    const focus = inject(CallFocusService);
    const requestId = toSignal(inject(ActivatedRoute).queryParamMap, { initialValue: null });
    effect(() => {
      const id = this.state.cycleId();
      const wanted = requestId()?.get('requestId') ?? null;
      if (!id) return;
      untracked(() => focus.applyTo(this.state, id, wanted));
    });

    // Return from "Add calls from anywhere…" lands here - rebuilt, or kept when the user never left.
    effect(() => {
      const id = this.state.cycleId();
      if (!id || !this.picker.hasResult(addRequester(id))) return;
      untracked(() => {
        const picked = this.picker.takeResult(addRequester(id))?.picked ?? [];
        if (picked.length === 0) return;
        this.addMessage.set(`Adding ${picked.length} call${picked.length === 1 ? '' : 's'}…`);
        forkJoin(picked.map((p) => this.refDetail.hydrate(p.ref, p.call)))
          .pipe(switchMap((calls) => this.cyclesApi.copyCallsInto(id, calls)))
          .subscribe({
            next: (result) => {
              this.addMessage.set(`${result.added} copied into this cycle · ${result.skipped} skipped (already here)`);
              this.state.refresh();
            },
            error: () => this.addMessage.set('Could not add the picked calls. Try again.'),
          });
      });
    });
  }

  /** Lets the user collect calls from the live log and other cycles, then copies them all in on Return. */
  addFromAnywhere(): void {
    const cycle = this.cycle();
    if (!cycle) return;
    this.addMessage.set(null);
    this.picker.start({
      requester: addRequester(cycle.id),
      title: `Calls to add to cycle "${cycle.name}"`,
      mode: 'multi',
      returnUrl: `/cycles/${cycle.id}`,
      returnLabel: `cycle "${cycle.name}"`,
      refuseOrigin: { cycleId: cycle.id, reason: 'Already in this cycle' },
    });
  }

  /**
   * Exports the whole cycle, not the list's current selection/filters - see CycleExportService.
   * 'markdown' only picks the dialog's initial toggle; Markdown vs. HTML is chosen inside it.
   */
  exportCycle(format: 'markdown' | 'json'): void {
    const cycle = this.cycle();
    if (!cycle) return;
    this.cycleExport.exportCycle(cycle, format);
  }

  openImportDialog(): void {
    this.importDialog.open(this.state.cycleId());
  }

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

  async clearAllCalls(): Promise<void> {
    const confirmed = await this.confirmDialog.confirm(
      'Delete every captured call in this cycle? This cannot be undone.',
      'Clear calls'
    );
    if (!confirmed) return;
    this.clearingCalls.set(true);
    this.state.clearAllCalls().subscribe(() => this.clearingCalls.set(false));
  }
}
