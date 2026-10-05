import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, computed, effect, inject, input, output, signal, untracked,
} from '@angular/core';
import { EMPTY, Observable, catchError, expand, forkJoin, map, of, reduce } from 'rxjs';
import { CallRecord } from '../../core/models/call.model';
import {
  CallStatementsPage, CapturedStatement, DbFlag, RecordedQueryResult, StatementTransaction, SupplierMarker, TableSummary,
} from '../../core/models/db-capture.model';
import { QueryExample, STATEMENT_QUERY_COLUMNS, statementQueryExamples } from '../../shared/utils/db-row-query-examples';
import { DbTraceLocation, supplierBodyHits, traceLocations } from '../../shared/utils/db-trace';
import { DbNode } from '../../shared/utils/db-statement-tree';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { CallsStateService } from '../../core/state/calls-state.service';
import { buildStatementTree, initiallyFolded, pathTo } from '../../shared/utils/db-statement-tree';
import { isDelete, isFailed, isWrite, msText } from '../../shared/utils/db-statement-display';
import { flagTarget, flagText } from '../../shared/utils/db-flags';
import { buildSqlScript } from '../../shared/utils/sql-export-builder';
import {
  readGroupByQuery, readGroupByTransaction, saveGroupByQuery, saveGroupByTransaction, saveRowsAs,
} from '../../shared/utils/db-group-preference';
import { hasOrigins } from '../../shared/utils/db-origin';
import { DbStatementListComponent } from './db-statement-list.component';
import { DbDetailTab, DbKindFilter, DbWindowState } from './db-window-state';
import { DbWindowRequest, DbWindowService } from './db-window.service';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';

const PAGE = 500;

/** "host/…/last-segment" - enough to tell supplier calls apart on the Back button. */
function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return `${u.host}/…/${last}`;
  } catch {
    return url;
  }
}
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
  private readonly callsApi = inject(CallsApiService);
  private readonly focus = inject(CallFocusService);
  private readonly windows = inject(DbWindowService);
  /** The call's supplier calls fetched by their parent link - so a row is never "not loaded" because the list is
   *  filtered or paged past it. */
  private readonly children = signal<readonly CallRecord[]>([]);
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

  /** Statements | Tables (mock: the views row). */
  readonly view = signal<'stmts' | 'tables'>('stmts');
  readonly tableSummaries = signal<readonly TableSummary[] | null>(null);

  /** The Search/SQL toggle over statements, and the last SQL result (null = showing all statements). */
  readonly searchMode = signal<'search' | 'sql'>('search');
  readonly statementSql = signal('');
  readonly sqlResult = signal<RecordedQueryResult | null>(null);
  readonly sqlOrdered = signal(false);
  readonly statementColumns = STATEMENT_QUERY_COLUMNS.join(', ');

  /** Every place the traced value appears, in run order (statements from the server, supplier bodies from here). */
  readonly traceHits = signal<readonly DbTraceLocation[]>([]);

  readonly call = computed<CallRecord | null>(() => {
    const r = this.request();
    return r.kind === 'call' ? r.call : null;
  });
  readonly summary = computed(() => {
    const c = this.call();
    return c ? this.dbState.summaries().get(c.id) ?? null : null;
  });
  readonly flags = computed<readonly DbFlag[]>(() => this.summary()?.flags ?? []);

  /**
   * "Group by transaction" (on by default, remembered per browser): off shows the statements as one plain list in run
   * order - no transaction or repeated-query groups, supplier calls still in place.
   */
  readonly grouped = signal(readGroupByTransaction());
  /** "Group by query": the several SQL statements one HQL query produced, under that query. Shown only with origins. */
  readonly groupedByQuery = signal(readGroupByQuery());
  readonly hasOrigins = computed(() => hasOrigins(this.statements()));
  readonly tree = computed(() => {
    const byQuery = this.groupedByQuery() && this.hasOrigins();
    return this.grouped()
      ? buildStatementTree(this.statements(), this.markers(), this.transactions(), DEFAULT_REPEAT_THRESHOLD, byQuery)
      : buildStatementTree(this.statements(), this.markers(), [], Number.MAX_SAFE_INTEGER, byQuery);
  });

  setGroupedByQuery(grouped: boolean): void {
    this.groupedByQuery.set(grouped);
    saveGroupByQuery(grouped);
  }

  setRowsAs(rowsAs: 'hql' | 'sql'): void {
    this.state.rowsAs.set(rowsAs);
    saveRowsAs(rowsAs);
  }

  setGrouped(grouped: boolean): void {
    this.grouped.set(grouped);
    if (grouped) this.state.folded.set(initiallyFolded(this.tree()));
    saveGroupByTransaction(grouped);
  }
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

  readonly tableCount = computed(() => this.tableSummaries()?.length ?? new Set(this.statements().filter((s) => s.table).map((s) => s.table)).size);

  readonly statementExamples = computed<QueryExample[]>(() => {
    const all = this.statements();
    const write = all.find((s) => ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(s.kind) && s.table)?.table ?? null;
    const tx = all.find((s) => s.txId)?.txId ?? null;
    const code = all.find((s) => s.codeLocation)?.codeLocation?.split('.')[0] ?? null;
    return statementQueryExamples(write, tx, code);
  });

  /** ORDER BY in the query: the statements in its order, flat (the tree's order is run order). */
  readonly orderedNodes = computed<DbNode[]>(() => {
    const seqs = this.sqlResult()?.statementSeqs;
    if (!this.sqlOrdered() || !seqs) return [];
    const bySeq = new Map(this.statements().map((s) => [s.seq, s]));
    return seqs.map((seq) => bySeq.get(seq)).filter((s): s is CapturedStatement => !!s).map((s) => ({ type: 'stmt' as const, seq: s.seq, statement: s }));
  });

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

  constructor() {
    // A clicked value is traced through the whole call - the server knows every statement and stored row; the
    // supplier calls' bodies are searched here.
    effect(() => {
      const value = this.state.trace();
      untracked(() => this.runTrace(value));
    });
    effect(() => {
      const request = this.state.jumpRequest();
      if (request) untracked(() => {
        this.state.jumpRequest.set(null);
        this.jump(request.seq, request.tab);
      });
    });
    effect(() => {
      const all = this.statements();
      untracked(() => {
        this.state.statementBySeq.set(new Map(all.map((s) => [s.seq, s])));
        this.state.hasOrigins.set(hasOrigins(all));
      });
    });
  }

  private runTrace(value: string): void {
    const call = this.call();
    if (!value || !call) {
      this.traceHits.set([]);
      return;
    }
    const suppliers = [...this.state.suppliersBySeq().entries()];
    const bodies$ = suppliers.length && this.calls
      ? forkJoin(suppliers.map(([seq, sup]) => this.calls!.getCallDetail(sup.id, sup.source).pipe(
        map((d) => ({ seq, request: d.request?.body ?? '', response: d.response?.body ?? '' })),
        catchError(() => of({ seq, request: '', response: '' })))))
      : of([] as { seq: number; request: string; response: string }[]);
    forkJoin({ hits: this.api.trace(call.id, value).pipe(map((r) => r.hits), catchError(() => of([]))), bodies: bodies$ }).subscribe(({ hits, bodies }) => {
      if (this.state.trace() !== value) return;
      this.traceHits.set([...traceLocations(hits, this.statements()), ...supplierBodyHits(bodies, value)].sort((a, b) => a.seq - b.seq));
    });
  }

  goTo(location: DbTraceLocation): void {
    this.jump(location.seq, location.tab);
  }

  setView(view: 'stmts' | 'tables'): void {
    this.view.set(view);
    const call = this.call();
    if (view === 'tables' && call && !this.tableSummaries()) {
      this.api.tables(call.id).subscribe({ next: (t) => this.tableSummaries.set(t), error: () => this.tableSummaries.set([]) });
    }
  }

  filterTable(table: string): void {
    this.state.table.set(table.replace(/ \(procedure\)$/, ''));
    this.view.set('stmts');
  }

  setSearchMode(mode: 'search' | 'sql'): void {
    this.searchMode.set(mode);
    if (mode === 'search') this.clearStatementSql();
  }

  onStatementSqlKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.runStatementSql();
    }
  }

  runStatementSql(sql = this.statementSql()): void {
    const call = this.call();
    this.statementSql.set(sql);
    if (!call || !sql.trim()) {
      this.clearStatementSql();
      return;
    }
    // Every statement must be loaded for the tree to show what the query selected.
    this.allStatements().subscribe((all) => {
      if (all.length > this.statements().length) {
        this.statements.set(all);
        this.hasMore.set(false);
      }
      this.api.queryStatements(call.id, { mode: 'sql', text: sql, offset: 0, limit: 1000 }).subscribe((result) => {
        this.sqlResult.set(result);
        this.sqlOrdered.set(/\bORDER\s+BY\b/i.test(sql) && !!result.statementSeqs);
        this.state.statementSeqs.set(!result.error && result.statementSeqs ? new Set(result.statementSeqs) : null);
      });
    });
  }

  clearStatementSql(): void {
    this.statementSql.set('');
    this.sqlResult.set(null);
    this.sqlOrdered.set(false);
    this.state.statementSeqs.set(null);
  }

  ngOnInit(): void {
    const call = this.call();
    const request = this.request();
    this.state.project.set(call?.service_name ?? (request.kind === 'outside' ? request.project ?? null : null));
    if (call) {
      this.dbState.requestSummary(call.id);
      this.state.suppliersBySeq.set(this.suppliersOf(call));
      this.loadChildren(call);
    }
    this.fetchMore(true);
    const sub = this.dbState.events$.subscribe((event) => {
      if (event.type === 'statements-appended' && call && event.callId === call.id) {
        if (event.lastSeq > this.lastSeq()) this.fetchMore(false);
        this.state.suppliersBySeq.set(this.suppliersOf(call));
        this.loadChildren(call);
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
    for (const c of this.children()) {
      if (c.parentSeq != null) map.set(c.parentSeq, c);
    }
    // The list's copy wins: it is the live one (a call still in progress updates there first).
    for (const c of this.calls?.calls() ?? []) {
      if (c.parentCallId === call.id && c.parentSeq != null) map.set(c.parentSeq, c);
    }
    return map;
  }

  private loadChildren(call: CallRecord): void {
    this.callsApi.getChildren(call.id).subscribe({
      next: (list) => {
        this.children.set(list);
        this.state.suppliersBySeq.set(this.suppliersOf(call));
      },
      error: () => undefined,
    });
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

  /** Escape closes the window - not while it is put aside, when the key belongs to the page under it. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.windows.aside()) this.close();
  }

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

  /** Flag / time-strip / trace click: clear filters, unfold its groups, open it on the right tab and flash it. */
  jump(seq: number, tab?: DbDetailTab): void {
    this.state.search.set('');
    this.state.kind.set('all');
    this.state.table.set('');
    this.state.statementSeqs.set(null);
    const folded = new Set(this.state.folded());
    pathTo(this.tree(), seq).forEach((k) => folded.delete(k));
    this.state.folded.set(folded);
    if (this.statements().some((s) => s.seq === seq)) {
      this.state.open.set(new Set(this.state.open()).add(seq));
      if (tab) this.state.setTab(seq, tab);
    }
    this.flash(`[data-seq="${seq}"]`, seq);
  }

  private jumpGroup(txId: string): void {
    const key = `tx:${txId}`;
    const folded = new Set(this.state.folded());
    folded.delete(key);
    this.state.folded.set(folded);
    this.flash(`[data-group="${CSS.escape(key)}"]`, null);
  }

  private flash(selector: string, seq: number | null): void {
    this.state.flashSeq.set(seq);
    setTimeout(() => {
      const el = this.host.nativeElement.querySelector(selector) as HTMLElement | null;
      el?.scrollIntoView({ block: 'center' });
      if (seq == null && el) {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }
      setTimeout(() => this.state.flashSeq.set(null), 1400);
    });
  }

  jumpFlag(flag: DbFlag): void {
    const target = flagTarget(flag);
    if (!target) return;
    if (target.groupTxId) this.jumpGroup(target.groupTxId);
    else this.jump(target.seq, target.tab);
  }

  flagLabel(flag: DbFlag): string {
    return flagText(flag);
  }

  /**
   * "show call ↗": put the window aside (kept as it is - "◆ Back to database" brings it back) and point at the
   * supplier call in the list - its waterfall row or its card - with an outline and a "◆ #n · from database" label
   * that stays until the next click. A call the page is not showing (filtered out, paged past, another page) is
   * opened through CallFocusService, which shows Live Calls filtered to it.
   */
  showCall(call: CallRecord): void {
    const seq = call.parentSeq ?? null;
    this.windows.putAside(`#${seq ?? ''} ${call.method} ${shortUrl(call.url)}`);
    const find = () => {
      const id = CSS.escape(call.id);
      return document.querySelector<HTMLElement>(`[data-call-row="${id}"]`) ?? document.querySelector<HTMLElement>(`[data-call-id="${id}"]`);
    };
    if (!find()) this.focus.go({ callId: call.id, cycleId: null, direction: 'outbound', serviceName: null });
    // The page may still be routing / rendering the call: look for it for a few seconds.
    let tries = 0;
    const mark = () => {
      const el = find();
      if (!el) {
        if (++tries < 30) setTimeout(mark, 100);
        return;
      }
      document.querySelectorAll('.db-target').forEach((old) => old.classList.remove('db-target'));
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.setAttribute('data-db-mark', `◆ #${seq ?? ''} · from database`);
      el.classList.add('db-target');
      const clear = () => el.classList.remove('db-target');
      setTimeout(() => document.addEventListener('click', clear, { once: true, capture: true }), 0);
      setTimeout(clear, 15000);
    };
    setTimeout(mark);
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
