import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { DbColumn, RowsPage, RowsPart, TypedValue } from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { valueText } from '../../shared/utils/db-statement-display';
import { DbHideColumnComponent } from './db-hide-column.component';
import { DbWindowState } from './db-window-state';

const PAGE = 100;
/** Up to this many rows sit inline; more go in the fixed-height box. */
const INLINE_ROWS = 8;

/**
 * A statement's stored rows (result or before-image). The first 100 load with the tab; scrolling near the bottom of
 * the fixed 320 px box appends the next 100 in place (mock: "rows-scroll fixed"), so a 50,000-row result never sits in
 * the page at once. Every row is stored - the count line says how many are loaded.
 */
@Component({
  standalone: true,
  selector: 'app-db-rows-table',
  imports: [DbHideColumnComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (error()) {
      <div class="rq-err">✕ {{ error() }}</div>
    }
    @if (page(); as p) {
      @if (p.overLimit) {
        <div class="empty-cap" style="margin-bottom:.45rem"><b>{{ (p.rowsRead ?? p.total).toLocaleString() }} rows returned - {{ p.total.toLocaleString() }} stored.</b>
          Over the per-result limit (Settings → Database capture). Counts and the statement are complete; only rows past
          {{ p.total.toLocaleString() }} were not kept.</div>
      }
      <div class="rows-scroll" [class.fixed]="p.total > inlineRows" (scroll)="onScroll($event)" data-testid="rows-scroll">
        <table class="kvt">
          <thead><tr>
            @for (c of columns(); track $index) {
              <th [title]="c.type">{{ c.name }} <app-db-hide-column [column]="c.name" /></th>
            }
          </tr></thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr>
                @for (v of row; track $index) {
                  <td [class.hit]="v.value != null && v.value === state?.trace()" [class.dim]="v.type === 'NOT_READ'"
                      (click)="trace(v)">{{ text(v) }}</td>
                }
              </tr>
            } @empty {
              <tr><td [attr.colspan]="columns().length || 1" class="dim">No rows.</td></tr>
            }
          </tbody>
        </table>
      </div>
      <div class="more">{{ countLine() }}</div>
    } @else if (!error()) {
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
  readonly page = signal<RowsPage | null>(null);
  readonly rows = signal<readonly (readonly TypedValue[])[]>([]);
  readonly error = signal<string | null>(null);
  private loading = false;

  readonly columns = computed<readonly DbColumn[]>(() => this.page()?.columns ?? []);
  readonly countLine = computed(() => {
    const p = this.page();
    if (!p) return '';
    const loaded = this.rows().length;
    const read = p.rowsRead != null && p.rowsRead > p.total ? ` (${p.rowsRead.toLocaleString()} returned)` : '';
    const more = loaded < p.total ? ` · ${loaded.toLocaleString()} loaded - scroll the table for more` : '';
    const partial = p.partial ? ' · the app stopped reading here' : '';
    return `${p.total.toLocaleString()} rows stored${read}${more}${partial} · all rows are stored, never re-read from the database`;
  });

  ngOnInit(): void {
    this.load(0);
  }

  private load(offset: number): void {
    if (this.loading) return;
    this.loading = true;
    const sub = this.api.rows(this.statementId(), this.part(), offset, PAGE).subscribe({
      next: (p) => {
        this.loading = false;
        this.page.set(p);
        this.rows.set(offset === 0 ? p.rows : [...this.rows(), ...p.rows]);
      },
      error: () => {
        this.loading = false;
        this.error.set('Could not load the rows.');
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  onScroll(event: Event): void {
    const box = event.target as HTMLElement;
    if (box.scrollTop + box.clientHeight < box.scrollHeight - 40) return;
    const p = this.page();
    if (p && this.rows().length < p.total) this.load(this.rows().length);
  }

  text(v: TypedValue): string {
    return valueText(v);
  }

  trace(v: TypedValue): void {
    this.state?.toggleTrace(v.value);
  }
}
