import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { ReliveAddCallsDialogComponent, RELIVE_ADD_CALLS_REQUESTER, ReliveAddCallsResume } from '../../components/relive-add-calls/relive-add-calls-dialog.component';
import { CallPickerService } from '../../core/services/call-picker.service';
import { ReliveCallSourceService } from '../../core/services/relive-call-source.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveApiService, ReliveWriteRequest } from '../../core/services/relive-api.service';
import { outboundAwaitingFingerprint } from '../../core/services/relive-fingerprint';
import { ReliveFingerprintFlow } from '../../core/services/relive-fingerprint-flow.service';
import { ReliveCyclesStateService } from '../../core/state/relive-cycles-state.service';
import { ReliveCycleSummary, ReliveSettings, Step } from '../../shared/utils/relive-types';

/**
 * The Relive Cycles list page (FR-001-009; mock.html `listView()`).
 */
@Component({
  selector: 'app-relive-list',
  standalone: true,
  imports: [DatePipe, RouterLink, ConfirmDialogComponent, ReliveAddCallsDialogComponent],
  templateUrl: './relive-list.component.html',
})
export class ReliveListComponent {
  private readonly api = inject(ReliveApiService);
  private readonly fingerprints = inject(ReliveFingerprintFlow);
  private readonly router = inject(Router);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly picker = inject(CallPickerService);
  private readonly source = inject(ReliveCallSourceService);
  readonly state = inject(ReliveCyclesStateService);
  readonly newCycleOpen = signal(false);
  readonly creating = signal(false);
  readonly error = signal<string | null>(null);
  readonly settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

  constructor() {
    queueMicrotask(() => void this.handlePickerReturn());
  }

  private async handlePickerReturn(): Promise<void> {
    const result = this.picker.peekResult(RELIVE_ADD_CALLS_REQUESTER);
    if (!result || (result.resume as ReliveAddCallsResume | null)?.cycleId !== null) return;
    if (!result.picked.length) {
      this.picker.takeResult(RELIVE_ADD_CALLS_REQUESTER);
      return;
    }
    try {
      const steps = await this.source.freezePicked(result.picked, this.settings);
      this.picker.takeResult(RELIVE_ADD_CALLS_REQUESTER);
      this.createFromSteps(steps);
    } catch {
      this.error.set('Could not load the picked calls. Reload this page to retry.');
    }
  }

  lastRunPillClass(cycle: ReliveCycleSummary): string {
    const status = cycle.lastRun ? this.lastRunStatus(cycle) : null;
    if (!status) return 'p-wait';
    if (status === 'FAILED') return 'p-fail';
    if (status.includes('DIFFERENCES')) return 'p-diff';
    return 'p-ok';
  }

  lastRunLabel(cycle: ReliveCycleSummary): string {
    if (!cycle.lastRun) return 'never run';
    const status = this.lastRunStatus(cycle);
    if (status === 'FAILED') return '✕ last run failed';
    if (status?.includes('DIFFERENCES')) return '⚠ differences';
    return '✓ passed';
  }

  private lastRunStatus(cycle: ReliveCycleSummary): string | null {
    // RunSummary carries counts, not a status string directly - failed/different > 0 stands in
    // for the run's overall outcome on this summary-only list row.
    const summary = cycle.lastRun;
    if (!summary) return null;
    if (summary.failed > 0) return 'FAILED';
    if (summary.different > 0) return 'COMPLETED_WITH_DIFFERENCES';
    return 'COMPLETED';
  }

  newCycle(): void {
    this.error.set(null);
    this.newCycleOpen.set(true);
  }

  createFromSteps(steps: readonly Step[]): void {
    if (!steps.length || this.creating()) return;
    this.creating.set(true);
    this.newCycleOpen.set(false);
    const request: ReliveWriteRequest = {
      name: 'New cycle',
      description: null,
      steps,
      variables: [],
      cycleRules: [],
      globalRules: { mode: 'NONE', selectedIds: [] },
      settings: this.settings,
      noise: [],
      unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' },
    };
    // No supplier steps: the create stays the fast POST the list already waits on.
    if (outboundAwaitingFingerprint(steps) === 0) {
      this.api.create(request).subscribe({
        next: (created) => {
          this.creating.set(false);
          this.state.load();
          void this.router.navigate(['/relive', created.id]);
        },
        error: () => {
          this.creating.set(false);
          this.error.set('Could not create the cycle. Try again.');
        },
      });
      return;
    }
    void this.fingerprints.createAndOpen(request).then(() => {
      this.creating.set(false);
      this.state.load();
    }).catch(() => {
      this.creating.set(false);
      this.error.set('Could not create the cycle. Try again.');
    });
  }

  duplicate(cycle: ReliveCycleSummary, event: Event): void {
    event.stopPropagation();
    this.api.duplicate(cycle.id).subscribe(() => this.state.load());
  }

  async delete(cycle: ReliveCycleSummary, event: Event): Promise<void> {
    event.stopPropagation();
    const confirmed = await this.confirmDialog.confirm(`Delete cycle "${cycle.name}"? This cannot be undone.`);
    if (!confirmed) return;
    this.api.delete(cycle.id).subscribe(() => this.state.load());
  }
}
