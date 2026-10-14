import { Component, HostListener, computed, input, output, signal, OnInit } from '@angular/core';
import { CHART_TYPES, ChartType, VISUAL_COLORS, parseChart } from '../../../shared/utils/board-visuals';
import { ChartBlockComponent } from './chart-block.component';
import { StatsBlockComponent } from './stats-block.component';
import { TimelineBlockComponent } from './timeline-block.component';

interface GridSeries { name: string; color: string; values: string[] }

/**
 * The block editor (specs/017 R37): a visual's source on the left, drawn live on the right. A chart can also be edited
 * as a grid of numbers (rows = labels, columns = series) - the grid and the JSON stay in step.
 */
@Component({
  selector: 'app-visual-editor',
  standalone: true,
  imports: [ChartBlockComponent, StatsBlockComponent, TimelineBlockComponent],
  template: `
    <div class="run-dialog-bg" (click)="closed.emit()">
      <div class="vis-ed" role="dialog" [attr.aria-label]="'Edit ' + lang()" (click)="$event.stopPropagation()">
        <div class="vis-ed-head"><b>{{ title() }}</b>
          @if (lang() === 'chart') {
            <span class="vis-ed-modes"><button type="button" class="board-link" [class.on]="mode() === 'grid'" (click)="toGrid()">▦ Grid</button>
              <button type="button" class="board-link" [class.on]="mode() === 'source'" (click)="mode.set('source')">{{ '{ }' }} JSON</button></span>
          }
          <span class="vis-ed-grow"></span><span class="board-dim">{{ help() }}</span>
        </div>
        <div class="vis-ed-body">
          <div class="vis-ed-left">
            @if (lang() === 'chart' && mode() === 'grid') {
              <div class="vis-ed-row">
                <label>Type <select [value]="gridType()" (change)="gridType.set($any($event.target).value); syncFromGrid()">
                  @for (t of chartTypes; track t) { <option [value]="t">{{ t }}</option> }</select></label>
                <label>Title <input [value]="gridTitle()" (input)="gridTitle.set($any($event.target).value); syncFromGrid()" /></label>
                <label>Unit <input class="sm" [value]="gridUnit()" (input)="gridUnit.set($any($event.target).value); syncFromGrid()" /></label>
                <label>Target <input class="sm" [value]="gridTarget()" placeholder="none" (input)="gridTarget.set($any($event.target).value); syncFromGrid()" /></label>
              </div>
              <div class="vis-ed-grid-wrap"><table class="vis-ed-grid">
                <tr><th>label</th>
                  @for (s of series(); track $index; let j = $index) {
                    <th><input [value]="s.name" placeholder="series" (input)="setSeries(j, 'name', $any($event.target).value)" />
                      <select [value]="s.color" (change)="setSeries(j, 'color', $any($event.target).value)">
                        @for (c of colors; track c) { <option [value]="c">{{ c }}</option> }</select>
                      <button type="button" class="board-link" title="Remove this series" (click)="removeSeries(j)">✕</button></th>
                  }
                  <th><button type="button" class="board-link" (click)="addSeries()">＋ series</button></th></tr>
                @for (l of labels(); track $index; let i = $index) {
                  <tr><td><input [value]="l" (input)="setLabel(i, $any($event.target).value)" /></td>
                    @for (s of series(); track $index; let j = $index) {
                      <td><input class="num" inputmode="decimal" [value]="s.values[i]" (input)="setValue(j, i, $any($event.target).value)" /></td>
                    }
                    <td><button type="button" class="board-link" title="Remove this row" (click)="removeLabel(i)">✕</button></td></tr>
                }
                <tr><td><button type="button" class="board-link" (click)="addLabel()">＋ row</button></td></tr>
              </table></div>
            } @else {
              <textarea class="vis-ed-src" spellcheck="false" [value]="text()" (input)="text.set($any($event.target).value)"></textarea>
            }
          </div>
          <div class="vis-ed-right">
            @switch (lang()) {
              @case ('chart') { <app-chart-block [source]="text()" /> }
              @case ('stats') { <app-stats-block [source]="text()" /> }
              @case ('timeline') { <app-timeline-block [source]="text()" /> }
              @default { <pre class="board-vis-src">{{ text() }}</pre> }
            }
          </div>
        </div>
        <div class="vis-ed-foot"><span class="board-dim">The text stores the source - Claude reads and edits it the same way.</span>
          <span><button type="button" class="action-btn" (click)="closed.emit()">Cancel</button>
            <button type="button" class="action-btn primary" (click)="saved.emit(text())">{{ saveLabel() }}</button></span></div>
      </div>
    </div>`,
})
export class VisualEditorComponent implements OnInit {
  readonly lang = input.required<string>();
  readonly source = input('');
  readonly saveLabel = input('Insert');
  readonly saved = output<string>();
  readonly closed = output<void>();

  readonly chartTypes = CHART_TYPES;
  readonly colors = VISUAL_COLORS;
  readonly text = signal('');
  readonly mode = signal<'grid' | 'source'>('grid');
  readonly gridType = signal<ChartType>('bar');
  readonly gridTitle = signal('');
  readonly gridUnit = signal('');
  readonly gridTarget = signal('');
  readonly labels = signal<string[]>([]);
  readonly series = signal<GridSeries[]>([]);

  readonly title = computed(() => ({ chart: '▤ Chart', stats: '▦ Stats', timeline: '⏱ Timeline' } as Record<string, string>)[this.lang()] ?? this.lang());
  readonly help = computed(() => ({
    chart: 'bar · hbar · line · area · pie',
    stats: 'one per line: label | value | colour | note',
    timeline: 'one per line: label | start | length | colour (ms)',
  } as Record<string, string>)[this.lang()] ?? '');

  ngOnInit(): void {
    this.text.set(this.source());
    if (this.lang() === 'chart') this.toGrid();
  }

  @HostListener('document:keydown.escape')
  escape(): void {
    this.closed.emit();
  }

  /** The JSON read into the grid; a JSON the grid cannot hold (does not parse) stays in source mode. */
  toGrid(): void {
    const p = parseChart(this.text());
    if (!p.model) { this.mode.set('source'); return; }
    const m = p.model;
    this.gridType.set(m.type);
    this.gridTitle.set(m.title);
    this.gridUnit.set(m.unit);
    this.gridTarget.set(m.line ? String(m.line.at) : '');
    this.labels.set([...m.labels]);
    this.series.set(m.series.map((s) => ({ name: s.name, color: colorName(s.color), values: m.labels.map((_, i) => (s.values[i] ?? '') + '') })));
    this.mode.set('grid');
  }

  syncFromGrid(): void {
    const target = Number(this.gridTarget());
    const spec = {
      type: this.gridType(), ...(this.gridTitle() ? { title: this.gridTitle() } : {}), ...(this.gridUnit() ? { unit: this.gridUnit() } : {}),
      labels: this.labels(),
      series: this.series().map((s) => ({ name: s.name, values: s.values.map((v) => Number(v) || 0), color: s.color })),
      ...(this.gridTarget().trim() && Number.isFinite(target) ? { line: { at: target, label: 'target' } } : {}),
    };
    this.text.set(JSON.stringify(spec, null, 1));
  }

  setLabel(i: number, v: string): void { this.labels.update((l) => l.map((x, k) => (k === i ? v : x))); this.syncFromGrid(); }
  addLabel(): void { this.labels.update((l) => [...l, `Row ${l.length + 1}`]); this.series.update((s) => s.map((x) => ({ ...x, values: [...x.values, '0'] }))); this.syncFromGrid(); }
  removeLabel(i: number): void { this.labels.update((l) => l.filter((_, k) => k !== i)); this.series.update((s) => s.map((x) => ({ ...x, values: x.values.filter((_, k) => k !== i) }))); this.syncFromGrid(); }
  addSeries(): void { this.series.update((s) => [...s, { name: `Series ${s.length + 1}`, color: VISUAL_COLORS[s.length % 5], values: this.labels().map(() => '0') }]); this.syncFromGrid(); }
  removeSeries(j: number): void { this.series.update((s) => s.filter((_, k) => k !== j)); this.syncFromGrid(); }
  setSeries(j: number, key: 'name' | 'color', v: string): void { this.series.update((s) => s.map((x, k) => (k === j ? { ...x, [key]: v } : x))); this.syncFromGrid(); }
  setValue(j: number, i: number, v: string): void {
    this.series.update((s) => s.map((x, k) => (k === j ? { ...x, values: x.values.map((y, n) => (n === i ? v : y)) } : x)));
    this.syncFromGrid();
  }
}

const NAMED: Record<string, string> = { '#f87171': 'red', '#34d399': 'green', '#fbbf24': 'amber', '#60a5fa': 'blue', '#a78bfa': 'purple', '#22d3ee': 'cyan', '#5c6690': 'dim' };
function colorName(hex: string): string {
  return NAMED[hex.toLowerCase()] ?? 'purple';
}
