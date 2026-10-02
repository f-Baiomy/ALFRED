import { DatePipe } from '@angular/common';
import { Component, ElementRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { CallInterception, OriginalHttp } from '../../core/models/interception.model';
import { downloadText } from '../../shared/utils/download';
import { maskRelive } from '../../shared/utils/relive-mask';
import { formatReasonDetail } from '../../shared/utils/relive-outcome';
import {
  CompareSide,
  FieldChange,
  HttpShape,
  SideOutcome,
  StepComparison,
  StepSide,
  StepVerdict,
  compareRuns,
} from '../../shared/utils/relive-run-compare';
import { buildHtmlCompareReport, buildJsonCompareReport, buildMarkdownCompareReport } from '../../shared/utils/relive-run-export';
import { NoiseRule, Run, Step } from '../../shared/utils/relive-types';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { InterceptionPanelComponent } from '../interception-panel/interception-panel.component';

/** A tile / filter of the step table. 'changed' = every verdict but SAME. */
export type CompareFilter = 'changed' | 'all' | StepVerdict;

const OUTCOME_PILL: Readonly<Record<SideOutcome, readonly [string, string]>> = {
  ok: ['rl-p-ok', '✓'],
  diff: ['rl-p-diff', '≠'],
  fail: ['rl-p-fail', '✗'],
  skip: ['rl-p-wait', '–'],
};

const VERDICT_PILL: Readonly<Record<StepVerdict, readonly [string, string]>> = {
  NEW_FAILURE: ['rl-p-fail', '✗ new failure'],
  FIXED: ['rl-p-replay', '✓ fixed'],
  CHANGED: ['rl-p-diff', '≠ answer changed'],
  NOT_RUN: ['rl-p-wait', '– ran in one only'],
  SLOWER: ['rl-p-diff', '▲ slower'],
  FASTER: ['rl-p-ok', '▼ faster'],
  SAME: ['rl-p-wait', 'same'],
};

const RUN_PILL: Readonly<Record<Run['status'], readonly [string, string]>> = {
  RUNNING: ['rl-p-cycle', '● running'],
  COMPLETED: ['rl-p-ok', '✓ completed'],
  COMPLETED_WITH_DIFFERENCES: ['rl-p-diff', '⚠ differences'],
  FAILED: ['rl-p-fail', '✕ failed'],
  STOPPED: ['rl-p-wait', '■ stopped'],
  INTERRUPTED: ['rl-p-wait', '■ interrupted'],
};

/**
 * Two runs compared step by step (T134, run-compare-mock.html option A's page, shown under the
 * History matrix in option C): a verdict line, count tiles that filter, a table of the steps -
 * changed ones only by default - each expandable to the response fields that changed, what it
 * sent differently, and the Request / Response of A against B in the interception panel's diff,
 * then every value each run captured side by side. Side A may be the recording itself.
 */
@Component({
  selector: 'app-relive-run-compare',
  standalone: true,
  imports: [DatePipe, ActionMenuComponent, InterceptionPanelComponent],
  templateUrl: './relive-run-compare.component.html',
})
export class ReliveRunCompareComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly a = input.required<CompareSide>();
  readonly b = input.required<CompareSide>();
  readonly cycleName = input('');
  /** The cycle's noise rules now (the draft), so "Ignore in cycle" takes effect at once. */
  readonly cycleNoise = input<readonly NoiseRule[]>([]);
  /** The cycle's steps now, for each step's own noise rules. */
  readonly steps = input<readonly Step[]>([]);
  /** A matrix cell asks for one step: opened and scrolled to. A new object each time. */
  readonly focus = input<{ readonly key: string } | null>(null);

  readonly ignore = output<{ readonly stepKey: string; readonly rule: NoiseRule }>();
  readonly openRun = output<{ readonly runId: string; readonly stepKey: string }>();
  readonly swap = output<void>();

  readonly filter = signal<CompareFilter>('changed');
  readonly showNoise = signal(false);
  readonly query = signal('');
  readonly openKey = signal<string | null>(null);
  readonly half = signal<'request' | 'response' | null>(null);

  readonly comparison = computed(() => {
    const cycleNoise = this.cycleNoise();
    const current = new Map(this.steps().map((s) => [s.key, s]));
    const own = new Map([...this.a().steps, ...this.b().steps].map((s) => [s.key, s]));
    return compareRuns(this.a(), this.b(), (key) => [...cycleNoise, ...((current.get(key) ?? own.get(key))?.noise ?? [])]);
  });

  readonly tiles = computed(() => {
    const { counts, changedCount } = this.comparison();
    const tiles: { key: CompareFilter; label: string; count: number; tone: string }[] = [
      { key: 'changed', label: 'all changes', count: changedCount, tone: 'rl-cmp-amber' },
      { key: 'NEW_FAILURE', label: 'new failures', count: counts.NEW_FAILURE, tone: 'rl-cmp-red' },
      { key: 'FIXED', label: 'fixed', count: counts.FIXED, tone: 'rl-cmp-cyan' },
      { key: 'CHANGED', label: 'answers changed', count: counts.CHANGED, tone: 'rl-cmp-amber' },
      { key: 'SLOWER', label: 'slower (>25%)', count: counts.SLOWER, tone: 'rl-cmp-amber' },
      { key: 'FASTER', label: 'faster', count: counts.FASTER, tone: 'rl-cmp-green' },
      { key: 'SAME', label: 'same', count: counts.SAME, tone: 'rl-cmp-dim' },
    ];
    if (counts.NOT_RUN) tiles.splice(3, 0, { key: 'NOT_RUN', label: 'ran in one only', count: counts.NOT_RUN, tone: 'rl-cmp-dim' });
    return tiles;
  });

  readonly shown = computed(() => {
    const filter = this.filter();
    const q = this.query().trim().toLowerCase();
    return this.comparison().rows.filter((row) => {
      if (q && !`${row.label} ${row.path}`.toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      if (filter === 'changed') return row.verdict !== 'SAME';
      return row.verdict === filter;
    });
  });

  readonly secretNames = computed(() => [...new Set([...this.a().secretNames, ...this.b().secretNames])]);
  private readonly values = computed(() => {
    const out: Record<string, string> = {};
    for (const v of [...this.a().variables, ...this.b().variables]) out[v.name] = v.value;
    return out;
  });

  constructor() {
    effect(() => {
      const focus = this.focus();
      if (!focus) return;
      const row = untracked(() => this.comparison().rows.find((r) => r.key === focus.key));
      if (!row) return;
      // Only a new focus re-runs this: an "Ignore in cycle" recomputing the rows must not reopen it.
      queueMicrotask(() => {
        if (!this.shown().some((r) => r.key === focus.key)) this.filter.set('all');
        this.openKey.set(focus.key);
        this.half.set(null);
        setTimeout(() => this.host.nativeElement.querySelector(`[data-cmp-key="${CSS.escape(focus.key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      });
    });
  }

  setFilter(filter: CompareFilter): void {
    this.filter.set(filter);
  }

  toggleRow(key: string): void {
    this.openKey.update((current) => (current === key ? null : key));
    this.half.set(null);
  }

  toggleHalf(half: 'request' | 'response'): void {
    this.half.update((current) => (current === half ? null : half));
  }

  outcomePill(outcome: SideOutcome): readonly [string, string] {
    return OUTCOME_PILL[outcome];
  }

  verdictPill(verdict: StepVerdict): readonly [string, string] {
    return VERDICT_PILL[verdict];
  }

  runPill(side: CompareSide): readonly [string, string] | null {
    return side.status ? RUN_PILL[side.status] ?? null : null;
  }

  sideSummary(side: CompareSide): string {
    if (side.isRecording) return `${side.steps.length} steps as recorded`;
    const results = Object.values(side.results);
    const ran = results.filter((r) => !['PENDING', 'WAITING', 'SKIPPED', 'NOT_CALLED', 'CANCELLED'].includes(r.state)).length;
    const parts = [`${ran}/${side.steps.length} steps`];
    if (side.startedAt && side.finishedAt) {
      parts.push(`${Math.max(0, Math.round((Date.parse(side.finishedAt) - Date.parse(side.startedAt)) / 1000))}s`);
    }
    if (side.driver) parts.push(`driver: ${side.driver === 'GUIDED' ? 'Guided' : 'Automatic'}`);
    return parts.join(' · ');
  }

  /** True when the cycle was saved between the two runs, so a difference may be an edit. */
  readonly editedBetween = computed(() => {
    const a = this.a();
    const b = this.b();
    return !a.isRecording && !b.isRecording && !!a.cycleUpdatedAt && !!b.cycleUpdatedAt && a.cycleUpdatedAt !== b.cycleUpdatedAt;
  });

  sideLine(step: StepSide): string {
    const parts = [`${OUTCOME_PILL[step.outcome][1]} ${step.status ?? 'no answer'}`, this.timeText(step.durationMs)];
    if (step.mode) parts.push(step.mode);
    return parts.join(' · ');
  }

  rulesOf(step: StepSide): string | null {
    const rules = step.result?.rulesApplied ?? [];
    return rules.length ? rules.map((r) => r.name).join(', ') : null;
  }

  token(name: string): string {
    return `{{${name}}}`;
  }

  unexpectedCount(row: StepComparison): number {
    return row.fields.filter((f) => !f.noise).length;
  }

  noiseCount(row: StepComparison): number {
    return row.fields.length - this.unexpectedCount(row);
  }

  visibleFields(row: StepComparison): readonly FieldChange[] {
    return this.showNoise() ? row.fields : row.fields.filter((f) => !f.noise);
  }

  timeText(ms: number | null): string {
    if (ms == null) return '-';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  }

  /** Bar widths of A and B's time, relative to the longer of the two. */
  bars(row: StepComparison): readonly [number, number] {
    const a = row.a.durationMs ?? 0;
    const b = row.b.durationMs ?? 0;
    const max = Math.max(a, b);
    return max > 0 ? [(a / max) * 100, (b / max) * 100] : [0, 0];
  }

  value(text: string | null): string {
    if (text == null) return '(not present)';
    if (!text) return '(empty)';
    return this.mask(formatReasonDetail(text));
  }

  mask(text: string): string {
    return maskRelive(text, this.secretNames(), this.values());
  }

  ignoreInCycle(row: StepComparison, field: FieldChange): void {
    const part = field.part === 'status' || field.part === 'header' || field.part === 'query' ? field.part : 'body';
    this.ignore.emit({ stepKey: row.key, rule: { part, path: field.path, auto: false, count: false } });
  }

  open(side: CompareSide, row: StepComparison): void {
    if (!side.isRecording) this.openRun.emit({ runId: side.id, stepKey: row.key });
  }

  interception(row: StepComparison): CallInterception {
    return {
      applied: [],
      originalRequest: this.maskHttp(row.a.request),
      originalResponse: this.maskHttp(row.a.response),
      finalRequest: this.maskHttp(row.b.request),
      finalResponse: this.maskHttp(row.b.response),
    };
  }

  halfLabels(half: 'request' | 'response'): { title: string; before: string; after: string; legend: string } {
    const title = half === 'request' ? 'Request' : 'Response';
    return { title, before: `A · ${this.sideName(this.a())}`, after: `B · ${this.sideName(this.b())}`, legend: `Red is run A's ${half}; green is run B's.` };
  }

  sideName(side: CompareSide): string {
    if (side.isRecording) return 'the recording';
    return side.startedAt ? new Date(side.startedAt).toLocaleString() : side.id;
  }

  exportAs(format: 'markdown' | 'html' | 'json'): void {
    const cmp = this.comparison();
    const sides = { a: this.exportName(this.a()), b: this.exportName(this.b()) };
    const name = `relive-compare-${this.fileStamp(this.a())}-vs-${this.fileStamp(this.b())}`;
    if (format === 'markdown') downloadText(buildMarkdownCompareReport(cmp, this.cycleName(), sides, this.secretNames(), this.values()), `${name}.md`, 'text/markdown');
    if (format === 'html') downloadText(buildHtmlCompareReport(cmp, this.cycleName(), sides, this.secretNames(), this.values()), `${name}.html`, 'text/html');
    if (format === 'json') downloadText(buildJsonCompareReport(cmp, this.cycleName(), sides), `${name}.json`, 'application/json');
  }

  private exportName(side: CompareSide): string {
    return side.isRecording ? 'The recording' : `Run ${side.id} of ${side.startedAt}`;
  }

  private fileStamp(side: CompareSide): string {
    return side.isRecording ? 'recording' : (side.startedAt ?? side.id).replace(/[^a-z0-9]+/gi, '-');
  }

  private maskHttp(http: HttpShape | null): OriginalHttp | null {
    if (!http) return null;
    return {
      status: http.status ?? null,
      method: http.method ?? null,
      url: http.url ?? null,
      headers: Object.fromEntries(Object.entries(http.headers ?? {}).map(([name, value]) => [name, this.mask(String(value))])),
      body: http.body ? this.mask(http.body) : http.body,
    };
  }
}
