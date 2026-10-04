import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, computed, inject, input, output, signal,
} from '@angular/core';
import { EMPTY, Observable, expand, reduce } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import {
  CallStatementsPage, CapturedStatement, DbFlag, StatementTransaction, SupplierMarker,
} from '../../core/models/db-capture.model';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { CallsStateService } from '../../core/state/calls-state.service';
import { buildStatementTree, initiallyFolded, pathTo } from '../../shared/utils/db-statement-tree';
import { flagText, isDelete, isFailed, isWrite, msText } from '../../shared/utils/db-statement-display';
import { buildSqlScript } from '../../shared/utils/sql-export-builder';
import { DbStatementListComponent } from './db-statement-list.component';
import { DbKindFilter, DbWindowState } from './db-window-state';
import { DbWindowRequest } from './db-window.service';

const PAGE = 500;
const DEFAULT_REPEAT_THRESHOLD = 5;

interface StripSegment {
  readonly seq: number;
  readonly kind: 'db' | 'sup' | 'fail';
  readonly left: number;
  readonly width: number;
  readonly title: string;
}

/**
 * The database window (specs/006-db-capture/mock.html, "DATABASE WINDOW"): one inbound call's statements in the order
 * they ran, with its supplier calls between them, transactions and repeated queries as folded tree nodes, and each
 * statement expandable to its SQL, parameters, rows, error and code location. Statements are fetched in pages of 500
 * as the body scrolls; while the call is still running, `statements-appended` on the socket fetches what is new.
 * The same window shows the "outside any call" bucket, grouped by thread.
 */
@Component({
  standalone: true,
  selector: 'app-db-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DbStatementListComponent],
  providers: [DbWindowState],
  templateUrl: './db-window.component.html',
})
export class DbWindowComponent implements OnInit {
  private readonly api = inject(DbCaptureApiService);
  private readonly dbState = inject(DbCaptureStateService);
  private readonly calls = inject(CallsStateService, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly state = inject(DbWindowState);

  readonly request = input.required<DbWindowRequest>();
  readonly closed = output<void>();

  readonly statements = signal<readonly CapturedStatement[]>([]);
  readonly transactions = signal<readonly StatementTransaction[]>([]);
  readonly markers = signal<readonly SupplierMarker[]>([]);
  readonly hasMore = signal(false);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly compact = signal(false);
  readonly exportNote = signal<string | null>(null);
  private fetching = false;

  readonly call = computed<CallRecord | null>(() => {
    const r = this.request();
    return r.kind === 'call' ? r.call : null;
  });
  readonly summary = computed(() => {
    const c = this.call();
    return c ? this.dbState.summaries().get(c.id) ?? null : null;
  });
  readonly flags = computed<readonly DbFlag[]>(() => this.summary()?.flags ?? []);

  readonly tree = computed(() => buildStatementTree(this.statements(), this.markers(), this.transactions(), DEFAULT_REPEAT_THRESHOLD));
  /** Outside-call statements, one section per thread. */
  readonly threads = computed(() => {
    const by = new Map<string, CapturedStatement[]>();
    for (const s of this.statements()) {
      const list = by.get(s.thread) ?? [];
      list.push(s);
      by.set(s.thread, list);
    }
    return [...by.entries()].map(([thread, list]) => ({ thread, nodes: buildStatementTree(list, [], [], DEFAULT_REPEAT_THRESHOLD) }));
  });

  readonly totalCount = computed(() => {
    const s = this.summary();
    return Math.max(s?.statementCount ?? 0, this.statements().length);
  });
  readonly shownCount = computed(() => this.statements().filter((s) => this.state.matches(s)).length);
  readonly writeCount = computed(() => this.summary()?.writeCount ?? this.statements().filter(isWrite).length);
  readonly deleteCount = computed(() => this.summary()?.deleteCount ?? this.statements().filter(isDelete).length);
  readonly failedCount = computed(() => this.summary()?.failedCount ?? this.statements().filter(isFailed).length);
  readonly txCount = computed(() => this.summary()?.transactionCount ?? this.transactions().length);
  readonly rolledBackCount = computed(() => this.summary()?.rolledBackCount ?? this.transactions().filter((t) => t.outcome === 'ROLLED_BACK').length);
  readonly dbMicros = computed(() => this.summary()?.dbMicros ?? this.statements().reduce((a, s) => a + s.durationMicros, 0));
  readonly droppedCount = computed(() => this.summary()?.droppedCount ?? 0);
  readonly callMs = computed(() => this.call()?.duration_ms ?? null);

  readonly kinds: readonly { readonly key: DbKindFilter; readonly label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'read', label: 'Reads' }, { key: 'write', label: 'Writes' },
    { key: 'delete', label: 'Deletes' }, { key: 'fail', label: 'Failed' },
  ];

  /** Time strip: statements (teal), supplier calls (cyan) and failures (red) across the call's duration. */
  readonly strip = computed<StripSegment[]>(() => {
    const call = this.call();
    const statements = this.statements();
    if (!call || !statements.length) return [];
    const suppliers = this.state.suppliersBySeq();
    const callStart = Date.parse(call.timestamp);
    const lastEnd = Math.max(...statements.map((s) => s.offsetMicros + s.durationMicros)) / 1000;
    const total = Math.max(this.callMs() ?? 0, lastEnd, 1);
    const segments: StripSegment[] = statements.map((s) => ({
      seq: s.seq,
      kind: isFailed(s) ? 'fail' : 'db',
      left: (s.offsetMicros / 1000 / total) * 100,
      width: (s.durationMicros / 1000 / total) * 100,
      title: `#${s.seq} · ${s.kind} ${s.table ?? ''} · ${msText(s.durationMicros)}`,
    }));
    for (const [seq, sup] of suppliers) {
      const start = Date.parse(sup.timestamp) - callStart;
      if (Number.isFinite(start)) {
        segments.push({ seq, kind: 'sup', left: (Math.max(0, start) / total) * 100, width: ((sup.duration_ms ?? 0) / total) * 100, title: `#${seq} · ${sup.method} ${sup.url} · ${sup.duration_ms} ms` });
      }
    }
    return segments;
  });
  readonly supplierMs = computed(() => [...this.state.suppliersBySeq().values()].reduce((a, c) => a + (c.duration_ms ?? 0), 0));
  readonly stripTotalMs = computed(() => {
    const statements = this.statements();
    const lastEnd = statements.length ? Math.max(...statements.map((s) => s.offsetMicros + s.durationMicros)) / 1000 : 0;
    return Math.round(Math.max(this.callMs() ?? 0, lastEnd));
  });

  ngOnInit(): void {
    const call = this.call();
    if (call) {
      this.dbState.requestSummary(call.id);
      this.state.suppliersBySeq.set(this.suppliersOf(call));
    }
    this.fetchMore(true);
    const sub = this.dbState.events$.subscribe((event) => {
      if (event.type === 'statements-appended' && call && event.callId === call.id) {
        if (event.lastSeq > this.lastSeq()) this.fetchMore(false);
        this.state.suppliersBySeq.set(this.suppliersOf(call));
      } else if (event.type === 'outside-appended' && !call && !this.hasMore()) {
        this.fetchMore(false);
      }
    });
    const reconnect = this.dbState.reconnected$.subscribe(() => this.fetchMore(false));
    this.destroyRef.onDestroy(() => {
      sub.unsubscribe();
      reconnect.unsubscribe();
    });
  }

  private suppliersOf(call: CallRecord): Map<number, CallRecord> {
    const map = new Map<number, CallRecord>();
    for (const c of this.calls?.calls() ?? []) {
      if (c.parentCallId === call.id && c.parentSeq != null) map.set(c.parentSeq, c);
    }
    return map;
  }

  private lastSeq(): number {
    const list = this.statements();
    return list.length ? list[list.length - 1].seq : 0;
  }

  private page(after: number): Observable<CallStatementsPage> {
    const r = this.request();
    return r.kind === 'call' ? this.api.statements(r.call.id, after, PAGE) : this.api.outside('', after, PAGE);
  }

  /** Next page (or, for an open call, whatever arrived since the last one). */
  fetchMore(first: boolean): void {
    if (this.fetching) return;
    this.fetching = true;
    const r = this.request();
    const after = first ? 0 : r.kind === 'call' ? this.lastSeq() : this.statements().length;
    const sub = this.page(after).subscribe({
      next: (page) => {
        this.fetching = false;
        this.loading.set(false);
        const known = new Set(this.statements().map((s) => s.id));
        const fresh = page.statements.filter((s) => !known.has(s.id));
        const merged = [...this.statements(), ...fresh];
        this.statements.set(r.kind === 'call' ? merged.sort((a, b) => a.seq - b.seq) : merged);
        if (page.transactions.length || first) this.transactions.set(page.transactions);
        if (page.supplierMarkers.length || first) this.markers.set(page.supplierMarkers);
        this.hasMore.set(page.hasMore);
        if (first) this.state.folded.set(initiallyFolded(this.tree()));
      },
      error: () => {
        this.fetching = false;
        this.loading.set(false);
        this.error.set('Could not load the statements.');
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  /** Every statement of the call - for Copy all SQL / Export .sql, which never cut anything off. */
  private allStatements(): Observable<readonly CapturedStatement[]> {
    if (!this.hasMore()) return new Observable((o) => { o.next(this.statements()); o.complete(); });
    const r = this.request();
    return this.page(r.kind === 'call' ? this.lastSeq() : this.statements().length).pipe(
      expand((p) => (p.hasMore && p.statements.length
        ? this.page(r.kind === 'call' ? p.statements[p.statements.length - 1].seq : this.statements().length)
        : EMPTY)),
      reduce((all, p) => [...all, ...p.statements], [...this.statements()]),
    );
  }

  onBodyScroll(event: Event): void {
    const body = event.target as HTMLElement;
    if (this.hasMore() && body.scrollTop + body.clientHeight > body.scrollHeight - 200) this.fetchMore(false);
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.closed.emit();
  }

  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  setKind(kind: DbKindFilter): void {
    this.state.kind.set(kind);
  }

  onSearch(event: Event): void {
    this.state.search.set((event.target as HTMLInputElement).value.trim());
  }

  expandAll(): void {
    this.state.folded.set(new Set());
    this.state.open.set(new Set(this.statements().map((s) => s.seq)));
  }

  collapseAll(): void {
    this.state.open.set(new Set());
    this.state.folded.set(initiallyFolded(this.tree()));
  }

  /** Flag / time-strip click: unfold, open and flash that statement. */
  jump(seq: number): void {
    this.state.search.set('');
    this.state.kind.set('all');
    this.state.table.set('');
    const folded = new Set(this.state.folded());
    pathTo(this.tree(), seq).forEach((k) => folded.delete(k));
    this.state.folded.set(folded);
    if (this.statements().some((s) => s.seq === seq)) this.state.open.set(new Set(this.state.open()).add(seq));
    this.state.flashSeq.set(seq);
    setTimeout(() => {
      this.host.nativeElement.querySelector(`[data-seq="${seq}"]`)?.scrollIntoView({ block: 'center' });
      setTimeout(() => this.state.flashSeq.set(null), 1400);
    });
  }

  jumpFlag(flag: DbFlag): void {
    if (flag.seqs.length) this.jump(flag.seqs[0]);
  }

  flagLabel(flag: DbFlag): string {
    return flagText(flag);
  }

  /** "show call ↗": close the window and flash the supplier call's card in the list. */
  showCall(call: CallRecord): void {
    this.close();
    setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-call-id="${CSS.escape(call.id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.remove('db-flash');
      void el.offsetWidth;
      el.classList.add('db-flash');
    });
  }

  copyAllSql(): void {
    this.allStatements().subscribe((all) => {
      void navigator.clipboard?.writeText(this.script(all)).then(() => this.note('Copied all SQL'));
    });
  }

  exportSql(): void {
    this.allStatements().subscribe((all) => {
      const blob = new Blob([this.script(all)], { type: 'application/sql' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `alfred-db-${this.call()?.id ?? 'outside'}.sql`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  private script(all: readonly CapturedStatement[]): string {
    const call = this.call();
    return buildSqlScript(all, call ? { method: call.method, url: call.url, callId: call.id, project: call.service_name, at: call.timestamp } : {});
  }

  private note(text: string): void {
    this.exportNote.set(text);
    setTimeout(() => this.exportNote.set(null), 1500);
  }

  protected readonly msText = msText;

  shortId(id: string): string {
    return id.length > 8 ? id.slice(0, 8) : id;
  }

  when(ts: string): string {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
  }
}
