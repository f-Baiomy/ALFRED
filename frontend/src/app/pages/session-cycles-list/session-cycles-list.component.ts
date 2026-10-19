import { CycleVerdictsDialogComponent } from '../../components/board/cycle-verdicts-dialog/cycle-verdicts-dialog.component';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { filter } from 'rxjs';
import { Router } from '@angular/router';
import { ActionMenuComponent } from '../../components/action-menu/action-menu.component';
import { AssignedToFilterComponent } from '../../components/assigned-to-filter/assigned-to-filter.component';
import { BulkReassignDialogComponent } from '../../components/bulk-reassign-dialog/bulk-reassign-dialog.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { EditCycleDialogComponent } from '../../components/edit-cycle-dialog/edit-cycle-dialog.component';
import { ExportDialogComponent } from '../../components/export-dialog/export-dialog.component';
import { ImportCallsDialogComponent } from '../../components/import-calls-dialog/import-calls-dialog.component';
import { ProfilePickerComponent } from '../../components/profile-picker/profile-picker.component';
import { SelectOption, SelectPickerComponent } from '../../components/select-picker/select-picker.component';
import { SessionCycle } from '../../core/models/call.model';
import { BulkReassignDialogService } from '../../core/services/bulk-reassign-dialog.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { CycleDeleteService } from '../../core/services/cycle-delete.service';
import { CycleExportService } from '../../core/services/cycle-export.service';
import { EditCycleDialogService } from '../../core/services/edit-cycle-dialog.service';
import { ImportCallsDialogService } from '../../core/services/import-calls-dialog.service';
import { CycleSortMode, SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { ProfilesStateService } from '../../core/state/profiles-state.service';
import { BoardSummary } from '../../core/models/board.models';
import { BoardApiService } from '../../core/services/board-api.service';
import { BoardSocketService } from '../../core/services/board-socket.service';
import { groupCyclesByBoard } from '../../shared/utils/cycle-groups';
import { LinksStateService } from '../../core/links/links-state.service';
import { Stream } from '../../core/links/links.models';
import { OriginPillComponent } from '../../components/links/origin-pill/origin-pill.component';
import { OutPillComponent } from '../../components/links/out-pill/out-pill.component';
import { StreamDialogService } from '../../components/links/stream-dialog/stream-dialog.service';
import { copiedFrom } from '../../core/links/keep-copy.service';

const GROUP_KEY = 'alfred.cycles.groupBy';

function readGroupBy(): 'board' | 'none' {
  try {
    return localStorage.getItem(GROUP_KEY) === 'none' ? 'none' : 'board';
  } catch {
    return 'board';
  }
}

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
    ActionMenuComponent,
    ConfirmDialogComponent,
    EditCycleDialogComponent,
    ExportDialogComponent,
    BulkReassignDialogComponent,
    ImportCallsDialogComponent,
    AssignedToFilterComponent,
    ProfilePickerComponent,
    SelectPickerComponent,
    NgTemplateOutlet,
    CycleVerdictsDialogComponent,
    OriginPillComponent,
    OutPillComponent,
  ],
  templateUrl: './session-cycles-list.component.html',
})
export class SessionCyclesListComponent {
  private readonly router = inject(Router);
  readonly sortOptions = SORT_OPTIONS;
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly cycleDelete = inject(CycleDeleteService);
  private readonly editDialog = inject(EditCycleDialogService);
  private readonly bulkReassignDialog = inject(BulkReassignDialogService);
  private readonly importDialog = inject(ImportCallsDialogService);
  readonly cycleExport = inject(CycleExportService);
  readonly state = inject(SessionCyclesStateService);
  readonly profilesState = inject(ProfilesStateService);

  // --------------------------------------------------------------------------- streamed to and from here (specs/035)
  readonly links = inject(LinksStateService);
  private readonly streamDialog = inject(StreamDialogService);
  /** Boards and cycles other Alfreds stream to this one (D24) - read live, nothing of them kept here. */
  readonly sharedBoards = computed(() => this.links.given().filter((s) => s.kind === 'BOARD'));
  readonly sharedCycles = computed(() => this.links.given().filter((s) => s.kind === 'CYCLE'));
  readonly copiedFrom = copiedFrom;

  refOf(s: Stream): string {
    const slug = this.links.linkById().get(s.linkId)?.slug;
    return slug ? `${s.target}@${slug}` : s.target;
  }

  /** The boards of this Alfred a streamed cycle is on. */
  boardsOfRef(ref: string): string[] {
    return this.boards().filter((b) => b.cycleIds.includes(ref)).map((b) => b.board.name);
  }

  linkOnline(s: Stream): boolean {
    return !!this.links.linkById().get(s.linkId)?.online;
  }

  openShared(s: Stream): void {
    if (s.endedAt) return;
    if (s.kind === 'CYCLE') void this.router.navigate(['/cycles', this.refOf(s)]);
    else void this.router.navigate(['/board'], { queryParams: { board: this.refOf(s), project: s.project } });
  }

  stream(cycle: SessionCycle): void {
    this.streamDialog.open({ kind: 'CYCLE', target: cycle.id, name: cycle.name, project: cycle.assignedTo ?? null });
  }

  readonly newName = signal('');
  readonly newAssignedTo = signal<string | null>(null);
  readonly creating = signal(false);
  readonly bulkActionMessage = signal<string | null>(null);

  // Grouped by board (specs/027 FR-007): a cycle on two boards shows under both; this browser remembers the choice.
  private readonly boardApi = inject(BoardApiService);
  readonly boards = signal<BoardSummary[]>([]);
  /** The shared cycle whose verdicts are open (specs/027 US3). */
  readonly verdictsOf = signal<SessionCycle | null>(null);

  boardsOn(cycleId: string): number {
    return this.boards().filter((b) => b.cycleIds.includes(cycleId)).length;
  }
  readonly groupBy = signal<'board' | 'none'>(readGroupBy());
  /** New Cycle asks which board it records for (specs/028 FR-096); none is allowed. */
  readonly newBoard = signal('');
  readonly openBoards = computed(() => this.boards().filter((b) => b.board.state === 'OPEN'));
  readonly groups = computed(() => groupCyclesByBoard(this.state.sortedCycles(), this.boards()));

  constructor() {
    this.links.start();
    this.loadBoards();
    const sub = inject(BoardSocketService).events$
      .pipe(filter((e) => e.type === 'board-changed' && (e.what === 'boards' || e.what === 'deleted')))
      .subscribe(() => this.loadBoards());
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  private loadBoards(): void {
    this.boardApi.boards(null).subscribe({ next: (b) => this.boards.set(b), error: () => undefined });
  }

  setGroupBy(g: 'board' | 'none'): void {
    this.groupBy.set(g);
    try {
      localStorage.setItem(GROUP_KEY, g);
    } catch {
      // private window: the choice lasts for this page only
    }
  }

  openBoard(project: string, boardId: string): void {
    void this.router.navigate(['/board'], { queryParams: { project, board: boardId } });
  }

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

  openImportDialog(): void {
    this.importDialog.open();
  }

  createCycle(): void {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    const board = this.newBoard();
    this.state.create({ name, assignedTo: this.newAssignedTo() }).subscribe((c) => {
      this.creating.set(false);
      this.newName.set('');
      this.newAssignedTo.set(null);
      if (board) this.boardApi.relateCycle(board, c.id, true).subscribe({ next: () => this.loadBoards(), error: () => undefined });
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
    const confirmed = await this.cycleDelete.confirmAndClean([cycle.id], `Delete "${cycle.name}"? This also deletes its captured calls.`);
    if (!confirmed) return;
    this.state.delete(cycle.id).subscribe();
  }

  open(cycle: SessionCycle): void {
    this.router.navigate(['/cycles', cycle.id]);
  }

  /** Exports the entire cycle (see CycleExportService), not a selection out of it - stops the click from opening the row. */
  exportCycle(cycle: SessionCycle, format: 'markdown' | 'json', event: Event): void {
    event.stopPropagation();
    this.cycleExport.exportCycle(cycle, format);
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
    this.state.bulkStartRecording(ids).subscribe({
      next: (started) => {
        const skipped = ids.length - started.length;
        this.bulkActionMessage.set(`Started recording on ${started.length} cycle${started.length === 1 ? '' : 's'}.`
          + (skipped ? ` ${skipped} skipped: another cycle already records its project.` : ''));
      },
      error: () => this.bulkActionMessage.set("Couldn't start recording. Try again."),
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
    const ids = this.state.selectedCycles().filter((c) => c.status !== 'RECORDING').map((c) => c.id);
    const skipped = this.state.selectedCycles().length - ids.length;
    const confirmed = await this.cycleDelete.confirmAndClean(ids,
      `Delete ${ids.length} cycle${ids.length === 1 ? '' : 's'}? This also deletes their captured calls.${skipped ? ` ${skipped} still recording will be skipped.` : ''}`
    );
    if (!confirmed) return;
    this.state.bulkDelete(ids).subscribe(({ deleted, skippedRecording, kept }) => {
      this.state.clearSelection();
      this.bulkActionMessage.set(
        `Deleted ${deleted} cycle${deleted === 1 ? '' : 's'}` +
          (skippedRecording > 0 ? ` (skipped ${skippedRecording} still recording).` : '.') +
          (kept ? ` ${kept} kept as "kept from …": boards mention some of their calls.` : '')
      );
    });
  }
}
