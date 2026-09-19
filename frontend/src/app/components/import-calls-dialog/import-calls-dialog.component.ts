import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { forkJoin } from 'rxjs';
import { ImportCallsDialogService } from '../../core/services/import-calls-dialog.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { CallRecord, SessionCycle } from '../../core/models/call.model';
import { parseImportedCalls } from '../../shared/utils/import-parser';
import { ProfilePickerComponent } from '../profile-picker/profile-picker.component';

/**
 * Lets a previously-exported calls JSON file (the same file "Export as JSON" in the bulk actions
 * bar produces - the full bulk-export payload's `events`, or a bare array of call-shaped objects)
 * be imported into any number of session cycles, existing or newly created
 * right here - same cycle-picker/create-cycle shape as CopyToCyclesDialogComponent, since import
 * is really "duplicate to cycles" with the calls coming from a file instead of a live selection.
 * Deliberately session-cycles-only (see ImportCallsDialogService) - there's no equivalent
 * "import into Live Calls," since Live Calls isn't an addressable destination the way a cycle is.
 */
@Component({
  selector: 'app-import-calls-dialog',
  standalone: true,
  imports: [ProfilePickerComponent],
  templateUrl: './import-calls-dialog.component.html',
})
export class ImportCallsDialogComponent {
  private readonly service = inject(ImportCallsDialogService);
  private readonly api = inject(SessionCyclesApiService);
  private readonly cyclesState = inject(SessionCyclesStateService);

  readonly dialogState = this.service.state;
  readonly cycles = this.cyclesState.cycles;

  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  readonly isDraggingOver = signal(false);
  readonly fileName = signal<string | null>(null);
  readonly parsedCalls = signal<CallRecord[] | null>(null);
  readonly parseError = signal<string | null>(null);
  /** Set when the file predates `source` being exported and directions had to be guessed - see
   * ImportParseResult.inferredDirectionCount. Not an error: the import still proceeds. */
  readonly parseWarning = signal<string | null>(null);

  readonly selectedCycleIds = signal<ReadonlySet<string>>(new Set());
  readonly importing = signal(false);
  readonly resultMessage = signal<string | null>(null);

  readonly newCycleName = signal('');
  readonly newCycleAssignedTo = signal<string | null>(null);
  readonly creatingCycle = signal(false);
  /** What we last prefilled newCycleName with from a whole-cycle export, so clearing the file can
   * take that suggestion back without also wiping a name the user typed over it. */
  private prefilledCycleName: string | null = null;

  constructor() {
    // Pre-checks the cycle this dialog was opened from (session-cycle-detail page) - a no-op when
    // opened from the Session Cycles list, where preselectedCycleId is null.
    effect(
      () => {
        const preselectedId = this.dialogState()?.preselectedCycleId;
        if (preselectedId) {
          this.selectedCycleIds.set(new Set([preselectedId]));
        }
      },
      { allowSignalWrites: true }
    );
  }

  browseForFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingOver.set(true);
  }

  onDragLeave(): void {
    this.isDraggingOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDraggingOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.readFile(file);
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.readFile(file);
    input.value = ''; // lets the same file be re-selected after "Choose a different file"
  }

  clearFile(): void {
    this.parsedCalls.set(null);
    this.fileName.set(null);
    this.parseError.set(null);
    this.parseWarning.set(null);
    if (this.prefilledCycleName !== null && this.newCycleName() === this.prefilledCycleName) {
      this.newCycleName.set('');
    }
    this.prefilledCycleName = null;
  }

  private readFile(file: File): void {
    this.parseError.set(null);
    this.parseWarning.set(null);
    this.resultMessage.set(null);
    if (!file.name.toLowerCase().endsWith('.json')) {
      this.parseError.set('Only .json files are supported.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch {
        this.parseError.set('This file is not valid JSON.');
        return;
      }
      const { calls, inferredDirectionCount, redactedValueCount, cycleName } = parseImportedCalls(parsed);
      if (calls.length === 0) {
        this.parseError.set('No calls found in this file - expected an export produced by "Export as JSON".');
        return;
      }
      this.parsedCalls.set([...calls]);
      this.fileName.set(file.name);
      // A whole-cycle export names the cycle it came from, which is almost always the name the
      // importer wants to recreate it under - offered, never imposed: anything already typed wins.
      if (cycleName && this.newCycleName().trim().length === 0) {
        this.newCycleName.set(cycleName);
        this.prefilledCycleName = cycleName;
      }
      if (redactedValueCount > 0) {
        // Said first, and said even when nothing else is wrong: these calls will LOOK complete once
        // imported, with ***REDACTED*** sitting where a token was. Nothing else about the file
        // reveals that, and re-exporting from here would propagate the masked values as if real.
        this.parseWarning.set(
          `${redactedValueCount} value${redactedValueCount === 1 ? ' was' : 's were'} hidden before this file was exported, ` +
            'so those calls import masked rather than complete. Import from an unredacted export if you need the real values.'
        );
      } else if (inferredDirectionCount > 0) {
        // Worth saying out loud rather than importing quietly: a wrong guess files an inbound call
        // as outbound, which loses its service and flattens anything nested under it.
        this.parseWarning.set(
          `${inferredDirectionCount} call${inferredDirectionCount === 1 ? '' : 's'} in this file predate Alfred recording inbound/outbound direction, ` +
            'so it was inferred from the service name. Re-export to import them exactly.'
        );
      }
    };
    reader.onerror = () => this.parseError.set('Could not read this file.');
    reader.readAsText(file);
  }

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

  createCycle(): void {
    const name = this.newCycleName().trim();
    if (!name) return;
    this.creatingCycle.set(true);
    this.cyclesState.create({ name, assignedTo: this.newCycleAssignedTo() }).subscribe((cycle) => {
      this.creatingCycle.set(false);
      this.newCycleName.set('');
      this.prefilledCycleName = null;
      this.newCycleAssignedTo.set(null);
      const next = new Set(this.selectedCycleIds());
      next.add(cycle.id);
      this.selectedCycleIds.set(next);
    });
  }

  import(): void {
    const calls = this.parsedCalls();
    const ids = [...this.selectedCycleIds()];
    if (!calls || calls.length === 0 || ids.length === 0) return;

    this.importing.set(true);
    forkJoin(ids.map((id) => this.api.copyCallsInto(id, calls))).subscribe((results) => {
      this.importing.set(false);
      const added = results.reduce((sum, r) => sum + r.added, 0);
      const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
      this.resultMessage.set(
        `Imported ${added} call${added === 1 ? '' : 's'} into ${ids.length} cycle${ids.length === 1 ? '' : 's'}` +
          (skipped > 0 ? ` (skipped ${skipped} already there).` : '.')
      );
    });
  }

  close(): void {
    this.service.close();
    this.selectedCycleIds.set(new Set());
    this.clearFile();
    this.resultMessage.set(null);
    this.newCycleName.set('');
    this.newCycleAssignedTo.set(null);
  }
}
