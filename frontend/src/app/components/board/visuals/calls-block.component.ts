import { Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { MentionRef } from '../../../core/models/board.models';
import { DataCallRow, SnippetDataService } from '../../../core/services/snippet-data.service';
import { CALL_FIELDS, CallField, parseShow, percentile, queryFields, rowsChart } from '../../../shared/utils/query-blocks';
import { MentionChipComponent } from '../mention-chip/mention-chip.component';
import { ChartBlockComponent } from './chart-block.component';

/**
 * ```calls``` (specs/017 R18): the calls to an endpoint since a moment, drawn from live data - a table or a chart, with
 * a summary line (count, median, 95th, errors). Its text holds only the question:
 * `endpoint: POST /fare` · `since: fix | 24h | call:in:<id> | <iso>` · `until:` · `cycle: <id>` · `signal: 5xx` ·
 * `project:` · `limit: 200` · `show: table(status, ms, sql) | chart(ms, bar)`. Re-read when calls arrive, while on screen.
 */
@Component({
  selector: 'app-calls-block',
  standalone: true,
  imports: [MentionChipComponent, ChartBlockComponent],
  template: `
    <div class="board-vis board-query" dir="ltr">
      <div class="board-vis-bar"><span>⌁ calls{{ title() ? ' · ' + title() : '' }}</span>
        <span>@if (loading()) { <span class="board-dim">reading…</span> } <button type="button" class="board-link" (click)="showSource.set(!showSource())">&lt;/&gt;</button></span></div>
      @if (error(); as e) { <div class="board-vis-err">{{ e }}</div> }
      @if (rows(); as rs) {
        <div class="board-query-sum">{{ rs.length }}{{ truncated() ? '+' : '' }} call{{ rs.length === 1 ? '' : 's' }}
          @if (stats(); as st) { · median {{ st.median }} ms · 95th {{ st.p95 }} ms }
          @if (failures()) { · <span class="c-red">{{ failures() }} failed</span> }</div>
        @if (show().kind === 'chart') {
          @if (rs.length) { <app-chart-block [source]="chart()" /> } @else { <div class="board-dim board-query-empty">No calls match yet.</div> }
        } @else {
          <div class="board-md-table-wrap scroll"><table class="board-md-table board-query-table">
            <thead><tr><th>Call</th>@for (f of show().fields; track f) { <th>{{ label(f) }}</th> }</tr></thead>
            <tbody>
              @for (r of rs; track r.ref) {
                <tr><td><app-mention-chip [mention]="mention(r)" /></td>
                  @for (f of show().fields; track f) { <td [class]="cellClass(r, f)">{{ cell(r, f) }}</td> }</tr>
              } @empty { <tr><td [attr.colspan]="show().fields.length + 1" class="board-dim">No calls match yet.</td></tr> }
            </tbody>
          </table></div>
        }
      }
      @if (showSource()) { <pre class="board-vis-src">{{ source() }}</pre> }
    </div>`,
})
export class CallsBlockComponent {
  readonly source = input.required<string>();
  /** Where the text is: an omitted project is its project; `since: fix` is its card's. */
  readonly context = input<Record<string, unknown>>({});

  private readonly data = inject(SnippetDataService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly rows = signal<readonly DataCallRow[] | null>(null);
  readonly truncated = signal(false);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly showSource = signal(false);
  readonly fields = computed(() => queryFields(this.source()));
  readonly show = computed(() => parseShow(this.fields()['show']));
  readonly title = computed(() => this.fields()['title'] ?? this.fields()['endpoint'] ?? '');
  readonly chart = computed(() => rowsChart((this.rows() ?? []) as unknown as Record<string, unknown>[], this.show(), this.fields()['title'] ?? ''));
  readonly stats = computed(() => {
    const ms = (this.rows() ?? []).map((r) => r.durationMs ?? NaN);
    const median = percentile(ms, 0.5);
    return median === null ? null : { median: Math.round(median), p95: Math.round(percentile(ms, 0.95) ?? 0) };
  });
  readonly failures = computed(() => (this.rows() ?? []).filter((r) => r.signal === '5xx' || r.signal === 'error').length);
  private visible = true;
  private stale = false;
  private seq = 0;

  constructor() {
    effect(() => {
      this.fields();
      untracked(() => void this.load());
    });
    let sub: Subscription | null = this.data.changes('calls').subscribe(() => {
      if (this.visible) void this.load(); else this.stale = true;
    });
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((e) => {
      this.visible = e.some((x) => x.isIntersecting);
      if (this.visible && this.stale) { this.stale = false; void this.load(); }
    });
    observer?.observe(this.host.nativeElement);
    inject(DestroyRef).onDestroy(() => { sub?.unsubscribe(); sub = null; observer?.disconnect(); });
  }

  async load(): Promise<void> {
    const show = this.show();
    if (show.error) { this.error.set(show.error); return; }
    const f = this.fields();
    const c = this.context();
    const n = ++this.seq;
    this.loading.set(true);
    try {
      const rows = await this.data.read('calls', f, { project: str(c['project']), cardId: str(c['cardId']), cycleId: str(c['cycleId']) }) as DataCallRow[];
      if (n !== this.seq) return;
      this.rows.set(rows);
      this.truncated.set(rows.length >= Number(f['limit'] || 200));
      this.error.set(null);
    } catch (e) {
      if (n === this.seq) this.error.set(e instanceof Error ? e.message : (e as { error?: { message?: string } })?.error?.message ?? 'Could not read the calls');
    } finally {
      if (n === this.seq) this.loading.set(false);
    }
  }

  label(f: CallField): string {
    return CALL_FIELDS[f];
  }

  mention(r: DataCallRow): MentionRef {
    return { type: 'call', ref: r.ref, label: `${r.method} ${r.path} · ${r.status ?? 'error'}` } as MentionRef;
  }

  cell(r: DataCallRow, f: CallField): string {
    const v = r[f];
    if (v === null || v === undefined) return '–';
    if (f === 'at') return new Date(v as string).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (f === 'durationMs' || f === 'dbMs') return String(Math.round(v as number));
    return String(v);
  }

  cellClass(r: DataCallRow, f: CallField): string {
    if (f === 'status') return r.signal === '5xx' || r.signal === 'error' ? 'c-red' : r.signal === '4xx' ? 'c-amber' : 'c-green';
    if ((f === 'errors' || f === 'failedStatements') && (r[f] ?? 0) > 0) return 'c-red';
    return '';
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
