import { Component, inject, signal } from '@angular/core';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ReliveSelectionDialogService } from '../../core/services/relive-selection-dialog.service';
import { ReliveCyclesStateService } from '../../core/state/relive-cycles-state.service';
import { freezeCalls } from '../../shared/utils/relive-freeze';
import { RebuildPreviewRow, rebuildPillClass, rebuildReport } from '../../shared/utils/relive-rebuild-preview';
import { CycleVersion, ReliveCycle, ReliveCycleSummary, Step } from '../../shared/utils/relive-types';

/**
 * "Add to cycle…" / "Replace steps of cycle…" (T071, mock.html `reliveAction('add'|'replace')`):
 * pick an existing Relive cycle, then either append the selected calls as new steps, or (REPLACE)
 * preview the same added/updated/removed report the Rebuild dialog uses (T070) before applying.
 * Both write straight to the picked cycle - there's no draft here, only the cycle page has one.
 */
@Component({
  selector: 'app-relive-selection-dialog',
  standalone: true,
  templateUrl: './relive-selection-dialog.component.html',
})
export class ReliveSelectionDialogComponent {
  private readonly api = inject(ReliveApiService);
  readonly service = inject(ReliveSelectionDialogService);
  readonly cyclesState = inject(ReliveCyclesStateService);

  readonly request = this.service.state;
  readonly pickedCycle = signal<ReliveCycle | null>(null);
  readonly preview = signal<{ rows: readonly RebuildPreviewRow[]; newSteps: readonly Step[] } | null>(null);
  readonly applying = signal(false);
  readonly resultMessage = signal<string | null>(null);
  readonly undoVersion = signal<number | null>(null);

  readonly pillClass = rebuildPillClass;

  pick(summary: ReliveCycleSummary): void {
    this.api.get(summary.id).subscribe((cycle) => {
      this.pickedCycle.set(cycle);
      if (this.request()?.mode === 'REPLACE') {
        const calls = this.request()!.calls;
        const freshSteps = freezeCalls(calls, new Map(), cycle.settings, null);
        const { rows, newSteps } = rebuildReport(cycle.steps, freshSteps);
        this.preview.set({ rows, newSteps });
      }
    });
  }

  apply(): void {
    const req = this.request();
    const cycle = this.pickedCycle();
    if (!req || !cycle || this.applying()) return;
    this.applying.set(true);

    const newSteps = req.mode === 'ADD' ? [...cycle.steps, ...freezeCalls(req.calls, new Map(), cycle.settings, null)] : (this.preview()?.newSteps ?? cycle.steps);
    const reason: CycleVersion['reason'] | undefined = req.mode === 'REPLACE' ? 'REPLACE_STEPS' : undefined;
    const { id, createdAt, updatedAt, transient, lastRun, ...rest } = cycle;

    this.api.update(id, { ...rest, steps: newSteps }, updatedAt ?? '', reason).subscribe({
      next: () => {
        this.applying.set(false);
        this.resultMessage.set(req.mode === 'ADD' ? `${req.calls.length} call${req.calls.length === 1 ? '' : 's'} added to "${cycle.name}"` : `Steps replaced in "${cycle.name}" · previous version kept`);
        if (req.mode === 'REPLACE') {
          this.api.listVersions(id).subscribe((versions) => {
            const latest = versions.reduce((max, v) => (!max || v.version > max.version ? v : max), null as (typeof versions)[number] | null);
            if (latest) this.undoVersion.set(latest.version);
          });
        }
      },
      error: () => this.applying.set(false),
    });
  }

  undo(): void {
    const cycle = this.pickedCycle();
    const version = this.undoVersion();
    if (!cycle || version === null) return;
    this.api.restoreVersion(cycle.id, version).subscribe(() => {
      this.resultMessage.set('Reverted to the previous version.');
      this.undoVersion.set(null);
    });
  }

  close(): void {
    this.service.close();
    this.pickedCycle.set(null);
    this.preview.set(null);
    this.resultMessage.set(null);
    this.undoVersion.set(null);
  }
}
