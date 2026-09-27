import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { ReliveCyclesStateService } from '../../core/state/relive-cycles-state.service';
import { ReliveCycleSummary } from '../../shared/utils/relive-types';

/**
 * The Relive Cycles list page (FR-001-009; mock.html `listView()`). "New cycle" is a placeholder
 * until T026 wires the add-calls dialog in front of it - for now it creates an empty cycle and
 * opens it directly, same as opening any existing one with no steps yet.
 */
@Component({
  selector: 'app-relive-list',
  standalone: true,
  imports: [DatePipe, RouterLink, ConfirmDialogComponent],
  templateUrl: './relive-list.component.html',
})
export class ReliveListComponent {
  private readonly api = inject(ReliveApiService);
  private readonly router = inject(Router);
  private readonly confirmDialog = inject(ConfirmDialogService);
  readonly state = inject(ReliveCyclesStateService);

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
    this.api
      .create({
        name: 'New cycle',
        description: null,
        steps: [],
        variables: [],
        cycleRules: [],
        globalRules: { mode: 'NONE', selectedIds: [] },
        settings: { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] },
        noise: [],
        unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' },
      })
      .subscribe((created) => {
        this.state.load();
        this.router.navigate(['/relive', created.id]);
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
