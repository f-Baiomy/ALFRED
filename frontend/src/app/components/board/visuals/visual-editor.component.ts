import { Component, HostListener, OnDestroy, OnInit, computed, input, output, signal } from '@angular/core';
import { CHART_TYPES, ChartType, VISUAL_COLORS, infoAttrs, parseChart } from '../../../shared/utils/board-visuals';
import { SNIPPET_LIBS } from '../../../shared/utils/snippet-libs';
import { SnippetHostComponent } from './snippet-host.component';
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
  imports: [ChartBlockComponent, StatsBlockComponent, TimelineBlockComponent, SnippetHostComponent],
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
              @if (lang() === 'python') {
                <div class="vis-ed-row"><label>Name <input [value]="name()" placeholder="Python" (input)="name.set($any($event.target).value)" /></label></div>
              }
              @if (lang() === 'html') {
                <div class="vis-ed-row">
                  <label>Name <input [value]="name()" placeholder="HTML snippet" (input)="name.set($any($event.target).value)" /></label>
                  <label>Height <input class="sm" [value]="heightAttr()" placeholder="auto" (input)="heightAttr.set($any($event.target).value)" /></label>
                </div>
                <div class="vis-ed-libs" title="Alfred's own libraries - snippets have no network">
                  @for (l of libs; track l.id) {
                    <label [title]="l.name + ' ' + l.version + ' - ' + l.about + (l.kind === 'module' ? ' (import from &quot;' + l.provides + '&quot;)' : ' (window.' + l.provides + ')')">
                      <input type="checkbox" [checked]="chosen().has(l.id)" (change)="toggleLib(l.id)" />{{ l.id }}</label>
                  }
                </div>
              }
              <textarea class="vis-ed-src" spellcheck="false" [value]="text()" (input)="edit($any($event.target).value)"></textarea>
            }
          </div>
          <div class="vis-ed-right">
            @switch (lang()) {
              @case ('chart') { <app-chart-block [source]="text()" /> }
              @case ('stats') { <app-stats-block [source]="text()" /> }
              @case ('timeline') { <app-timeline-block [source]="text()" /> }
              @case ('html') { <app-snippet-host [source]="preview()" [info]="info()" /> }
              @case ('mermaid') { <app-snippet-host [source]="preview()" kind="mermaid" /> }
              @case ('python') { <app-snippet-host [source]="preview()" [info]="info()" kind="python" /> }
              @default { <pre class="board-vis-src">{{ text() }}</pre> }
            }
          </div>
        </div>
        <div class="vis-ed-foot"><span class="board-dim">The text stores the source - Claude reads and edits it the same way.</span>
          <span><button type="button" class="action-btn" (click)="closed.emit()">Cancel</button>
            <button type="button" class="action-btn primary" (click)="save()">{{ saveLabel() }}</button></span></div>
      </div>
    </div>`,
})
export class VisualEditorComponent implements OnInit, OnDestroy {
  readonly lang = input.required<string>();
  readonly source = input('');
  /** The fence's info string (an HTML snippet's `live name="…" libs="…"`). */
  readonly infoIn = input('', { alias: 'info' });
  readonly saveLabel = input('Insert');
  readonly saved = output<{ text: string; info: string }>();
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
  readonly libs = SNIPPET_LIBS.filter((l) => l.kind !== 'css' && !l.id.includes('-'));
  readonly name = signal('');
  readonly heightAttr = signal('');
  readonly chosen = signal<ReadonlySet<string>>(new Set());
  /** What the frame shows: the text, settled for a moment so a frame is not rebuilt on every key. */
  readonly preview = signal('');
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly info = computed(() => {
    if (this.lang() === 'python') return ['live', ...(this.name().trim() ? [`name="${this.name().trim().replace(/"/g, "'")}"`] : [])].join(' ');
    if (this.lang() !== 'html') return '';
    const parts = ['live'];
    if (this.name().trim()) parts.push(`name="${this.name().trim().replace(/"/g, "'")}"`);
    if (this.chosen().size) parts.push(`libs="${[...this.chosen()].join(' ')}"`);
    if (/^\d+$/.test(this.heightAttr().trim())) parts.push(`height=${this.heightAttr().trim()}`);
    if (/(^|\s)page(\s|$)/.test(this.infoIn())) parts.push('page');
    return parts.join(' ');
  });

  readonly title = computed(() => ({ chart: '▤ Chart', stats: '▦ Stats', timeline: '⏱ Timeline', html: '◈ HTML snippet', mermaid: '⬡ Diagram', python: '🐍 Python' } as Record<string, string>)[this.lang()] ?? this.lang());
  readonly help = computed(() => ({
    chart: 'bar · hbar · line · area · pie',
    stats: 'one per line: label | value | colour | note',
    timeline: 'one per line: label | start | length | colour (ms)',
    html: 'HTML, CSS and JavaScript - no network; alfred.data(), alfred.state, alfred.lib()',
    mermaid: 'Mermaid: flowchart, sequenceDiagram, stateDiagram…',
    python: 'Python 3.12 with numpy, pandas, matplotlib - await alfred.calls(...) is a DataFrame; the last line is shown; figures are drawn',
  } as Record<string, string>)[this.lang()] ?? '');

  ngOnInit(): void {
    this.text.set(this.source());
    this.preview.set(this.source());
    const a = infoAttrs(this.infoIn());
    this.name.set(a['name'] ?? '');
    this.heightAttr.set(a['height'] ?? '');
    this.chosen.set(new Set((a['libs'] ?? '').split(/[\s,]+/).map((x) => x.replace(/@.*$/, '').toLowerCase()).filter(Boolean)));
    if (this.lang() === 'chart') this.toGrid();
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  edit(v: string): void {
    this.text.set(v);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.preview.set(this.text()), 450);
  }

  toggleLib(id: string): void {
    this.chosen.update((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  save(): void {
    this.saved.emit({ text: this.text(), info: this.info() });
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
