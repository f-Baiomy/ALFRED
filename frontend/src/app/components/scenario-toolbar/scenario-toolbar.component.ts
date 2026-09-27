import { Component, effect, inject, signal } from '@angular/core';
import { forkJoin, of, switchMap } from 'rxjs';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';
import { ScenarioApiService } from '../../core/services/scenario-api.service';
import { ScenarioStateService } from '../../core/services/scenario-state.service';
import { ScenarioLibraryComponent } from '../scenario-library/scenario-library.component';
import { ScenarioRunReportComponent } from '../scenario-run-report/scenario-run-report.component';
import { ScenarioRunCompareComponent } from '../scenario-run-compare/scenario-run-compare.component';
import { evaluate } from '../../shared/utils/scenario-assertions';
import { AssertionResult, DraftResult, Scenario, ScenarioRun, ScenarioRunResults } from '../../shared/utils/scenario-types';

/** Save, open, and inspect scenarios from the resend dialog. */
@Component({
  selector: 'app-scenario-toolbar',
  standalone: true,
  imports: [ScenarioLibraryComponent, ScenarioRunReportComponent, ScenarioRunCompareComponent],
  templateUrl: './scenario-toolbar.component.html',
})
export class ScenarioToolbarComponent {
  readonly dialog = inject(BulkResendDialogService);
  private readonly api = inject(ScenarioApiService);
  readonly scenarioState = inject(ScenarioStateService);

  readonly loadedScenario = signal<Scenario | null>(null);
  readonly libraryOpen = signal(false);
  readonly saveAsOpen = signal(false);
  readonly saveAsName = signal('');
  readonly saveAsDescription = signal('');
  readonly saving = signal(false);
  readonly error = signal('');

  readonly runHistoryOpen = signal(false);
  readonly runs = signal<readonly ScenarioRun[]>([]);
  readonly runsLoading = signal(false);
  readonly selectedRun = signal<ScenarioRun | null>(null);

  constructor() {
    this.dialog.onRunFinished.subscribe((results) => this.onRunFinished(results));
    effect(() => {
      this.dialog.editorRevision();
      this.loadedScenario.set(null);
      this.runs.set([]);
      this.selectedRun.set(null);
      this.runHistoryOpen.set(false);
      this.libraryOpen.set(false);
      this.saveAsOpen.set(false);
    }, { allowSignalWrites: true });
  }

  canSave(): boolean {
    return this.loadedScenario() !== null;
  }

  openSaveAs(): void {
    this.error.set('');
    this.saveAsName.set(this.loadedScenario()?.name ?? '');
    this.saveAsDescription.set(this.loadedScenario()?.description ?? '');
    this.saveAsOpen.set(true);
  }

  cancelSaveAs(): void {
    this.saveAsOpen.set(false);
  }

  confirmSaveAs(): void {
    const name = this.saveAsName().trim();
    if (!name) return;
    this.saving.set(true);
    this.api.create({ name, description: this.saveAsDescription().trim(), definition: this.dialog.toDefinition() }).subscribe({
      next: (scenario) => {
        this.saving.set(false);
        this.saveAsOpen.set(false);
        this.loadedScenario.set(scenario);
        this.scenarioState.refresh();
      },
      error: () => {
        this.saving.set(false);
        this.error.set('Could not save the scenario.');
      },
    });
  }

  save(): void {
    const loaded = this.loadedScenario();
    if (!loaded) return;
    this.saving.set(true);
    this.api.update(loaded.id, { name: loaded.name, description: loaded.description, definition: this.dialog.toDefinition() }).subscribe({
      next: (scenario) => {
        this.saving.set(false);
        this.loadedScenario.set(scenario);
        this.scenarioState.refresh();
      },
      error: () => {
        this.saving.set(false);
        this.error.set('Could not save the scenario.');
      },
    });
  }

  openLibrary(): void {
    this.error.set('');
    this.libraryOpen.set(true);
  }

  onOpened(scenario: Scenario): void {
    this.libraryOpen.set(false);
    if (scenario.definition) this.dialog.loadDefinition(scenario.definition);
    this.loadedScenario.set(scenario);
  }

  closeLibrary(): void {
    this.libraryOpen.set(false);
  }

  openRunHistory(): void {
    const loaded = this.loadedScenario();
    if (!loaded) return;
    this.error.set('');
    this.runHistoryOpen.set(true);
    this.selectedRun.set(null);
    this.runsLoading.set(true);
    // The list omits `results`; the compare view needs both sides' draftResults, so every run
    // (capped at 50 - the backend's own retention limit, see contracts.md section 3) is fetched
    // in full up front rather than lazily per pair picked.
    this.api
      .listRuns(loaded.id)
      .pipe(switchMap((runs) => (runs.length ? forkJoin(runs.map((r) => this.api.getRun(loaded.id, r.id))) : of([]))))
      .subscribe({
        next: (runs) => {
          this.runsLoading.set(false);
          this.runs.set(runs);
        },
        error: () => {
          this.runsLoading.set(false);
          this.error.set('Could not load run history.');
        },
      });
  }

  closeRunHistory(): void {
    this.runHistoryOpen.set(false);
  }

  viewRun(run: ScenarioRun): void {
    this.selectedRun.set(run);
  }

  /**
   * Saving a run (D1): evaluate every draft's assertions against its result, then POST the run
   * with the summary the library's "last run" line reads. Silent no-op when no scenario is loaded
   * - a bulk resend done without ever opening a scenario has nothing to attach a run to.
   */
  private onRunFinished(results: readonly DraftResult[]): void {
    const loaded = this.loadedScenario();
    if (!loaded) return;
    const draftByKey = new Map(this.dialog.drafts().map((d) => [d.key, d]));
    const assertionResults: Record<string, readonly AssertionResult[]> = {};
    let passed = 0;
    let failed = 0;
    let errored = 0;
    for (const result of results) {
      const draft = draftByKey.get(result.key);
      const assertions = draft?.assertions ?? [];
      const evaluated = evaluate(assertions, result);
      assertionResults[result.key] = evaluated;
      if (result.error && !result.response) errored++;
      else if (evaluated.every((a) => a.passed)) passed++;
      else failed++;
    }
    const runResults: ScenarioRunResults = { draftResults: results, assertionResults };
    const now = new Date().toISOString();
    this.api.createRun(loaded.id, {
      startedAt: this.dialog.lastRunStartedAt ?? now,
      finishedAt: now,
      summary: { total: results.length, passed, failed, errored },
      results: runResults,
    }).subscribe({ next: () => this.scenarioState.refresh() });
  }
}
