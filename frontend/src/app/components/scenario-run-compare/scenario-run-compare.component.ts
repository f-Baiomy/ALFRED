import { Component, computed, input, output, signal } from '@angular/core';
import { DraftDiff, diffRuns } from '../../shared/utils/scenario-assertions';
import { ScenarioRun } from '../../shared/utils/scenario-types';

/** D1 - pick two runs of the same scenario, show diffRuns() (status/latency/JSON field deltas per draft). */
@Component({
  selector: 'app-scenario-run-compare',
  standalone: true,
  templateUrl: './scenario-run-compare.component.html',
})
export class ScenarioRunCompareComponent {
  readonly runs = input<readonly ScenarioRun[]>([]);
  readonly runSelected = output<{ before: string; after: string }>();

  readonly beforeId = signal<string | null>(null);
  readonly afterId = signal<string | null>(null);

  readonly beforeRun = computed(() => this.runs().find((r) => r.id === this.beforeId()) ?? null);
  readonly afterRun = computed(() => this.runs().find((r) => r.id === this.afterId()) ?? null);

  readonly diffs = computed<DraftDiff[]>(() => {
    const before = this.beforeRun();
    const after = this.afterRun();
    if (!before?.results || !after?.results) return [];
    return diffRuns(before.results.draftResults, after.results.draftResults);
  });

  selectBefore(id: string): void {
    this.beforeId.set(id || null);
  }

  selectAfter(id: string): void {
    this.afterId.set(id || null);
  }

  hasChanges(diff: DraftDiff): boolean {
    return diff.statusBefore !== diff.statusAfter || diff.latencyBefore !== diff.latencyAfter || diff.fieldChanges.length > 0;
  }
}
