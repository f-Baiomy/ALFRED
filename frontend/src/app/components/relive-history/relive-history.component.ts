import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { forkJoin } from 'rxjs';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { downloadText } from '../../shared/utils/download';
import { reliveRunToScenarioRun } from '../../shared/utils/relive-run-compare-adapter';
import { buildHtmlRunReport, buildJsonRunReport, buildMarkdownRunReport, rowsFor } from '../../shared/utils/relive-run-export';
import { CycleVariable, Run, Step, StepResult } from '../../shared/utils/relive-types';
import { ScenarioRun } from '../../shared/utils/scenario-types';
import { ScenarioRunCompareComponent } from '../scenario-run-compare/scenario-run-compare.component';
import { ReliveLiveCallsComponent } from '../relive-live-calls/relive-live-calls.component';
import { ActionMenuComponent } from '../action-menu/action-menu.component';

type ExportFormat = 'markdown' | 'html' | 'json';

const STATUS_PILL: Readonly<Record<Run['status'], readonly [string, string]>> = {
  RUNNING: ['rl-p-cycle', '● running'],
  COMPLETED: ['rl-p-ok', '✓ completed'],
  COMPLETED_WITH_DIFFERENCES: ['rl-p-diff', '⚠ differences'],
  FAILED: ['rl-p-fail', '✕ failed'],
  STOPPED: ['rl-p-wait', '■ stopped'],
  INTERRUPTED: ['rl-p-wait', '■ interrupted'],
};

/**
 * The History tab's runs table (T072, mock.html `historyPanel()`/`compare()`): each run keeps
 * exactly what it executed, even after the cycle is edited later - newest 50 kept. "Compare with
 * newest" reuses `ScenarioRunCompareComponent` (D1) via `reliveRunToScenarioRun`, rather than a
 * parallel step-diff viewer.
 */
@Component({
  selector: 'app-relive-history',
  standalone: true,
  imports: [ScenarioRunCompareComponent, ReliveLiveCallsComponent, ActionMenuComponent],
  templateUrl: './relive-history.component.html',
})
export class ReliveHistoryComponent implements OnInit {
  private readonly api = inject(ReliveApiService);

  readonly cycleId = input.required<string>();
  readonly steps = input<readonly Step[]>([]);
  readonly variables = input<readonly CycleVariable[]>([]);
  readonly openRun = output<string>();

  readonly runs = signal<readonly Run[]>([]);
  readonly compareRuns = signal<readonly ScenarioRun[] | null>(null);
  readonly comparing = signal(false);

  ngOnInit(): void {
    this.api.listRuns(this.cycleId()).subscribe((runs) => this.runs.set(runs));
  }

  statusPill(run: Run): readonly [string, string] {
    return STATUS_PILL[run.status] ?? STATUS_PILL.RUNNING;
  }

  /** "5/9 completed", plus "continued past N" once the run was resumed after a hold (mock's own
   *  summary line). */
  summaryOf(run: Run): string {
    const s = run.summary;
    const parts = [`${s.completed}/${s.total} completed`];
    if (s.different > 0) parts.push(`${s.different} with differences`);
    if (s.failed > 0) parts.push(`${s.failed} failed`);
    if (run.resumed.length > 0) parts.push(`continued past ${run.resumed.length}`);
    return parts.join(' · ');
  }

  durationOf(run: Run): string {
    if (!run.finishedAt) return '…';
    const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
    return `${seconds}s`;
  }

  open(run: Run): void {
    this.openRun.emit(run.id);
  }

  /** Compares `run` against the newest run in the table (mock's `compare()` - only shown for a row
   *  that isn't already the newest). */
  compareWithNewest(run: Run): void {
    const newest = this.runs()[0];
    if (!newest || newest.id === run.id || this.comparing()) return;
    this.comparing.set(true);
    forkJoin({
      before: this.api.getRun(this.cycleId(), run.id),
      after: this.api.getRun(this.cycleId(), newest.id),
    }).subscribe(({ before, after }) => {
      this.comparing.set(false);
      this.compareRuns.set([reliveRunToScenarioRun(before, before.stepResults), reliveRunToScenarioRun(after, after.stepResults)]);
    });
  }

  /** Export never truncates a step's full actual response body - see relive-run-export.ts. */
  exportRun(run: Run, format: ExportFormat): void {
    this.api.getRun(this.cycleId(), run.id).subscribe((full) => {
      const rows = rowsFor(full.definition.steps, this.latestByStepKey(full.stepResults));
      const secretNames = full.definition.variables.filter((v) => v.secret).map((v) => v.name);
      const variables: Record<string, string> = {};
      for (const v of full.seedVariables) variables[v.name] = v.value;
      for (const v of full.variableTimeline) variables[v.name] = v.value;
      const name = `relive-run-${full.startedAt.replace(/[^a-z0-9]+/gi, '-')}`;

      if (format === 'markdown') downloadText(buildMarkdownRunReport(rows, full.cycleId, secretNames, variables), `${name}.md`, 'text/markdown');
      if (format === 'html') downloadText(buildHtmlRunReport(rows, full.cycleId, secretNames, variables), `${name}.html`, 'text/html');
      if (format === 'json') downloadText(buildJsonRunReport(full.cycleId, rows), `${name}.json`, 'application/json');
    });
  }

  private latestByStepKey(results: readonly StepResult[]): Record<string, StepResult> {
    const latest: Record<string, StepResult> = {};
    for (const r of results) {
      const existing = latest[r.stepKey];
      if (!existing || r.attempt >= existing.attempt) latest[r.stepKey] = r;
    }
    return latest;
  }
}
