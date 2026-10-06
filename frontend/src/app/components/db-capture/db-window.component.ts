import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, OnInit, computed, effect, inject, input, output, signal, untracked, viewChild,
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
import { DbFinding, DbOverview, buildOverview, fmtMs } from '../../shared/utils/db-findings';
import { buildSqlScript } from '../../shared/utils/sql-export-builder';
import {
  readDbPref, readGroupByQuery, readGroupByTransaction, readSummaryOpen, saveDbPref, saveGroupByQuery, saveGroupByTransaction, saveRowsAs, saveSummaryOpen,
} from '../../shared/utils/db-group-preference';
import { hasOrigins } from '../../shared/utils/db-origin';
import { QueryTotal, TimeBreakdown, queryTotals, timeBreakdown } from '../../shared/utils/db-analysis';
import { DbStatementListComponent } from './db-statement-list.component';
import { DbTimelineComponent } from './db-timeline.component';
import { DbFindingsComponent } from './db-findings.component';
import { DbDetailTab, DbKindFilter, DbWindowState } from './db-window-state';
import { DbWindowRequest, DbWindowService, DbWindowView } from './db-window.service';
import { DbLogLinesComponent } from './db-log-lines.component';
import { CallLogsApiService } from '../../core/services/call-logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { CallLogsPage, LinkedLogLine } from '../../core/models/call-logs.model';
import { TogetherRow, logRows, togetherRows } from '../../shared/utils/call-log-rows';
import { CallsApiService } from '../../core/services/calls-api.service';
import { CallFocusService } from '../../core/services/call-focus.service';

const PAGE = 500;
/** A call's log lines are read in pages of this many, at most {@link LOG_MAX} in all (the backend's per-call seatbelt). */
const LOG_PAGE = 500;
const LOG_MAX = 5000;
/** A burst of `lines-added` is one refetch. */
const LOG_REFETCH_MS = 1500;

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
/** Side by side by default from this browser-window width; the findings column and the statements' minimums. */
const SIDE_MIN_WIDTH = 1100;
const SIDE_MIN = 260;
const MAIN_MIN_WIDTH = 420;
const STACK_MIN = 60;
const MAIN_MIN_HEIGHT = 330;
const TIMELINE_MIN = 60;
/** On <html> while the window is open: the page behind it cannot scroll (styles/_db-capture.scss). */
const SCROLL_LOCK = 'db-window-open';

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
  imports: [DbStatementListComponent, DbTimelineComponent, DbFindingsComponent, DbLogLinesComponent],
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
  readonly view = signal<DbWindowView>('stmts');

  // ---- the call's log lines (specs/008-logs-call-link) ----
  private readonly callLogs = inject(CallLogsApiService);
  private readonly logsSocket = inject(LogsSocketService);
  /** The first page's answer: why there are no lines, how they were matched, the request thread. */
  readonly logInfo = signal<Omit<CallLogsPage, 'lines' | 'next'> | null>(null);
  readonly logLines = signal<readonly LinkedLogLine[]>([]);
  readonly logsLoading = signal(false);
  readonly logsError = signal<string | null>(null);
  private logRefetch: ReturnType<typeof setTimeout> | null = null;
  readonly logSources = computed(() => [...new Set(this.logLines().map((l) => l.sourceName))]);
  readonly logRowList = computed<TogetherRow[]>(() => logRows(this.logLines()));
  readonly togetherList = computed<TogetherRow[]>(() => {
    const call = this.call();
    if (!call) return [];
    return togetherRows(Date.parse(call.timestamp), this.statements(), this.markers(), this.state.suppliersBySeq(), this.logLines());
  });
  /** A call the agent recorded no statements for: the window is its log lines only (walkthrough "Call without DB capture"). */
  readonly logsOnly = computed(() => !!this.call() && !this.loading() && !this.statements().length && !this.error() && this.view() === 'logs');
  /** "open in Logs ↗" on the bar: the first line among its neighbours. */
  readonly firstLogLink = computed(() => {
    const l = this.logLines().find((x) => !x.kept);
    return l ? `/logs/${encodeURIComponent(l.sourceId)}?line=${encodeURIComponent(l.lineId)}` : null;
  });
  /** Lane ticks for the timeline: each line's offset from the call's start and level. */
  readonly logTicks = computed(() => this.logLines().map((l) => ({ atMs: l.offsetMs, level: l.level, message: l.message, key: `${l.sourceId}:${l.lineId}` })));
  /** Where the call's time went (db-analysis.ts) - from the loaded statements and the supplier calls they made. */
  readonly breakdown = computed<TimeBreakdown | null>(() => {
    const call = this.call();
    if (!call || !this.statements().length || !call.duration_ms) return null;
    return timeBreakdown(call, this.statements(), this.markers(), this.state.suppliersBySeq(), this.txCount());
  });
  /**
   * The summary line, the timeline and the findings (db-findings.ts) - from the loaded statements, the backend's flags
   * and the supplier calls. The panel under the line is closed by default; open or closed is remembered.
   */
  readonly overview = computed<DbOverview | null>(() => {
    const call = this.call();
    if (!call || !this.statements().length) return null;
    return buildOverview(call, this.statements(), this.markers(), this.state.suppliersBySeq(), this.flags());
  });
  /** The findings pane unfolded - its own header folds it (to a rail beside the statements); remembered. */
  readonly panelOpen = signal(readSummaryOpen());
  /**
   * Findings beside the statements (side) or above them (stack) - side by default on a wide screen, the choice
   * remembered; the size of the findings part dragged and remembered too. Stacked, the statements (with their tools) keep 330 px.
   */
  readonly layout = signal<'side' | 'stack'>(readDbPref('layout', '') === 'stack' || (readDbPref('layout', '') === '' && window.innerWidth < SIDE_MIN_WIDTH) ? 'stack' : 'side');
  readonly sideWidth = signal(Number(readDbPref('sideWidth', '330')) || 330);
  readonly stackShare = signal(Number(readDbPref('stackShare', '0.4')) || 0.4);
  /** Closed by default like the summary line; open or closed and its dragged height remembered (null = its full height). */
  readonly timelineHidden = signal(readDbPref('timelineHidden', '1') === '1');
  readonly timelineHeight = signal<number | null>(Number(readDbPref('timelineHeight', '0')) || null);
  readonly draggingTimeline = signal(false);
  /** The timeline as thin lanes (default) or labelled rows; remembered. */
  readonly timelineMode = signal<'strip' | 'detail'>(readDbPref('timelineMode', 'strip') === 'detail' ? 'detail' : 'strip');
  /** The statements toolbar's "View" menu: the display choices that used to take three rows. */
  readonly viewMenu = signal(false);

  setTimelineMode(mode: 'strip' | 'detail'): void {
    this.timelineMode.set(mode);
    saveDbPref('timelineMode', mode);
    this.timelineHeight.set(null); // a height dragged for one mode is wrong for the other
    saveDbPref('timelineHeight', '0');
  }

  /** A click outside the View menu closes it. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.viewMenu() && !(event.target as HTMLElement | null)?.closest('.dbw-viewwrap')) this.viewMenu.set(false);
  }
  /** Full window: the window fills the browser window. Remembered; Esc or F leaves it. */
  readonly full = signal(readDbPref('full', '0') === '1');
  readonly dragging = signal(false);
  private readonly split = viewChild<ElementRef<HTMLElement>>('split');

  setLayout(layout: 'side' | 'stack'): void {
    this.layout.set(layout);
    saveDbPref('layout', layout);
  }

  toggleTimeline(): void {
    this.timelineHidden.set(!this.timelineHidden());
    saveDbPref('timelineHidden', this.timelineHidden() ? '1' : '0');
  }

  /** Dragging the bar under the timeline: its height (it scrolls inside below its content's). */
  startTimelineResize(event: MouseEvent): void {
    const tl = this.host.nativeElement.querySelector('.dbw-tl') as HTMLElement | null;
    if (!tl) return;
    event.preventDefault();
    const start = event.clientY;
    const startHeight = tl.offsetHeight;
    // up to its full content, and never so tall the statements lose their 330 px
    const card = this.host.nativeElement.querySelector('.db-window') as HTMLElement;
    const head = this.host.nativeElement.querySelector('.dbw-head') as HTMLElement;
    const content = Math.min(tl.scrollHeight, card.clientHeight - head.offsetHeight - MAIN_MIN_HEIGHT);
    this.draggingTimeline.set(true);
    const move = (e: MouseEvent) => this.timelineHeight.set(Math.round(Math.max(TIMELINE_MIN, Math.min(content, startHeight + e.clientY - start))));
    const up = () => {
      this.draggingTimeline.set(false);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveDbPref('timelineHeight', String(this.timelineHeight() ?? 0));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  resetTimelineHeight(): void {
    this.timelineHeight.set(null);
    saveDbPref('timelineHeight', '0');
  }

  setFull(full: boolean): void {
    this.full.set(full);
    saveDbPref('full', full ? '1' : '0');
  }

  /** Dragging the bar between the findings and the statements. */
  startResize(event: MouseEvent): void {
    const split = this.split()?.nativeElement;
    const pane = split?.querySelector<HTMLElement>('.dbw-fpane');
    if (!split || !pane) return;
    event.preventDefault();
    const side = this.layout() === 'side';
    const start = side ? event.clientX : event.clientY;
    const startSize = side ? pane.offsetWidth : pane.offsetHeight;
    this.dragging.set(true);
    const move = (e: MouseEvent) => {
      const size = startSize + (side ? e.clientX : e.clientY) - start;
      if (side) this.sideWidth.set(Math.round(Math.max(SIDE_MIN, Math.min(split.clientWidth - MAIN_MIN_WIDTH, size))));
      else this.stackShare.set(Math.max(STACK_MIN, Math.min(split.clientHeight - MAIN_MIN_HEIGHT, size)) / split.clientHeight);
    };
    const up = () => {
      this.dragging.set(false);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveDbPref('sideWidth', String(this.sideWidth()));
      saveDbPref('stackShare', this.stackShare().toFixed(3));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  /** F toggles full window - not while typing, and not while the window is put aside. */
  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey || this.windows.aside()) return;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    this.setFull(!this.full());
  }
  /** Timeline items a hovered finding or chip lights up. */
  readonly highlight = signal<ReadonlySet<string> | null>(null);
  /** The finding whose statements "Show" narrowed the list to. */
  readonly findingFilter = signal<DbFinding | null>(null);
  protected readonly fmt = fmtMs;

  /** The findings pane's own header folds it; the summary line opens the timeline instead. */
  togglePanel(): void {
    this.panelOpen.set(!this.panelOpen());
    saveSummaryOpen(this.panelOpen());
    this.highlight.set(null);
  }

  showFinding(f: DbFinding): void {
    this.clearStatementSql();
    this.queryFilter.set(null);
    this.findingFilter.set(f);
    this.state.statementSeqs.set(new Set(f.seqs));
    this.view.set('stmts');
  }

  clearFindingFilter(): void {
    this.findingFilter.set(null);
    this.state.statementSeqs.set(null);
  }

  /** "Mark expected": every query shape of the finding stops being flagged for this project. */
  markExpected(f: DbFinding): void {
    const project = this.state.project();
    if (!project) return;
    for (const fingerprint of f.fingerprints) this.api.markExpected(project, fingerprint).subscribe({ error: () => undefined });
  }

  /** "Top queries": one row per statement shape, costliest first. */
  readonly queries = computed<QueryTotal[]>(() => queryTotals(this.statements()));
  /** The query a "Top queries" click narrowed the list to. */
  readonly queryFilter = signal<QueryTotal | null>(null);
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

  constructor() {
    // ▤ turned on or off (here or in the Sources bar) while the window is open: the lines follow.
    let logsWereOn: boolean | null = null;
    effect(() => {
      const project = this.state.project();
      const on = project ? !!this.dbState.projectStatus(project)?.logsOn : null;
      untracked(() => {
        const call = this.call();
        if (on !== null && logsWereOn !== null && on !== logsWereOn && call) this.loadLogs(call);
        logsWereOn = on;
      });
    });
    // While the window is up the page behind it does not scroll; put aside ("show call"), the page is the point again.
    effect(() => {
      document.documentElement.classList.toggle(SCROLL_LOCK, !this.windows.aside());
    });
    this.destroyRef.onDestroy(() => document.documentElement.classList.remove(SCROLL_LOCK));
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

  /** "Class.method(File.java:12)" → "Class.method:12" - enough to recognise it on one line; the tooltip has the rest. */
  shortFrame(frame: string): string {
    return frame.replace(/\([^:()]*:(\d+)\)$/, ':$1');
  }

  /** "Top queries" → the Statements tab, showing every execution of that query. */
  filterQuery(q: QueryTotal): void {
    this.clearStatementSql();
    this.findingFilter.set(null);
    this.queryFilter.set(q);
    this.state.statementSeqs.set(new Set(q.seqs));
    this.view.set('stmts');
  }

  clearQueryFilter(): void {
    this.queryFilter.set(null);
    this.state.statementSeqs.set(null);
  }

  setView(view: DbWindowView): void {
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
    if (request.kind === 'call' && request.view) this.view.set(request.view);
    if (call) {
      this.loadLogs(call);
      this.logsSocket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
        if (e.type === 'lines-added' && e.count > 0 && this.mayHaveNewLines(call, e.newestTs)) this.scheduleLogRefetch(call);
      });
      this.logsSocket.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.loadLogs(call));
      this.destroyRef.onDestroy(() => this.logRefetch && clearTimeout(this.logRefetch));
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

  /** Every page of the call's linked lines (oldest first), replacing what is shown once all have arrived. */
  private loadLogs(call: CallRecord): void {
    const request = this.request();
    const cycleId = request.kind === 'call' ? request.cycleId ?? null : null;
    this.logsLoading.set(true);
    this.callLogs.lines(call.id, { cycleId, limit: LOG_PAGE }).pipe(
      expand((p) => (p.next && p.lines.length ? this.callLogs.lines(call.id, { cycleId, after: p.next, limit: LOG_PAGE }) : EMPTY)),
      reduce((acc, p) => ({ first: acc.first ?? p, lines: acc.lines.length >= LOG_MAX ? acc.lines : [...acc.lines, ...p.lines] }),
        { first: null as CallLogsPage | null, lines: [] as LinkedLogLine[] }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: ({ first, lines }) => {
        if (first) {
          const { lines: _l, next: _n, ...info } = first;
          this.logInfo.set(info);
        }
        this.logLines.set(lines.slice(0, LOG_MAX));
        this.logsLoading.set(false);
        this.logsError.set(null);
      },
      error: () => {
        this.logsLoading.set(false);
        this.logsError.set('Could not load the log lines.');
      },
    });
  }

  /** New lines can belong to this call only if they are not older than its start (minus the clock difference). */
  private mayHaveNewLines(call: CallRecord, newestTs: number): boolean {
    const info = this.logInfo();
    if (info && info.setup !== 'OK') return false;
    return newestTs >= Date.parse(call.timestamp) - (info?.clockSkewMs ?? 0);
  }

  private scheduleLogRefetch(call: CallRecord): void {
    if (this.logRefetch) return;
    this.logRefetch = setTimeout(() => {
      this.logRefetch = null;
      this.loadLogs(call);
    }, LOG_REFETCH_MS);
  }

  /** The ▤ switch, from the window's own "Alfred is not reading these logs" note. */
  turnLogsOn(): void {
    const project = this.state.project();
    if (!project) return;
    this.dbState.setLogsOn(project, true); // the switch's change reloads the lines (constructor)
  }

  logsWhy(): string {
    switch (this.logInfo()?.setup) {
      case 'LINKING_OFF': return 'off';
      case 'NO_SOURCE': return 'nosource';
      case 'NO_THREAD': return 'nothread';
      default: return 'none';
    }
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
    if (this.windows.aside()) return;
    // the first Esc leaves full window, the next one closes
    if (this.full()) this.setFull(false);
    else this.close();
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

  /** Timeline / finding / trace click: clear filters, unfold its groups, open it on the right tab and flash it. */
  jump(seq: number, tab?: DbDetailTab): void {
    this.view.set('stmts');
    this.state.search.set('');
    this.state.kind.set('all');
    this.state.table.set('');
    this.state.statementSeqs.set(null);
    this.findingFilter.set(null);
    this.queryFilter.set(null);
    const folded = new Set(this.state.folded());
    pathTo(this.tree(), seq).forEach((k) => folded.delete(k));
    this.state.folded.set(folded);
    if (this.statements().some((s) => s.seq === seq)) {
      this.state.open.set(new Set(this.state.open()).add(seq));
      if (tab) this.state.setTab(seq, tab);
    }
    this.flash(`[data-seq="${seq}"]`, seq);
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
