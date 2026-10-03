import { DatePipe } from '@angular/common';
import { Component, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { ReliveApiService } from '../../core/services/relive-api.service';
import { downloadText } from '../../shared/utils/download';
import {
  CompareSide,
  FullRun,
  MatrixCell,
  RECORDING_SIDE,
  buildMatrix,
  latestByStepKey,
  recordingSide,
  runSide,
} from '../../shared/utils/relive-run-compare';
import { buildHtmlRunReport, buildJsonRunReport, buildMarkdownRunReport } from '../../shared/utils/relive-run-export';
import { buildRunReport, fileSafe } from '../../shared/utils/relive-run-report';
import { CycleRule, CycleVariable, NoiseRule, Run, Step } from '../../shared/utils/relive-types';
import { ReliveLiveCallsComponent } from '../relive-live-calls/relive-live-calls.component';
import { ReliveRunCompareComponent } from '../relive-run-compare/relive-run-compare.component';
import { NoiseChange } from '../relive-run-timeline/relive-run-timeline.component';
import { ActionMenuComponent } from '../action-menu/action-menu.component';

type ExportFormat = 'markdown' | 'html' | 'json';

/** Runs shown in the matrix at first, and how many more "Show older runs" adds. */
export const MATRIX_PAGE = 6;

const STATUS_PILL: Readonly<Record<Run['status'], readonly [string, string]>> = {
  RUNNING: ['rl-p-cycle', '●'],
  COMPLETED: ['rl-p-ok', '✓'],
  COMPLETED_WITH_DIFFERENCES: ['rl-p-diff', '≠'],
  FAILED: ['rl-p-fail', '✕'],
  STOPPED: ['rl-p-wait', '■'],
  INTERRUPTED: ['rl-p-wait', '■'],
};

const STATUS_TEXT: Readonly<Record<Run['status'], string>> = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  COMPLETED_WITH_DIFFERENCES: 'completed with differences',
  FAILED: 'failed',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
};

const OUTCOME_TEXT: Readonly<Record<MatrixCell['outcome'], string>> = { ok: '✓', diff: '≠', fail: '✗', skip: '–' };
const OUTCOME_WORD: Readonly<Record<MatrixCell['outcome'], string>> = { ok: 'passed', diff: 'differences', fail: 'failed', skip: 'not run' };

/**
 * The History tab (T072, redesigned by T134 - run-compare-mock.html option C): a matrix of every
 * step across the last runs (newest on the left), each cell the step's outcome or its time against
 * that step's usual time, with "what stands out" per step - and right under it the two runs picked
 * as A and B, compared step by step by `ReliveRunCompareComponent`. A cell picks that run pair and
 * opens that step in the comparison. Each run keeps exactly what it executed, even after the cycle
 * is edited later - newest 50 kept.
 *
 * Runs are multi-selectable (a checkbox on each column head) for the two bulk actions: stopping
 * every RUNNING run at once (or just the selected ones), and deleting run history from the
 * database - with the choice of whether the calls those runs logged are deleted too or kept.
 */
@Component({
  selector: 'app-relive-history',
  standalone: true,
  imports: [DatePipe, ReliveLiveCallsComponent, ReliveRunCompareComponent, ActionMenuComponent],
  templateUrl: './relive-history.component.html',
})
export class ReliveHistoryComponent implements OnInit {
  private readonly api = inject(ReliveApiService);
  /** Reloaded directly after a history delete that removed live-call rows, so the log below the
   *  runs list reflects the deletion without a page reload. */
  private readonly liveCalls = viewChild.required(ReliveLiveCallsComponent);

  readonly cycleId = input.required<string>();
  readonly cycleName = input('');
  readonly steps = input<readonly Step[]>([]);
  readonly variables = input<readonly CycleVariable[]>([]);
  /** The cycle's own noise rules now (the draft) - the comparison grades with them. */
  readonly cycleNoise = input<readonly NoiseRule[]>([]);
  readonly openRun = output<string>();
  /** "Open in run A / B" from the comparison: the run, at that step. */
  readonly openRunStep = output<{ readonly runId: string; readonly stepKey: string }>();
  /** "Ignore in cycle" from the comparison - a draft edit the cycle page applies. */
  readonly noiseChange = output<NoiseChange>();
  /** "Mock with it" (T074) - forwarded straight from `ReliveLiveCallsComponent`; this component owns
   *  no cycle draft of its own, so the cycle page applies it. */
  readonly mockWith = output<{ readonly stepKey: string; readonly callRule: CycleRule }>();

  readonly runs = signal<readonly Run[]>([]);
  /** Full runs (definition + step results) fetched so far, by id. */
  readonly loaded = signal<ReadonlyMap<string, FullRun>>(new Map());
  readonly shownCount = signal(MATRIX_PAGE);
  readonly metric = signal<'outcome' | 'time'>('outcome');
  readonly onlyChanged = signal(false);
  /** Side A: a run id, or `RECORDING_SIDE`. Null until runs are loaded (then the default pair). */
  readonly aId = signal<string | null>(null);
  readonly bId = signal<string | null>(null);
  /** The step a cell or a step name picked: highlighted here and opened in the comparison. */
  readonly focus = signal<{ readonly key: string } | null>(null);

  readonly busy = signal(false);
  readonly selected = signal<ReadonlySet<string>>(new Set());
  /** Open delete confirmation: which runs it covers and the headline it shows. Null = closed. */
  readonly deleteDialog = signal<{ readonly runIds: readonly string[]; readonly title: string } | null>(null);
  readonly deleteCalls = signal(false);

  readonly runningCount = computed(() => this.runs().filter((r) => r.status === 'RUNNING').length);
  readonly selectedCount = computed(() => this.selected().size);
  readonly selectedRunningCount = computed(
    () => this.runs().filter((r) => r.status === 'RUNNING' && this.selected().has(r.id)).length,
  );

  /** The matrix's columns: the newest `shownCount` runs, newest first. */
  readonly shownRuns = computed(() => this.runs().slice(0, this.shownCount()));
  /** The shown runs that have loaded - the matrix's actual columns, so heads and cells line up. */
  readonly columnRuns = computed(() => this.shownRuns().filter((r) => this.loaded().has(r.id)));
  readonly columns = computed<readonly CompareSide[]>(() => this.columnRuns().map((r) => runSide(this.loaded().get(r.id)!)));
  readonly matrix = computed(() => buildMatrix(this.columns()));
  readonly rows = computed(() => (this.onlyChanged() ? this.matrix().filter((r) => r.varies || r.note) : this.matrix()));
  readonly gridColumns = computed(() => `minmax(180px, 1.2fr) repeat(${this.columnRuns().length}, 96px) minmax(170px, 1fr)`);

  readonly sideB = computed<CompareSide | null>(() => {
    const run = this.bId() ? this.loaded().get(this.bId()!) : undefined;
    return run ? runSide(run) : null;
  });
  readonly sideA = computed<CompareSide | null>(() => {
    const b = this.sideB();
    const id = this.aId();
    if (!b || !id) return null;
    if (id === RECORDING_SIDE) return recordingSide(b);
    const run = this.loaded().get(id);
    return run ? runSide(run) : null;
  });

  ngOnInit(): void {
    this.refresh();
  }

  private refresh(): void {
    this.api.listRuns(this.cycleId()).subscribe((runs) => {
      this.runs.set(runs);
      // A run deleted elsewhere (or dropped by retention) must not linger in the selection.
      const known = new Set(runs.map((r) => r.id));
      const stillThere = new Set([...this.selected()].filter((id) => known.has(id)));
      if (stillThere.size !== this.selected().size) this.selected.set(stillThere);
      const loaded = new Map([...this.loaded()].filter(([id]) => known.has(id)));
      // A run that was still going when it was fetched is fetched again.
      for (const r of runs) if (loaded.get(r.id)?.status === 'RUNNING') loaded.delete(r.id);
      this.loaded.set(loaded);
      if (this.bId() && !known.has(this.bId()!)) this.bId.set(null);
      if (this.aId() && this.aId() !== RECORDING_SIDE && !known.has(this.aId()!)) this.aId.set(null);
      if (!this.bId() && runs.length) this.bId.set(runs[0].id);
      if (!this.aId() && runs.length) this.aId.set(runs.find((r) => r.id !== this.bId())?.id ?? RECORDING_SIDE);
      this.loadShown();
    });
  }

  /** Fetches every shown run, and A and B, not fetched yet. */
  private loadShown(): void {
    const wanted = new Set(this.shownRuns().map((r) => r.id));
    for (const id of [this.aId(), this.bId()]) if (id && id !== RECORDING_SIDE) wanted.add(id);
    for (const id of wanted) {
      if (this.loaded().has(id)) continue;
      this.api.getRun(this.cycleId(), id).subscribe((full) => {
        const next = new Map(this.loaded());
        next.set(id, full);
        this.loaded.set(next);
      });
    }
  }

  showOlder(): void {
    this.shownCount.update((n) => Math.min(this.runs().length, n + MATRIX_PAGE));
    this.loadShown();
  }

  // ---- Picking A and B ----

  makeA(runId: string): void {
    if (runId === this.bId()) this.bId.set(this.aId() === RECORDING_SIDE ? null : this.aId());
    this.aId.set(runId);
    this.ensurePair();
  }

  makeB(runId: string): void {
    if (runId === this.aId()) this.aId.set(this.bId());
    this.bId.set(runId);
    this.ensurePair();
  }

  /** Column head click: A; shift-click: B (the mock's gesture). The A / B buttons do the same. */
  pickColumn(runId: string, event: MouseEvent): void {
    if (event.shiftKey) this.makeB(runId);
    else this.makeA(runId);
  }

  compareWithRecording(runId: string): void {
    this.bId.set(runId);
    this.aId.set(RECORDING_SIDE);
    this.loadShown();
  }

  compareWithPrevious(runId: string): void {
    const i = this.runs().findIndex((r) => r.id === runId);
    const previous = this.runs()[i + 1];
    this.bId.set(runId);
    this.aId.set(previous?.id ?? RECORDING_SIDE);
    this.loadShown();
  }

  swap(): void {
    const a = this.aId();
    if (!a || a === RECORDING_SIDE) return;
    this.aId.set(this.bId());
    this.bId.set(a);
  }

  private ensurePair(): void {
    if (!this.bId()) this.bId.set(this.runs().find((r) => r.id !== this.aId())?.id ?? null);
    if (!this.aId()) this.aId.set(this.runs().find((r) => r.id !== this.bId())?.id ?? RECORDING_SIDE);
    this.loadShown();
  }

  /** A cell compares its run with the run before it (unless it is already A or B), and opens the
   *  step in the comparison below. */
  pickCell(stepKey: string, runId: string): void {
    if (runId !== this.aId() && runId !== this.bId()) {
      const columns = this.shownRuns();
      const i = columns.findIndex((r) => r.id === runId);
      this.bId.set(runId);
      this.aId.set(this.runs()[i + 1]?.id ?? RECORDING_SIDE);
      this.loadShown();
    }
    this.focus.set({ key: stepKey });
  }

  pickStep(stepKey: string): void {
    this.focus.set({ key: stepKey });
  }

  isA(runId: string): boolean {
    return this.aId() === runId;
  }

  isB(runId: string): boolean {
    return this.bId() === runId;
  }

  runById(id: string | null): Run | undefined {
    return id ? this.runs().find((r) => r.id === id) : undefined;
  }

  // ---- Cells ----

  cellText(cell: MatrixCell): string {
    if (this.metric() === 'outcome' || cell.outcome === 'skip') return OUTCOME_TEXT[cell.outcome];
    if (cell.durationMs == null) return '–';
    return cell.durationMs >= 1000 ? `${(cell.durationMs / 1000).toFixed(1)}s` : `${cell.durationMs}ms`;
  }

  cellClass(cell: MatrixCell): string {
    if (this.metric() === 'outcome' || cell.outcome === 'skip') return `rl-mx-${cell.outcome}`;
    return `rl-mx-${cell.time}`;
  }

  cellTitle(label: string, cell: MatrixCell): string {
    const run = this.runById(cell.runId);
    return `${label} · ${run ? new Date(run.startedAt).toLocaleString() : ''} · ${OUTCOME_WORD[cell.outcome]}${cell.durationMs != null ? ` · ${cell.durationMs} ms` : ''}`;
  }

  // ---- Bulk actions ----

  toggle(runId: string, event: Event): void {
    const next = new Set(this.selected());
    if ((event.target as HTMLInputElement).checked) next.add(runId);
    else next.delete(runId);
    this.selected.set(next);
  }

  allSelected(): boolean {
    const runs = this.runs();
    return runs.length > 0 && runs.every((r) => this.selected().has(r.id));
  }

  toggleAll(event: Event): void {
    this.selected.set((event.target as HTMLInputElement).checked ? new Set(this.runs().map((r) => r.id)) : new Set());
  }

  clearSelection(): void {
    this.selected.set(new Set());
  }

  /** One call to the bulk endpoint settles every RUNNING run of the cycle - the History tab's
   *  "stop everything at once" button. */
  stopAllRunning(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.stopRuns(this.cycleId()).subscribe({
      next: () => {
        this.busy.set(false);
        this.refresh();
      },
      error: () => this.busy.set(false),
    });
  }

  stopSelected(): void {
    if (this.busy() || this.selectedRunningCount() === 0) return;
    this.stop([...this.selected()]);
  }

  stopRun(run: Run): void {
    if (!this.busy()) this.stop([run.id]);
  }

  private stop(runIds: readonly string[]): void {
    this.busy.set(true);
    this.api.stopRuns(this.cycleId(), runIds).subscribe({
      next: () => {
        this.busy.set(false);
        this.refresh();
      },
      error: () => this.busy.set(false),
    });
  }

  askDeleteSelected(): void {
    const count = this.selectedCount();
    if (count === 0) return;
    this.askDelete([...this.selected()], `Delete ${count} selected run${count === 1 ? '' : 's'}?`);
  }

  askDeleteRun(run: Run): void {
    this.askDelete([run.id], `Delete the run of ${new Date(run.startedAt).toLocaleString()}?`);
  }

  askDeleteAll(): void {
    this.askDelete([], 'Delete the entire run history?');
  }

  private askDelete(runIds: readonly string[], title: string): void {
    this.deleteCalls.set(false);
    this.deleteDialog.set({ runIds, title });
  }

  cancelDelete(): void {
    if (!this.busy()) this.deleteDialog.set(null);
  }

  confirmDelete(): void {
    const dialog = this.deleteDialog();
    if (!dialog || this.busy()) return;
    this.busy.set(true);
    this.api.deleteRunHistory(this.cycleId(), dialog.runIds, this.deleteCalls()).subscribe({
      next: () => {
        this.busy.set(false);
        this.deleteDialog.set(null);
        this.selected.set(new Set());
        this.refresh();
        this.liveCalls().reload();
      },
      error: () => this.busy.set(false),
    });
  }

  statusPill(run: Run): readonly [string, string] {
    return STATUS_PILL[run.status] ?? STATUS_PILL.RUNNING;
  }

  /** "5/9 completed · 1 failed", plus "continued past N" once the run was resumed after a hold. */
  summaryOf(run: Run): string {
    const s = run.summary;
    const parts = [STATUS_TEXT[run.status] ?? run.status, `${s.completed}/${s.total} completed`];
    if (s.different > 0) parts.push(`${s.different} with differences`);
    if (s.failed > 0) parts.push(`${s.failed} failed`);
    if (run.resumed.length > 0) parts.push(`continued past ${run.resumed.length}`);
    const took = this.durationOf(run);
    if (took !== '…') parts.push(`took ${took}`);
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

  onIgnore(event: { readonly stepKey: string; readonly rule: NoiseRule }): void {
    this.noiseChange.emit({ stepKey: event.stepKey, rule: event.rule, scope: 'CYCLE', remove: false });
  }

  /** Export never truncates a step's full actual response body - see relive-run-export.ts. */
  exportRun(run: Run, format: ExportFormat): void {
    this.api.getRun(this.cycleId(), run.id).subscribe((full) => {
      const report = buildRunReport(full, new Date().toISOString());
      const name = `relive-run-${fileSafe(report.cycle.name)}-${fileSafe(full.startedAt)}`;
      if (format === 'markdown') downloadText(buildMarkdownRunReport(report), `${name}.md`, 'text/markdown');
      if (format === 'html') downloadText(buildHtmlRunReport(report), `${name}.html`, 'text/html');
      if (format === 'json') downloadText(buildJsonRunReport(report, { results: latestByStepKey(full.stepResults) }), `${name}.json`, 'application/json');
    });
  }
}
