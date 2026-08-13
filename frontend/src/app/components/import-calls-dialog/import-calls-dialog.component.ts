import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { forkJoin } from 'rxjs';
import { ImportCallsDialogService } from '../../core/services/import-calls-dialog.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { CallRecord, SessionCycle } from '../../core/models/call.model';
import { ProfilePickerComponent } from '../profile-picker/profile-picker.component';

/**
 * Lets a previously-exported calls JSON file (the same file "Export as JSON" in the bulk actions
 * bar produces - either the full bulk-export payload, `{ calls: [...] }`, or a bare array of
 * call-shaped objects) be imported into any number of session cycles, existing or newly created
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

  readonly selectedCycleIds = signal<ReadonlySet<string>>(new Set());
  readonly importing = signal(false);
  readonly resultMessage = signal<string | null>(null);

  readonly newCycleName = signal('');
  readonly newCycleAssignedTo = signal<string | null>(null);
  readonly creatingCycle = signal(false);

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
  }

  private readFile(file: File): void {
    this.parseError.set(null);
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
      const calls = extractCalls(parsed);
      if (calls.length === 0) {
        this.parseError.set('No calls found in this file - expected an export produced by "Export as JSON".');
        return;
      }
      this.parsedCalls.set(calls);
      this.fileName.set(file.name);
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

/**
 * Accepts either the full bulk-export payload (`{ calls: [...] }`) or a bare array of call-shaped
 * objects, and maps each entry down to exactly the fields CallRecord/the backend's copy endpoint
 * need - dropping export-only extras (e.g. a per-call `comments` array) rather than sending them
 * through and relying on the backend to silently ignore unknown JSON properties. Anything missing
 * the bare minimum to identify a call (id/url) is skipped rather than failing the whole import.
 */
function extractCalls(parsed: unknown): CallRecord[] {
  const rawCalls = Array.isArray(parsed) ? parsed : (parsed as { calls?: unknown })?.calls;
  if (!Array.isArray(rawCalls)) return [];

  const calls: CallRecord[] = [];
  for (const item of rawCalls) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw['id'] !== 'string' || typeof raw['url'] !== 'string') continue;
    calls.push({
      id: raw['id'] as string,
      original_url: (raw['original_url'] as string) ?? (raw['url'] as string),
      url: raw['url'] as string,
      method: (raw['method'] as string) ?? 'GET',
      request: raw['request'] as CallRecord['request'],
      timestamp: (raw['timestamp'] as string) ?? '',
      duration_ms: raw['duration_ms'] as number,
      response: raw['response'] as CallRecord['response'],
      error: raw['error'] as string | undefined,
      supplierName: raw['supplierName'] as string | null | undefined,
      state: raw['state'] as CallRecord['state'],
    });
  }
  return calls;
}
