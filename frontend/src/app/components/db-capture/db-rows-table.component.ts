import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { Observable, Subscription } from 'rxjs';
import { RowsPage, RowsPart } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { valueText } from '../../shared/utils/db-statement-display';
import { QueryExample, rowQueryExamples } from '../../shared/utils/db-row-query-examples';
import { DbHideColumnComponent } from './db-hide-column.component';
import { DbWindowState } from './db-window-state';

const PAGE = 100;
/** Up to this many rows sit inline; more go in the fixed-height box. */
const INLINE_ROWS = 8;
/** Below this many rows the search/SQL bar would be noise. */
const QUERY_BAR_FROM = 4;

type Mode = 'search' | 'sql';

/**
 * A statement's stored rows (result or before-image). The first 100 load with the tab; scrolling near the bottom of
 * the fixed 320 px box appends the next 100 in place (mock: "rows-scroll fixed"), so a 50,000-row result never sits in
 * the page at once. Search (any column, click a header to sort) and SQL (one SELECT over a table named `result`) run on
 * the server over the RECORDED rows - never the application's database - and page the same way.
 */
@Component({
  standalone: true,
  selector: 'app-db-rows-table',
  imports: [DbHideColumnComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (page(); as p) {
      @if (p.overLimit) {
        <div class="empty-cap" style="margin-bottom:.45rem"><b>{{ (p.rowsRead ?? p.total).toLocaleString() }} rows returned - {{ p.total.toLocaleString() }} stored.</b>
          Over the per-result limit (Settings → Database capture). Counts and the statement are complete; only rows past
          {{ p.total.toLocaleString() }} were not kept.</div>
      }
      @if (p.total >= queryBarFrom) {
        <div class="rq-bar">
          <div class="toggle">
            <button type="button" [class.on]="mode() === 'search'" (click)="setMode('search')">Search</button>
            <button type="button" [class.on]="mode() === 'sql'" (click)="setMode('sql')">SQL</button>
          </div>
          @if (mode() === 'search') {
            <input class="dbw-search rq-search" placeholder="Filter rows - any column, e.g. TOPUP or 2026-10-03" [value]="text()" (input)="onSearch($event)">
            <span class="rq-hint">click a column name to sort</span>
          } @else {
            <span class="rq-hint">Query this result as a table named <code>result</code> · Ctrl+Enter runs</span>
          }
        </div>
        @if (mode() === 'sql') {
          <div class="rq-sql">
            <textarea rows="2" spellcheck="false" [value]="sql()" (input)="sql.set($any($event.target).value)" (keydown)="onSqlKey($event)"
                      placeholder="SELECT * FROM result WHERE amount > 500 ORDER BY amount DESC"></textarea>
            <div class="rq-actions">
              <button type="button" class="action-btn primary" (click)="runSql()">▶ Run</button>
              <button type="button" class="action-btn" (click)="clearSql()">Clear</button>
              <span class="rq-hint">Try:</span>
              @for (ex of examples(); track ex.label) {
                <button type="button" class="loc" (click)="useExample(ex)">{{ ex.label }}</button>
              }
            </div>
          </div>
        }
      }
      @if (error()) {
        <div class="rq-err">✕ {{ error() }}</div>
      }
      <div class="rows-scroll" [class.fixed]="total() > inlineRows" (scroll)="onScroll($event)" data-testid="rows-scroll">
        <table class="kvt">
          <thead><tr>
            @for (c of columns(); track $index) {
              <th [class.sortable]="!sqlApplied()" [title]="sqlApplied() ? '' : 'Sort by ' + c" (click)="sortBy(c)">{{ c }}{{ sortMark(c) }}
                @if (!sqlApplied()) {<app-db-hide-column [column]="c" />}
              </th>
            }
          </tr></thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr>
                @for (v of row; track $index) {
                  <td [class.hit]="v != null && v === state?.trace()" [class.dim]="v === notRead" (click)="trace(v)">{{ v ?? 'NULL' }}</td>
                }
              </tr>
            } @empty {
              <tr><td [attr.colspan]="columns().length || 1" class="dim">{{ filtered() ? 'No row matches.' : 'No rows.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
      <div class="more">{{ countLine() }}</div>
    } @else if (error()) {
      <div class="rq-err">✕ {{ error() }}</div>
    } @else {
      <div class="dimline">Loading rows…</div>
    }
  `,
})
export class DbRowsTableComponent implements OnInit {
  private readonly api = inject(DbCaptureApiService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly state = inject(DbWindowState, { optional: true });

  readonly statementId = input.required<number>();
  readonly part = input<RowsPart>('RESULT');

  readonly inlineRows = INLINE_ROWS;
  readonly queryBarFrom = QUERY_BAR_FROM;
  readonly notRead = valueText({ type: 'NOT_READ', value: null });

  /** The stored-rows page: columns, totals, over-limit facts. */
  readonly page = signal<RowsPage | null>(null);
  readonly columns = signal<readonly string[]>([]);
  readonly rows = signal<readonly (readonly (string | null)[])[]>([]);
  /** How many rows the current view has (stored rows, or the query's matches). */
  readonly total = signal(0);
  readonly error = signal<string | null>(null);

  readonly mode = signal<Mode>('search');
  readonly text = signal('');
  readonly sql = signal('');
  readonly sort = signal<{ readonly column: string; readonly dir: 'asc' | 'desc' } | null>(null);
  /** True while the shown rows are a query's (search text, sort, or SQL), not the plain stored order. */
  readonly filtered = signal(false);
  readonly sqlApplied = signal(false);

  private loading = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private current: Subscription | null = null;

  readonly examples = computed<QueryExample[]>(() => rowQueryExamples(this.page()?.columns.map((c) => c.name) ?? this.columns(), this.rows()));

  readonly countLine = computed(() => {
    const p = this.page();
    if (!p) return '';
    const loaded = this.rows().length;
    const total = this.total();
    const matched = this.filtered() ? `${total.toLocaleString()} ${this.sqlApplied() ? 'result rows' : 'match'} · ` : '';
    const read = p.rowsRead != null && p.rowsRead > p.total ? ` (${p.rowsRead.toLocaleString()} returned)` : '';
    const more = loaded < total ? ` · ${loaded.toLocaleString()} loaded - scroll the table for more` : '';
    const partial = p.partial ? ' · the app stopped reading here' : '';
    return `${matched}${p.total.toLocaleString()} rows recorded${read}${more}${partial} · runs on the recorded rows, never the real database`;
  });

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => {
      this.current?.unsubscribe();
      if (this.searchTimer) clearTimeout(this.searchTimer);
    });
    this.loadStored(0);
  }

  private track<T>(source: Observable<T>, next: (value: T) => void): void {
    this.loading = true;
    this.current = source.subscribe({
      next: (value) => {
        this.loading = false;
        next(value);
      },
      error: () => {
        this.loading = false;
        this.error.set('Could not load the rows.');
      },
    });
  }

  private loadStored(offset: number): void {
    this.track(this.api.rows(this.statementId(), this.part(), offset, PAGE), (p) => {
      this.page.set(p);
      this.columns.set(p.columns.map((c) => c.name));
      const rows = p.rows.map((r) => r.map((v) => (v.type === 'NOT_READ' ? this.notRead : v.value)));
      this.rows.set(offset === 0 ? rows : [...this.rows(), ...rows]);
      this.total.set(p.total);
    });
  }

  private loadQuery(offset: number): void {
    const sqlMode = this.mode() === 'sql' && !!this.sql().trim();
    const sort = this.sort();
    const request = {
      mode: sqlMode ? ('sql' as const) : ('search' as const),
      text: sqlMode ? this.sql() : this.text(),
      sortColumn: sqlMode ? null : sort?.column ?? null,
      sortDir: sqlMode ? null : sort?.dir ?? null,
      offset,
      limit: PAGE,
    };
    this.track(this.api.queryRows(this.statementId(), request, this.part()), (r) => {
      if (r.error) {
        this.error.set(r.error);
        return;
      }
      this.error.set(null);
      this.sqlApplied.set(sqlMode);
      this.columns.set(r.columns);
      this.rows.set(offset === 0 ? r.rows : [...this.rows(), ...r.rows]);
      this.total.set(r.total);
    });
  }

  /** Back to the stored order when nothing narrows or orders the rows; otherwise ask the server. */
  private refresh(): void {
    this.current?.unsubscribe();
    this.loading = false;
    this.error.set(null);
    const active = (this.mode() === 'sql' && !!this.sql().trim()) || !!this.text() || !!this.sort();
    this.filtered.set(active);
    if (!active) {
      this.sqlApplied.set(false);
      this.loadStored(0);
    } else {
      this.loadQuery(0);
    }
  }

  setMode(mode: Mode): void {
    this.mode.set(mode);
    if (mode === 'search' && this.sqlApplied()) this.refresh();
  }

  onSearch(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value.trim());
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.refresh(), 250);
  }

  sortBy(column: string): void {
    if (this.sqlApplied()) return;
    const s = this.sort();
    this.sort.set(!s || s.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : null);
    this.refresh();
  }

  sortMark(column: string): string {
    const s = this.sort();
    return !this.sqlApplied() && s?.column === column ? (s.dir === 'asc' ? ' ▲' : ' ▼') : '';
  }

  onSqlKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.runSql();
    }
  }

  runSql(): void {
    this.refresh();
  }

  clearSql(): void {
    this.sql.set('');
    this.refresh();
  }

  useExample(example: QueryExample): void {
    this.sql.set(example.sql);
    this.refresh();
  }

  onScroll(event: Event): void {
    const box = event.target as HTMLElement;
    if (this.loading || box.scrollTop + box.clientHeight < box.scrollHeight - 40) return;
    if (this.rows().length >= this.total()) return;
    if (this.filtered()) this.loadQuery(this.rows().length);
    else this.loadStored(this.rows().length);
  }

  trace(value: string | null): void {
    if (value != null && value !== this.notRead) this.state?.toggleTrace(value);
  }
}
