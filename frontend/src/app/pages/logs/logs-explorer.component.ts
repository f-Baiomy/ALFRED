import { Component, DestroyRef, ElementRef, HostListener, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LogsApiService } from '../../core/services/logs-api.service';
import { LogsSocketService } from '../../core/services/logs-socket.service';
import { RedactionsApiService } from '../../core/services/redactions-api.service';
import {
  ExplorerView,
  FieldDef,
  FieldStats,
  FieldValues,
  GroupNode,
  GroupSort,
  Histogram,
  LineStructure,
  LineStructures,
  LogComment,
  LogLine,
  LogLineSummary,
  LogPage,
  LogQuery,
  LogStructure,
  Minimap,
  Pattern,
  Pill,
  SavedView,
  SessionMarker,
  SessionView,
  SourceView,
  STRUCTURE_FIELD,
} from '../../core/models/logs.model';
import { LogLineDataComponent, FieldAction } from '../../components/logs/log-line-data.component';
import { highlightSegments, parseQuery, pillClass, pillText, samePill } from '../../shared/utils/logs-query-parse';
import { summaryOrFields } from '../../shared/utils/logs-template';
import { buildPathTree, itemsUnder, TreeNode, TreeRow, visibleRows } from '../../shared/utils/logs-field-tree';

interface CompareRow {
  readonly k: string;
  readonly x: string | null;
  readonly y: string | null;
  readonly differs: boolean;
}
import { formatDuration, formatLogDateTime, formatLogTime, utcHint } from '../../shared/utils/logs-time';
import { EMPTY_SELECTION, Selection, headerState, hiddenCount, selectAll, selectRange, toggle } from '../../shared/utils/logs-selection';
import { buildLogsExport, LogsExportFormat } from '../../shared/utils/logs-export';
import { downloadText } from '../../shared/utils/download';
import { copyToClipboard } from '../../shared/utils/clipboard';

/** Live loads refresh the list every second but the whole-result aggregates at most this often. */
const AGGREGATE_EVERY_MS = 15_000;
/** A burst of live lines is shown after this short gathering delay (one-shot, not polling). */
const LIVE_REFRESH_MS = 150;
const PAGE = 200;
const MAX_FETCH_FOR_EXPORT = 5000;
const MINIMAP_BUCKETS = 200;
const GROUP_PAGE = 200;
/** Lines the backend ships inside one group node (SqliteLogLineStoreAdapter.NODE_LINES); beyond it, page. */
const NODE_LINES = 1000;
const HOUR = 3_600_000;
const RANGES: Record<string, number | null> = { all: null, '1h': HOUR, '6h': 6 * HOUR, '24h': 24 * HOUR, '7d': 168 * HOUR };
const CORR_COLORS = ['#a78bfa', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#60a5fa', '#e879f9', '#4ade80', '#f87171'];

type DrawerTab = 'fields' | 'raw' | 'context' | 'trace' | 'comments';

interface AcItem {
  readonly insert: string;
  readonly show: string;
  readonly note: string;
}

/**
 * The explorer (FR-017..042; mock.html `renderExplorer()` and everything it calls). All data is
 * fetched on demand; /ws/logs only says "something changed" (FR-036, no polling).
 */
@Component({
  selector: 'app-logs-explorer',
  standalone: true,
  imports: [RouterLink, DecimalPipe, FormsModule, NgTemplateOutlet, LogLineDataComponent],
  templateUrl: './logs-explorer.component.html',
})
export class LogsExplorerComponent implements OnInit {
  private readonly api = inject(LogsApiService);
  private readonly socket = inject(LogsSocketService);
  private readonly redactionsApi = inject(RedactionsApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly id = this.route.snapshot.paramMap.get('id') ?? '';
  /** /logs/:id?session=<id>: the explorer shows one recorded session. */
  private readonly sessionParam = this.route.snapshot.queryParamMap.get('session');

  // ---- live reading and session recordings
  readonly liveRate = signal(0);
  private rateWindow: { t: number; n: number }[] = [];
  readonly lastLineAt = signal<number | null>(null);
  /** Files read live right now (followed files and the live files of watched folders). */
  readonly followedFiles = computed(() => (this.view$()?.inputs ?? []).filter((i) => i.status === 'FOLLOWING' && i.kind !== 'WATCH').length);
  readonly recording = signal<SessionView | null>(null);
  readonly recOpen = signal(false);
  readonly recKind = signal<'WINDOW' | 'ID'>('WINDOW');
  readonly recName = signal('');
  readonly recUseFilter = signal(false);
  readonly recIdField = signal('');
  readonly recIdValue = signal('');
  readonly recError = signal('');
  readonly markerText = signal<string | null>(null);
  readonly clock = signal(Date.now());
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  readonly openSession = signal<SessionView | null>(null);
  /** ID fields a session can follow: correlation roles and grouping levels first, then the rest. */
  readonly idFields = computed(() => {
    const first = new Set([...(this.roleLabels()['CORRELATION'] ?? []), ...this.levelLabels()]);
    return [...first, ...this.fields().map((f) => f.label).filter((l) => !first.has(l))];
  });
  readonly recElapsed = computed(() => {
    const r = this.recording();
    if (!r) return '';
    const s = Math.max(0, Math.round((this.clock() - r.session.startedAt) / 1000));
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  });
  /** The list with an open session's markers placed between the lines at their time. */
  readonly displayRows = computed<({ kind: 'row'; r: LogLineSummary } | { kind: 'marker'; m: SessionMarker })[]>(() => {
    const rows = this.rows();
    const markers = [...(this.openSession()?.session.markers ?? [])];
    if (!markers.length) return rows.map((r) => ({ kind: 'row' as const, r }));
    const asc = false; // the list is newest first
    markers.sort((a, b) => (asc ? a.ts - b.ts : b.ts - a.ts));
    const out: ({ kind: 'row'; r: LogLineSummary } | { kind: 'marker'; m: SessionMarker })[] = [];
    let k = 0;
    for (const r of rows) {
      while (k < markers.length && (asc ? markers[k].ts <= r.ts : markers[k].ts >= r.ts)) out.push({ kind: 'marker', m: markers[k++] });
      out.push({ kind: 'row', r });
    }
    if (!this.cursor()) while (k < markers.length) out.push({ kind: 'marker', m: markers[k++] });
    return out;
  });

  private readonly listEl = viewChild<ElementRef<HTMLElement>>('list');
  private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('qin');

  // ---- source
  readonly view$ = signal<SourceView | null>(null);
  readonly structure = signal<LogStructure | null>(null);
  readonly savedViews = signal<SavedView[]>([]);
  readonly error = signal('');
  readonly rebuilding = signal('');

  // ---- query
  readonly pills = signal<Pill[]>([]);
  readonly range = signal<string>(this.storedRange());
  readonly customRange = signal<{ from: number; to: number } | null>(null);
  readonly newestTs = signal<number | null>(null);
  readonly qtext = signal('');
  readonly ac = signal<AcItem[]>([]);
  readonly acIdx = signal(0);

  // ---- results
  readonly mode = signal<ExplorerView>('lines');
  readonly dataView = signal<'TABLE' | 'JSON'>('TABLE');
  readonly rows = signal<LogLineSummary[]>([]);
  readonly cursor = signal<string | null>(null);
  readonly total = signal(0);
  readonly tookMs = signal(0);
  readonly slow = signal(false);
  readonly loading = signal(false);
  readonly histogram = signal<Histogram | null>(null);
  readonly values = signal<FieldValues | null>(null);
  /** Structures among the lines (each line may have its own) with how many match the current search. */
  readonly lineStructures = signal<LineStructures | null>(null);
  /** Hide fields the current results do not have (OpenSearch Discover's "hide missing fields"). */
  readonly hideMissing = signal(true);
  readonly minimap = signal<Minimap | null>(null);
  readonly minimapCond = signal<string>('');
  readonly newCount = signal(0);
  readonly live = signal(true);
  readonly drag = signal<{ a: number; b: number } | null>(null);

  // ---- per line
  readonly openData = signal<ReadonlySet<string>>(new Set());
  readonly full = signal<ReadonlyMap<string, LogLine>>(new Map());
  readonly comments = signal<ReadonlyMap<string, readonly LogComment[]>>(new Map());
  readonly sel = signal<Selection>(EMPTY_SELECTION);
  readonly current = signal<string | null>(null);

  // ---- drawer
  readonly drawer = signal<string | null>(null);
  readonly dtab = signal<DrawerTab>('fields');
  readonly contextRows = signal<LogLineSummary[]>([]);
  readonly traceRows = signal<LogLineSummary[]>([]);
  readonly drawerError = signal('');

  // ---- grouped / patterns
  readonly roots = signal<GroupNode[]>([]);
  readonly kids = signal<ReadonlyMap<string, GroupNode[]>>(new Map());
  readonly openKids = signal<ReadonlySet<string>>(new Set());
  readonly rootsMore = signal(false);
  readonly kidsMore = signal<ReadonlySet<string>>(new Set());
  /** A node's own lines / level-skipping lines once "show all" was used (beyond the first page in the node). */
  readonly nodeOwn = signal<ReadonlyMap<string, { lines: LogLineSummary[]; cursor: string | null }>>(new Map());
  readonly nodeSkip = signal<ReadonlyMap<string, { lines: LogLineSummary[]; cursor: string | null }>>(new Map());
  readonly bucket = signal<LogLineSummary[]>([]);
  readonly bucketCursor = signal<string | null>(null);
  readonly bucketTotal = signal(0);
  readonly bucketOpen = signal(false);
  readonly patterns = signal<Pattern[]>([]);
  readonly patternOpen = signal<ReadonlyMap<number, { lines: LogLineSummary[]; cursor: string | null }>>(new Map());

  // ---- popovers & dialogs
  readonly stats = signal<{ label: string; data: FieldStats | null; top: number; left: number; breakdown?: { value: string; count: number }[] } | null>(null);
  readonly compare = signal<{ a: LogLine; b: LogLine; onlyDiff: boolean } | null>(null);
  readonly bulkMsg = signal('');
  readonly bulkComment = signal<string | null>(null);
  readonly saveViewName = signal<string | null>(null);

  readonly fields = computed(() => (this.structure()?.fields ?? []).filter((f) => !f.duplicateOf));
  readonly labels = computed(() => new Set(this.fields().map((f) => f.label)));
  /** What the search box understands: every field, plus `structure` (S1, S2, ...) unless a real field has that name. */
  readonly queryLabels = computed(() => new Set([...this.labels(), STRUCTURE_FIELD]));
  readonly structures = computed(() => this.lineStructures()?.structures ?? []);
  readonly structureById = computed(() => new Map(this.structures().map((s) => [s.id, s])));
  /** Fields listed in the sidebar: with "hide missing" on, only those the latest matches have. */
  readonly sideFields = computed(() => {
    const v = this.values();
    if (!this.hideMissing() || !v || !v.sampled) return this.fields();
    return this.fields().filter((f) => (v.fields[f.label]?.presence ?? 0) > 0 || this.columns().includes(f.label));
  });
  readonly hiddenFieldCount = computed(() => this.fields().length - this.sideFields().length);
  readonly columns = computed(() => this.structure()?.columns ?? []);
  readonly levelLabels = computed(() => (this.structure()?.groupLevels ?? []).map((l) => l.fieldLabel));
  readonly zone = computed(() => this.structure()?.timeZone ?? 'UTC');
  readonly masked = computed(() => this.view$()?.source.privacyMode === 'MASK');
  /** Labels hidden in list rows under privacy MASK (FR-043); the data panel has its own per-view reveal. */
  readonly maskedLabels = computed(() => new Set(this.masked() ? (this.structure()?.fields ?? []).filter((f) => f.sensitive).map((f) => f.label) : []));
  /** Role -> its fields in the order a line tries them (a role may sit on several fields). */
  readonly roleLabels = computed(() => {
    const m: Partial<Record<string, string[]>> = {};
    const ranked = this.fields().filter((f) => f.role).sort((a, b) => (a.roleRank || 1e9) - (b.roleRank || 1e9) || a.index - b.index);
    for (const f of ranked) (m[f.role!] ??= []).push(f.label);
    return m;
  });
  /** Fields the row already shows in its own cells (time, level), left out of a fallback summary. */
  readonly rowRoleLabels = computed(() => new Set([...(this.roleLabels()['TIME'] ?? []), ...(this.roleLabels()['LEVEL'] ?? [])]));
  /** Role -> its first field (headings, menus). */
  readonly roleLabel = computed(() => {
    const m: Partial<Record<string, string>> = {};
    for (const [r, l] of Object.entries(this.roleLabels())) m[r] = l?.[0];
    return m;
  });
  readonly roleRows = computed(() =>
    (['TIME', 'LEVEL', 'CORRELATION', 'DURATION', 'MESSAGE', 'SERVICE'] as const)
      .filter((r) => this.roleLabel()[r])
      .map((r) => ({ role: r.toLowerCase(), label: this.roleLabels()[r]!.join(' / ') })),
  );
  readonly terms = computed(() => this.pills().filter((p) => p.op === 'TEXT').map((p) => p.value ?? ''));
  readonly gridColumns = computed(() => {
    const cols = this.columns().length ? this.columns().map(() => 'minmax(90px, 1fr)').join(' ') : 'minmax(0, 1fr)';
    return `3px 20px 20px 18px 104px 56px ${cols} 90px 40px`;
  });
  readonly order = computed(() => this.rows().map((r) => r.lineId));
  readonly header = computed(() => headerState(this.sel(), this.order()));
  readonly hiddenSelected = computed(() => hiddenCount(this.sel(), new Set(this.order()), !this.cursor()));
  readonly histBars = computed(() => {
    const h = this.histogram();
    if (!h || !h.buckets.length) return [];
    const max = Math.max(1, ...h.buckets.map((b) => Object.values(b.byLevel).reduce((a, x) => a + x, 0)));
    return h.buckets.map((b, i) => {
      const lv = (k: string) => b.byLevel[k] ?? 0;
      const other = Object.entries(b.byLevel).filter(([k]) => !['ERROR', 'WARN', 'INFO'].includes(k)).reduce((a, [, x]) => a + x, 0);
      return { i, from: b.from, error: (lv('ERROR') / max) * 60, warn: (lv('WARN') / max) * 60, info: (lv('INFO') / max) * 60, other: (other / max) * 60,
        title: `${this.time(b.from)} · ${lv('ERROR') + lv('WARN') + lv('INFO') + other} lines (${lv('ERROR')} errors)` };
    });
  });
  readonly minimapTicks = computed(() => {
    const m = this.minimap();
    if (!m || m.total === 0) return [];
    const custom = this.minimapCond() !== '';
    return m.matches
      .map((n, b) => ({ b, top: (b / MINIMAP_BUCKETS) * 100, color: custom ? 'var(--purple-light)' : m.errors[b] ? 'var(--red)' : 'var(--amber)', n }))
      .filter((t) => t.n > 0);
  });

  ngOnInit(): void {
    this.api.source(this.id).subscribe({
      next: (v) => this.view$.set(v),
      error: () => this.error.set('This log source does not exist (any more).'),
    });
    this.api.structure(this.id).subscribe((s) => {
      this.structure.set(s);
      this.dataView.set(this.storedDataView() ?? s.defaultDataView);
      this.api.lines(this.id, { pills: [], limit: 1 }).subscribe((p) => {
        this.newestTs.set(p.lines[0]?.ts ?? null);
        if (this.sessionParam) {
          this.api.session(this.id, this.sessionParam).subscribe({
            next: (sv) => this.applySession(sv),
            error: () => {
              this.error.set('That session does not exist (any more).');
              this.refreshAll();
            },
          });
        } else {
          this.refreshAll();
        }
      });
    });
    this.loadRecording();
    this.loadViews();
    this.socket.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((e) => {
      if (!('sourceId' in e) || e.sourceId !== this.id) return;
      if (e.type === 'lines-added' && e.count > 0) this.onLinesAdded(e.count, e.newestTs);
      if (e.type === 'structure-changed') {
        this.rebuilding.set(e.rebuilding ?? '');
        this.api.structure(this.id).subscribe((s) => this.structure.set(s));
      }
      if (e.type === 'comment-changed') this.reloadComments(e.lineId);
      if (e.type === 'sessions-changed') {
        this.loadRecording();
        const open = this.openSession();
        if (open) this.api.session(this.id, open.session.id).subscribe((s) => this.openSession.set(s));
      }
      if (e.type === 'input-progress') this.api.source(this.id).subscribe((v) => this.view$.set(v));
    });
    this.socket.reconnected$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.refreshAll());
    this.destroyRef.onDestroy(() => {
      if (this.aggregateTimer) clearTimeout(this.aggregateTimer);
      if (this.clockTimer) clearInterval(this.clockTimer);
      if (this.freshTimer) clearTimeout(this.freshTimer);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
    });
  }

  // ------------------------------------------------------------------ query

  query(extra: Pill[] = [], limit = PAGE, cursor: string | null = null): LogQuery {
    const c = this.customRange();
    const span = RANGES[this.range()];
    const newest = this.newestTs();
    const from = c ? c.from : span !== null && newest !== null ? newest - span : null;
    const to = c ? c.to : null;
    return { pills: [...this.pills(), ...extra], from, to, limit, cursor };
  }

  refreshAll(): void {
    this.refreshList();
    this.refreshAggregates();
  }

  /** The visible list only: one indexed page, cheap enough for every live update. */
  private refreshList(): void {
    this.rows.set([]);
    this.cursor.set(null);
    this.newCount.set(0);
    this.fetchLines(true);
    if (this.mode() === 'grouped') this.fetchRoots();
  }

  /**
   * Everything that reads every matching line: histogram, sidebar counts, structures, minimap,
   * patterns. During a live load these run at most every AGGREGATE_EVERY_MS (see onLinesAdded), not
   * on every batch - recomputing them each second kept several cores busy for the whole load.
   */
  private refreshAggregates(): void {
    this.lastAggregates = Date.now();
    this.api.histogram(this.id, this.query(), 60).subscribe((h) => this.histogram.set(h));
    this.api.fieldValues(this.id, this.query()).subscribe((v) => this.values.set(v));
    this.api.structures(this.id, this.query()).subscribe((s) => this.lineStructures.set(s));
    this.fetchMinimap();
    if (this.mode() === 'patterns') this.fetchPatterns();
  }

  private lastAggregates = 0;
  private aggregateTimer: ReturnType<typeof setTimeout> | null = null;

  /** At most one aggregate refresh per AGGREGATE_EVERY_MS while lines keep arriving; the last one always runs. */
  private scheduleAggregates(): void {
    if (this.aggregateTimer) return;
    const wait = Math.max(0, this.lastAggregates + AGGREGATE_EVERY_MS - Date.now());
    this.aggregateTimer = setTimeout(() => {
      this.aggregateTimer = null;
      this.refreshAggregates();
    }, wait);
  }

  fetchLines(first = false): void {
    if (this.loading() || (!first && !this.cursor())) return;
    this.loading.set(true);
    this.api.lines(this.id, this.query([], PAGE, first ? null : this.cursor())).subscribe({
      next: (p) => {
        this.rows.update((r) => (first ? [...p.lines] : [...r, ...p.lines]));
        this.cursor.set(p.nextCursor);
        if (first) {
          this.total.set(p.total);
          this.tookMs.set(p.tookMs);
          this.slow.set(p.slow);
        }
        this.loading.set(false);
        this.error.set('');
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(this.errorText(e));
      },
    });
  }

  /** Lines that just arrived live, briefly highlighted. */
  readonly freshIds = signal<ReadonlySet<string>>(new Set());
  private freshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Live update without flicker: the newest page is fetched and only the lines not shown yet are
   * inserted - the list is never cleared, nothing shows "Loading…", rows already open stay open, and
   * the pages already loaded below stay as they are.
   */
  private refreshLive(): void {
    if (this.mode() !== 'lines') return this.refreshList();
    this.api.lines(this.id, this.query([], PAGE, null)).subscribe({
      next: (p) => {
        const shown = new Set(this.rows().map((r) => r.lineId));
        const fresh = p.lines.filter((l) => !shown.has(l.lineId));
        this.total.set(p.total);
        this.tookMs.set(p.tookMs);
        if (!fresh.length) return;
        const top = new Set(p.lines.map((l) => l.lineId));
        this.rows.update((rows) => [...p.lines, ...rows.filter((r) => !top.has(r.lineId))]);
        if (!this.cursor()) this.cursor.set(p.nextCursor);
        this.freshIds.set(new Set(fresh.map((l) => l.lineId)));
        if (this.freshTimer) clearTimeout(this.freshTimer);
        this.freshTimer = setTimeout(() => this.freshIds.set(new Set()), 1500);
      },
      error: (e) => this.error.set(this.errorText(e)),
    });
  }

  fetchMinimap(): void {
    const cond = this.minimapCond();
    const pill = cond ? parseQuery(cond, this.queryLabels()) : null;
    this.api.minimap(this.id, this.query(), pill ? [pill] : []).subscribe({ next: (m) => this.minimap.set(m), error: () => this.minimap.set(null) });
  }

  private errorText(e: unknown): string {
    return (e as { error?: { error?: string } })?.error?.error || 'Something went wrong';
  }

  addPill(p: Pill): void {
    if (!this.pills().some((x) => samePill(x, p))) this.pills.update((l) => [...l, p]);
    this.refreshAll();
  }

  removePill(i: number): void {
    this.pills.update((l) => l.filter((_, j) => j !== i));
    this.refreshAll();
  }

  pillText(p: Pill): string {
    return pillText(p, (ms) => this.time(ms));
  }

  pillClass = pillClass;

  setRange(r: string): void {
    this.range.set(r);
    this.customRange.set(null);
    try {
      localStorage.setItem(`alfred.logs.range.${this.id}`, r);
    } catch {
      // A remembered range is a convenience only.
    }
    this.refreshAll();
  }

  private storedRange(): string {
    try {
      return localStorage.getItem(`alfred.logs.range.${this.id}`) ?? '24h';
    } catch {
      return '24h';
    }
  }

  private storedDataView(): 'TABLE' | 'JSON' | null {
    try {
      const v = localStorage.getItem(`alfred.logs.dataView.${this.id}`);
      return v === 'TABLE' || v === 'JSON' ? v : null;
    } catch {
      return null;
    }
  }

  setDataView(v: 'TABLE' | 'JSON'): void {
    this.dataView.set(v);
    try {
      localStorage.setItem(`alfred.logs.dataView.${this.id}`, v);
    } catch {
      // ignore
    }
  }

  // ---- autocomplete (mock suggest()/drawAc())
  onQueryInput(text: string): void {
    this.qtext.set(text);
    const out: AcItem[] = [];
    const m = text.match(/^-?([\w.@$-]+):(.*)$/);
    const neg = text.startsWith('-') ? '-' : '';
    if (m && this.labels().has(m[1])) {
      const top = this.values()?.fields[m[1]]?.top ?? [];
      top.filter((v) => v.value.toLowerCase().includes(m[2].toLowerCase())).slice(0, 8)
        .forEach((v) => out.push({ insert: `${neg}${m[1]}:${v.value}`, show: `${m[1]}:${v.value}`, note: String(v.count) }));
      out.push({ insert: `${neg}${m[1]}:*`, show: `${m[1]} ${neg ? 'missing' : 'exists'}`, note: '' });
    } else if (text.trim()) {
      const q = text.replace(/^-/, '').toLowerCase();
      this.fields().filter((f) => f.label.toLowerCase().includes(q)).slice(0, 8)
        .forEach((f) => out.push({ insert: `${neg}${f.label}:`, show: `${this.typeIcon(f)}  ${f.label}`, note: f.type.toLowerCase() }));
      out.push({ insert: `"${text.trim()}"`, show: `search text "${text.trim()}"`, note: '' });
    }
    this.ac.set(out);
    this.acIdx.set(0);
  }

  onQueryKey(ev: KeyboardEvent): void {
    const ac = this.ac();
    if (ev.key === 'ArrowDown' && ac.length) {
      this.acIdx.set((this.acIdx() + 1) % ac.length);
      ev.preventDefault();
    } else if (ev.key === 'ArrowUp' && ac.length) {
      this.acIdx.set((this.acIdx() - 1 + ac.length) % ac.length);
      ev.preventDefault();
    } else if (ev.key === 'Tab' && ac.length) {
      ev.preventDefault();
      this.applyAc(ac[this.acIdx()]);
    } else if (ev.key === 'Enter') {
      const text = this.qtext();
      if (ac.length && text && !text.includes(':') && !/[<>"]/.test(text)) return this.applyAc(ac[this.acIdx()]);
      this.commitQuery(text);
    } else if (ev.key === 'Backspace' && !this.qtext() && this.pills().length) {
      this.removePill(this.pills().length - 1);
    } else if (ev.key === 'Escape') {
      this.ac.set([]);
    }
  }

  applyAc(item: AcItem): void {
    if (item.insert.endsWith(':')) {
      this.qtext.set(item.insert);
      this.onQueryInput(item.insert);
      this.queryInput()?.nativeElement.focus();
    } else this.commitQuery(item.insert);
  }

  private commitQuery(text: string): void {
    const p = parseQuery(text, this.queryLabels());
    if (!p) return;
    this.qtext.set('');
    this.ac.set([]);
    this.addPill(p);
  }

  // ---- histogram drag-to-zoom
  histDown(i: number): void {
    this.drag.set({ a: i, b: i });
  }

  histEnter(i: number): void {
    const d = this.drag();
    if (d) this.drag.set({ a: d.a, b: i });
  }

  histUp(): void {
    const d = this.drag();
    const h = this.histogram();
    this.drag.set(null);
    if (!d || !h) return;
    const lo = Math.min(d.a, d.b);
    const hi = Math.max(d.a, d.b);
    this.customRange.set({ from: h.buckets[lo].from, to: h.buckets[hi].from + h.bucketMs - 1 });
    this.refreshAll();
  }

  inDrag(i: number): boolean {
    const d = this.drag();
    return !!d && i >= Math.min(d.a, d.b) && i <= Math.max(d.a, d.b);
  }

  clearCustomRange(): void {
    this.customRange.set(null);
    this.refreshAll();
  }

  // ------------------------------------------------------------------ display helpers

  time(ms: number): string {
    return formatLogTime(ms, this.zone());
  }

  dateTime(ms: number): string {
    return formatLogDateTime(ms, this.zone());
  }

  utc = utcHint;
  duration = formatDuration;

  summary(r: LogLineSummary): string {
    if (r.unparsed) return 'unparsed line';
    return summaryOrFields(this.templateFor(r.shape), this.visibleFields(r.fields), this.rowRoleLabels());
  }

  /** A line structure may have its own summary template; otherwise the source's. */
  templateFor(shape: number): string {
    return this.structureById().get(shape)?.template || this.structure()?.template || '';
  }

  /** The first field of a role this line has, and its value. */
  roleValue(r: { readonly fields: LogLineSummary['fields'] }, role: string): { label: string; value: string | number | boolean } | null {
    for (const label of this.roleLabels()[role] ?? []) {
      const v = r.fields[label];
      if (v !== null && v !== undefined) return { label, value: v };
    }
    return null;
  }

  structureFilter(s: LineStructure, out: boolean): void {
    this.addPill({ op: out ? 'NEQ' : 'EQ', field: STRUCTURE_FIELD, value: s.code });
  }

  structureTitle(shape: number): string {
    const s = this.structureById().get(shape);
    return s ? `${s.code} · ${s.name} - click to show only this structure` : '';
  }

  showStructures(): boolean {
    return this.structures().length > 1;
  }

  private visibleFields(fields: LogLineSummary['fields']): LogLineSummary['fields'] {
    const hidden = this.maskedLabels();
    if (!hidden.size) return fields;
    const out: Record<string, string | number | boolean | null> = { ...fields };
    for (const k of Object.keys(out)) if (hidden.has(k)) out[k] = '•••';
    return out;
  }

  segments(text: string) {
    return highlightSegments(text, this.terms());
  }

  levelOf(r: LogLineSummary): string {
    const l = r.level ?? (r.unparsed ? 'WARN' : 'INFO');
    return ['ERROR', 'WARN', 'INFO', 'DEBUG'].includes(l) ? l : 'other';
  }

  corrColor(r: LogLineSummary): string | null {
    const v = this.roleValue(r, 'CORRELATION')?.value;
    if (v === null || v === undefined) return null;
    let h = 0;
    for (const ch of String(v)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return CORR_COLORS[Math.abs(h) % CORR_COLORS.length];
  }

  corrValue(r: LogLineSummary): string {
    const c = this.roleValue(r, 'CORRELATION');
    return c ? `${c.label} ${c.value}` : '';
  }

  durationOf(r: LogLineSummary): number | null {
    const v = this.roleValue(r, 'DURATION')?.value ?? null;
    return typeof v === 'number' ? v : v !== null && v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : null;
  }

  cell(r: LogLineSummary, c: string): string {
    if (this.maskedLabels().has(c) && r.fields[c] !== undefined && r.fields[c] !== null) return '•••';
    const v = r.fields[c];
    // Lines may each have their own structure: a column this line does not have shows "-", like OpenSearch.
    return v === null || v === undefined ? '-' : String(v);
  }

  redCell(r: LogLineSummary, c: string): boolean {
    const v = r.fields[c];
    return ((this.roleLabels()['STATUS'] ?? []).includes(c) && Number(v) >= 500)
      || ((this.roleLabels()['LEVEL'] ?? []).includes(c) && String(v).toUpperCase() === 'ERROR');
  }

  levelIds(lineId: string): string {
    const l = this.full().get(lineId) ?? this.rows().find((r) => r.lineId === lineId);
    if (!l) return '';
    return this.levelLabels().map((lb) => (l.fields[lb] !== undefined && l.fields[lb] !== null ? `${lb}=${l.fields[lb]}` : null)).filter(Boolean).join(' · ');
  }

  typeIcon(f: FieldDef): string {
    return ({ DATETIME: '◷', DATE: '▦', NUMBER: '#', STRING: 't', BOOLEAN: 'b' } as const)[f.type];
  }

  presence(f: FieldDef): string {
    const p = this.values()?.fields[f.label]?.presence;
    return p === undefined ? '-' : `${Math.round(p * 100)}%`;
  }

  top(f: FieldDef) {
    return this.values()?.fields[f.label]?.top ?? [];
  }

  // ------------------------------------------------------------------ rows

  onScroll(): void {
    const el = this.listEl()?.nativeElement;
    if (!el) return;
    if (this.mode() === 'lines' && el.scrollTop + el.clientHeight > el.scrollHeight - 300) this.fetchLines();
    if (this.newCount() && el.scrollTop < 10 && this.live()) this.refreshAll();
  }

  private onLinesAdded(count: number, newest: number): void {
    if (newest > (this.newestTs() ?? 0)) this.newestTs.set(newest);
    // Lines per second over the last 5 s of "lines added" signals (computed when they arrive - no timer).
    const now = Date.now();
    this.rateWindow = [...this.rateWindow.filter((x) => now - x.t < 5000), { t: now, n: count }];
    this.liveRate.set(Math.round(this.rateWindow.reduce((a, x) => a + x.n, 0) / 5));
    this.lastLineAt.set(now);
    const el = this.listEl()?.nativeElement;
    if (this.live() && this.mode() === 'lines' && (!el || el.scrollTop < 10)) this.scheduleRefresh();
    else this.newCount.update((n) => n + count);
  }

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Coalesces a burst of "lines added" signals into one refetch (a one-shot delay, not polling). */
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshLive();
      this.scheduleAggregates();
      this.refreshRecording();
    }, LIVE_REFRESH_MS);
  }

  // ------------------------------------------------------------------ sessions

  private loadRecording(): void {
    this.api.sessions(this.id).subscribe((all) => {
      const live = all.find((s) => s.session.endedAt === null) ?? null;
      this.recording.set(live);
      this.tickClock(!!live);
    });
  }

  private refreshRecording(): void {
    const r = this.recording();
    if (r) this.api.session(this.id, r.session.id).subscribe((s) => this.recording.set(s.session.endedAt === null ? s : null));
  }

  /** A clock for the recording timer only (display; nothing is fetched on it). */
  private tickClock(on: boolean): void {
    if (on && !this.clockTimer) this.clockTimer = setInterval(() => this.clock.set(Date.now()), 1000);
    if (!on && this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  openRecord(): void {
    this.recName.set(`Session ${new Date().toLocaleString()}`);
    this.recIdField.set(this.idFields()[0] ?? '');
    this.recError.set('');
    this.recOpen.set(true);
  }

  startRecording(): void {
    const kind = this.recKind();
    const filter = this.recUseFilter() ? this.pills().filter((p) => p.op !== 'SELECTION' && p.op !== 'INGESTED') : [];
    this.api.startSession(this.id, {
      name: this.recName().trim(),
      kind,
      pills: kind === 'WINDOW' ? filter : [],
      idField: kind === 'ID' ? this.recIdField() : null,
      idValue: kind === 'ID' ? this.recIdValue().trim() : null,
    }).subscribe({
      next: (s) => {
        this.recording.set(s);
        this.recOpen.set(false);
        this.tickClock(true);
      },
      error: (e) => this.recError.set((e as { error?: { error?: string } })?.error?.error || 'Could not start recording'),
    });
  }

  addMarker(): void {
    const r = this.recording();
    const text = (this.markerText() ?? '').trim();
    if (!r || !text) return;
    this.api.markSession(this.id, r.session.id, text).subscribe((s) => {
      this.recording.set(s);
      this.markerText.set(null);
    });
  }

  stopRecording(): void {
    const r = this.recording();
    if (!r) return;
    this.api.stopSession(this.id, r.session.id).subscribe((s) => {
      this.recording.set(null);
      this.tickClock(false);
      void this.router.navigate(['/logs', this.id], { queryParams: { session: s.session.id } }).then(() => this.applySession(s));
    });
  }

  /** Shows one recorded session: its own filter, all time, its markers between the lines. */
  applySession(s: SessionView): void {
    this.openSession.set(s);
    this.pills.set([...s.pills]);
    this.range.set('all');
    this.customRange.set(null);
    this.refreshAll();
  }

  closeSession(): void {
    this.openSession.set(null);
    this.pills.set([]);
    void this.router.navigate(['/logs', this.id]);
    this.refreshAll();
  }

  sessionLength(s: { startedAt: number; endedAt: number | null }): string {
    const ms = (s.endedAt ?? Date.now()) - s.startedAt;
    const sec = Math.round(ms / 1000);
    return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} m ${sec % 60} s`;
  }

  jumpToNewest(): void {
    this.newCount.set(0);
    this.refreshAll();
    this.listEl()?.nativeElement.scrollTo({ top: 0 });
  }

  toggleData(lineId: string): void {
    this.current.set(lineId);
    const open = new Set(this.openData());
    if (open.has(lineId)) open.delete(lineId);
    else {
      open.add(lineId);
      this.ensureFull(lineId);
    }
    this.openData.set(open);
  }

  private ensureFull(lineId: string): void {
    if (!this.full().has(lineId)) {
      this.api.line(this.id, lineId).subscribe((l) => this.full.update((m) => new Map(m).set(lineId, l)));
    }
    this.reloadComments(lineId);
  }

  private reloadComments(lineId: string | null): void {
    const ids = lineId ? [lineId] : [...this.comments().keys()];
    for (const id of ids) {
      if (!this.openData().has(id) && this.drawer() !== id && lineId === null) continue;
      this.api.comments(this.id, id).subscribe((c) => this.comments.update((m) => new Map(m).set(id, c)));
    }
  }

  reloadOne(lineId: string): void {
    this.api.comments(this.id, lineId).subscribe((c) => {
      this.comments.update((m) => new Map(m).set(lineId, c));
      this.rows.update((rows) => rows.map((r) => (r.lineId === lineId ? { ...r, commentCount: c.length } : r)));
    });
  }

  renderSummary(l: LogLine): string {
    return l.unparsed ? 'unparsed line' : summaryOrFields(this.templateFor(l.shape), this.visibleFields(l.fields), this.rowRoleLabels());
  }

  commentsFor(lineId: string): readonly LogComment[] {
    return this.comments().get(lineId) ?? [];
  }

  closeAllData(): void {
    this.openData.set(new Set());
  }

  onFieldAction(a: FieldAction): void {
    if (a.kind === 'col') return this.toggleColumn(a.label);
    if (a.kind === 'ex') return this.addPill({ op: 'EXISTS', field: a.label });
    if (a.value === null) return;
    this.addPill({ op: a.kind === 'eq' ? 'EQ' : 'NEQ', field: a.label, value: a.value });
  }

  toggleColumn(label: string): void {
    const s = this.structure();
    if (!s) return;
    const columns = s.columns.includes(label) ? s.columns.filter((c) => c !== label) : [...s.columns, label];
    const next = { ...s, columns };
    this.structure.set(next);
    this.api.saveStructure(this.id, next).subscribe({ error: (e) => this.error.set(this.errorText(e)) });
    this.refreshAll(); // new columns are new summary fields
  }

  // ------------------------------------------------------------------ selection & bulk

  pick(lineId: string, ev: MouseEvent): void {
    ev.stopPropagation();
    this.sel.set(ev.shiftKey ? selectRange(this.sel(), lineId, this.order()) : toggle(this.sel(), lineId));
  }

  pickAll(ev: MouseEvent): void {
    ev.stopPropagation();
    if (ev.shiftKey) return this.selectAllMatching();
    this.sel.set(selectAll(this.sel(), this.order()));
  }

  selectAllMatching(): void {
    this.api.lines(this.id, this.query([], 1)).subscribe(async (p) => {
      if (p.total > 10_000) {
        this.bulkMsg.set(`${p.total.toLocaleString('en-US')} lines match - narrow the search to 10,000 or fewer to select them all.`);
        return;
      }
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: LogPage = await firstValueFrom(this.api.lines(this.id, this.query([], 500, cursor)));
        page.lines.forEach((l) => ids.push(l.lineId));
        cursor = page.nextCursor;
      } while (cursor);
      this.sel.set({ ids: new Set([...this.sel().ids, ...ids]), lastPick: this.sel().lastPick });
    });
  }

  clearSelection(): void {
    this.sel.set(EMPTY_SELECTION);
    this.bulkMsg.set('');
    this.bulkComment.set(null);
    if (this.pills().some((p) => p.op === 'SELECTION')) {
      this.pills.update((l) => l.filter((p) => p.op !== 'SELECTION'));
      this.refreshAll();
    }
  }

  selectionOnly(): void {
    if (this.pills().some((p) => p.op === 'SELECTION')) {
      this.pills.update((l) => l.filter((p) => p.op !== 'SELECTION'));
    } else {
      this.pills.update((l) => [...l, { op: 'SELECTION', lineIds: [...this.sel().ids].slice(0, 10_000) }]);
    }
    this.refreshAll();
  }

  addChildrenOfSelected(): void {
    const sel = [...this.sel().ids];
    const byId = new Map<string, LogLineSummary>();
    const collect = (nodes: readonly GroupNode[]) => nodes.forEach((n) => {
      [n.headLine, ...n.siblings, ...n.skipped].forEach((l) => l && byId.set(l.lineId, l));
    });
    collect(this.roots());
    this.kids().forEach((n) => collect(n));
    const prefixes = sel.map((id) => byId.get(id)?.groupPath).filter((p): p is string => !!p);
    const add: string[] = [];
    byId.forEach((l, id) => {
      if (prefixes.some((p) => l.groupPath.startsWith(`${p}\u0001`) || (l.groupPath === p && l.missingLevel))) add.push(id);
    });
    this.sel.set({ ids: new Set([...sel, ...add]), lastPick: this.sel().lastPick });
    this.bulkMsg.set(`${add.length} loaded children added. Expand deeper levels to add theirs.`);
  }

  private async fullLines(ids: readonly string[]): Promise<LogLine[]> {
    const out: LogLine[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = await Promise.all(ids.slice(i, i + 20).map((id) => this.full().get(id) ?? firstValueFrom(this.api.line(this.id, id))));
      out.push(...batch);
    }
    return out;
  }

  async copyRaw(): Promise<void> {
    const ids = [...this.sel().ids];
    if (ids.length > MAX_FETCH_FOR_EXPORT) return this.bulkMsg.set(`Copy works on up to ${MAX_FETCH_FOR_EXPORT.toLocaleString('en-US')} lines.`);
    const lines = await this.fullLines(ids);
    const exp = await this.exportOf(lines, 'ndjson');
    await copyToClipboard(exp.text);
    this.bulkMsg.set(`Copied ${lines.length} raw lines (NDJSON)${exp.redacted ? `, ${exp.redacted} values redacted` : ''}.`);
  }

  async exportAs(format: string): Promise<void> {
    if (!format) return;
    const ids = [...this.sel().ids];
    if (ids.length > MAX_FETCH_FOR_EXPORT) {
      return this.bulkMsg.set(`Export works on up to ${MAX_FETCH_FOR_EXPORT.toLocaleString('en-US')} lines - nothing is cut, so select fewer.`);
    }
    const lines = await this.fullLines(ids);
    const exp = await this.exportOf(lines, format as LogsExportFormat);
    downloadText(exp.text, `${this.view$()?.source.name ?? 'logs'}-selection.${exp.extension}`, exp.mime);
    this.bulkMsg.set(`Exported ${lines.length} lines in full${exp.redacted ? `, ${exp.redacted} values redacted` : ''}.`);
  }

  private async exportOf(lines: LogLine[], format: LogsExportFormat) {
    const redactions = await firstValueFrom(this.redactionsApi.listAll()).catch(() => []);
    const keys = new Set(redactions.filter((r) => r.scope === 'all' && r.kind.endsWith('body-key')).map((r) => r.name));
    const paths = this.view$()?.source.privacyMode !== 'SHOW'
      ? new Set((this.structure()?.fields ?? []).filter((f) => f.sensitive).map((f) => f.path)) : new Set<string>();
    const comments = new Map<string, readonly LogComment[]>();
    for (const l of lines) comments.set(l.lineId, this.comments().get(l.lineId) ?? (await firstValueFrom(this.api.comments(this.id, l.lineId))));
    return buildLogsExport(lines, format, { sourceName: this.view$()?.source.name ?? 'logs', formatTime: (ms) => this.dateTime(ms), comments, redactKeys: keys, redactPaths: paths });
  }

  pinSelection(): void {
    this.api.pin(this.id, [...this.sel().ids], null).subscribe({
      next: (r) => this.bulkMsg.set(`${r.pinned} lines pinned: kept in Alfred even when retention or the source drops them.`),
      error: (e) => this.bulkMsg.set(this.errorText(e)),
    });
  }

  commentAll(): void {
    const text = (this.bulkComment() ?? '').trim();
    if (!text) return this.bulkMsg.set('Write the comment first.');
    let profile: string | null = null;
    try {
      profile = localStorage.getItem('alfred.logs.profile');
    } catch {
      profile = null;
    }
    this.api.commentAll(this.id, [...this.sel().ids], null, text, profile).subscribe({
      next: (r) => {
        this.bulkComment.set(null);
        this.bulkMsg.set(`Comment added to ${r.commented} lines; they are now pinned.`);
        this.refreshAll();
      },
      error: (e) => this.bulkMsg.set(this.errorText(e)),
    });
  }

  async openCompare(): Promise<void> {
    const ids = [...this.sel().ids];
    if (ids.length !== 2) return this.bulkMsg.set('Compare needs exactly two selected rows.');
    const [a, b] = await this.fullLines(ids);
    this.compareLayout.set(this.structure()?.defaultFieldLayout ?? 'GROUPED');
    this.compareClosed.set(new Set());
    this.compare.set({ a, b, onlyDiff: true });
  }

  /** Compare's own Grouped | Flat switch; starts from the source's default. */
  readonly compareLayout = signal<'GROUPED' | 'FLAT'>('GROUPED');
  readonly compareClosed = signal<ReadonlySet<string>>(new Set());

  compareTree(rows: readonly CompareRow[]): TreeRow<CompareRow>[] {
    const closed = this.compareClosed();
    return visibleRows(buildPathTree(rows, (r) => r.k), (k) => !closed.has(k));
  }

  toggleCompareGroup(key: string): void {
    const next = new Set(this.compareClosed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.compareClosed.set(next);
  }

  differingIn(node: TreeNode<CompareRow>): number {
    return itemsUnder(node).filter((r) => r.differs).length;
  }

  compareRows(c: { a: LogLine; b: LogLine; onlyDiff: boolean }) {
    const keys = [...new Set([...Object.keys(c.a.fields), ...Object.keys(c.b.fields)])];
    const rows = keys.map((k) => {
      const x = c.a.fields[k];
      const y = c.b.fields[k];
      return { k, x: x === undefined ? null : String(x), y: y === undefined ? null : String(y), differs: String(x) !== String(y) };
    });
    return { rows: c.onlyDiff ? rows.filter((r) => r.differs) : rows, differing: rows.filter((r) => r.differs).length, total: rows.length };
  }

  // ------------------------------------------------------------------ minimap

  async jumpToBucket(b: number): Promise<void> {
    const m = this.minimap();
    if (!m || this.mode() !== 'lines') return;
    const target = Math.floor((b / MINIMAP_BUCKETS) * m.total);
    for (let guard = 0; this.rows().length <= target + 20 && this.cursor() && guard < 25; guard++) {
      const p = await firstValueFrom(this.api.lines(this.id, this.query([], 500, this.cursor())));
      this.rows.update((r) => [...r, ...p.lines]);
      this.cursor.set(p.nextCursor);
    }
    const id = this.rows()[Math.min(target, this.rows().length - 1)]?.lineId;
    if (!id) return;
    this.current.set(id);
    setTimeout(() => document.getElementById(`lg-row-${id}`)?.scrollIntoView({ block: 'center' }));
  }

  setMinimapCond(c: string): void {
    this.minimapCond.set(c);
    this.fetchMinimap();
  }

  // ------------------------------------------------------------------ drawer

  openDrawer(lineId: string): void {
    this.drawer.set(lineId);
    this.current.set(lineId);
    this.ensureFull(lineId);
    this.setTab(this.dtab());
  }

  setTab(t: DrawerTab): void {
    this.dtab.set(t);
    const id = this.drawer();
    if (!id) return;
    this.drawerError.set('');
    if (t === 'context') this.api.context(this.id, id, 20, 20).subscribe((r) => this.contextRows.set(r));
    if (t === 'trace') {
      this.api.trace(this.id, id).subscribe({ next: (r) => this.traceRows.set(r), error: (e) => this.drawerError.set(this.errorText(e)) });
    }
  }

  traceBars = computed(() => {
    const rows = this.traceRows();
    if (!rows.length) return [];
    const lo = rows[0].ts;
    const ends = rows.map((r) => r.ts + Math.max(0, this.durationOf(r) ?? 0));
    const span = Math.max(1, Math.max(...ends) - lo);
    return rows.map((r) => {
      const d = this.durationOf(r) ?? 0;
      const start = d && r.ts - d >= lo ? r.ts - d : r.ts;
      return { r, left: ((start - lo) / span) * 100, width: Math.max(0.6, (d / span) * 100), d };
    });
  });

  // ------------------------------------------------------------------ grouped & patterns

  setMode(m: ExplorerView): void {
    this.mode.set(m);
    if (m === 'grouped') this.fetchRoots();
    if (m === 'patterns') this.fetchPatterns();
  }

  fetchRoots(): void {
    if (!this.levelLabels().length) {
      this.roots.set([]);
      return;
    }
    this.kids.set(new Map());
    this.kidsMore.set(new Set());
    this.nodeOwn.set(new Map());
    this.nodeSkip.set(new Map());
    this.openKids.set(new Set());
    this.api.groups(this.id, this.query(), '', 0, GROUP_PAGE).subscribe({
      next: (n) => {
        this.roots.set(n);
        this.rootsMore.set(n.length === GROUP_PAGE);
      },
      error: (e) => this.error.set(this.errorText(e)),
    });
    this.api.bucket(this.id, this.query()).subscribe((p) => {
      this.bucket.set([...p.lines]);
      this.bucketCursor.set(p.nextCursor);
      this.bucketTotal.set(p.total);
    });
  }

  moreRoots(): void {
    this.api.groups(this.id, this.query(), '', this.roots().length, GROUP_PAGE).subscribe((n) => {
      this.roots.update((r) => [...r, ...n]);
      this.rootsMore.set(n.length === GROUP_PAGE);
    });
  }

  moreKids(path: string): void {
    const have = this.kids().get(path) ?? [];
    this.api.groups(this.id, this.query(), path, have.length, GROUP_PAGE).subscribe((n) => {
      this.kids.update((m) => new Map(m).set(path, [...have, ...n]));
      this.kidsMore.update((s) => {
        const next = new Set(s);
        if (n.length === GROUP_PAGE) next.add(path);
        else next.delete(path);
        return next;
      });
    });
  }

  moreBucket(): void {
    const cursor = this.bucketCursor();
    if (!cursor) return;
    this.api.bucket(this.id, this.query([], PAGE, cursor)).subscribe((p) => {
      this.bucket.update((b) => [...b, ...p.lines]);
      this.bucketCursor.set(p.nextCursor);
    });
  }

  /** Every own/skipped line of a node, page by page, once the node holds more than fits in it (FR-023). */
  moreNodeLines(n: GroupNode, skipped: boolean): void {
    const store = skipped ? this.nodeSkip : this.nodeOwn;
    const cur = store().get(n.path);
    this.api.nodeLines(this.id, this.query([], 500, cur?.cursor ?? null), n.path, skipped).subscribe((p) => {
      store.update((m) => new Map(m).set(n.path, { lines: [...(cur?.lines ?? []), ...p.lines], cursor: p.nextCursor }));
    });
  }

  siblingsOf(n: GroupNode): readonly LogLineSummary[] {
    const all = this.nodeOwn().get(n.path);
    return all ? all.lines.filter((l) => l.lineId !== n.headLine?.lineId) : n.siblings;
  }

  skippedOf(n: GroupNode): readonly LogLineSummary[] {
    return this.nodeSkip().get(n.path)?.lines ?? n.skipped;
  }

  /** The node shipped a full page of its own lines, so there may be more than shown. */
  hasMoreOwn(n: GroupNode): boolean {
    const all = this.nodeOwn().get(n.path);
    return all ? all.cursor !== null : n.siblings.length + 1 >= NODE_LINES;
  }

  hasMoreSkipped(n: GroupNode): boolean {
    const all = this.nodeSkip().get(n.path);
    return all ? all.cursor !== null : n.skipped.length >= NODE_LINES;
  }

  async toggleKids(n: GroupNode): Promise<void> {
    const open = new Set(this.openKids());
    if (open.has(n.path)) {
      open.delete(n.path);
      this.openKids.set(open);
      return;
    }
    open.add(n.path);
    this.openKids.set(open);
    if (!this.kids().has(n.path)) await this.loadKids(n.path);
  }

  private async loadKids(path: string): Promise<GroupNode[]> {
    const children = await firstValueFrom(this.api.groups(this.id, this.query(), path, 0, GROUP_PAGE));
    this.kids.update((m) => new Map(m).set(path, children));
    if (children.length === GROUP_PAGE) this.kidsMore.update((s) => new Set(s).add(path));
    return children;
  }

  async expandTo(level: number): Promise<void> {
    const open = new Set<string>();
    let frontier = this.roots();
    let budget = 300;
    for (let depth = 1; depth <= level && frontier.length && budget > 0; depth++) {
      const next: GroupNode[] = [];
      for (const n of frontier) {
        if (budget-- <= 0) break;
        if (!n.childCount && !n.skipped.length) continue;
        open.add(n.path);
        const children = this.kids().get(n.path) ?? (await this.loadKids(n.path));
        next.push(...children);
      }
      frontier = next;
    }
    this.openKids.set(open);
  }

  childrenOf(path: string): GroupNode[] {
    return this.kids().get(path) ?? [];
  }

  placeholderText(n: GroupNode): string {
    // With filters, the parent line usually exists but does not match - say that, not "missing".
    const filtered = this.pills().length > 0 || this.customRange() !== null || RANGES[this.range()] !== null;
    return `${this.levelLabels()[n.level - 1]} = ${n.id} · ${filtered ? `no level-${n.level} line matches the current filters` : `no level-${n.level} line in the log`}`;
  }

  setLevelSort(i: number, sort: GroupSort): void {
    const s = this.structure();
    if (!s) return;
    const next = { ...s, groupLevels: s.groupLevels.map((l, j) => (j === i ? { ...l, sort } : l)) };
    this.structure.set(next);
    this.api.saveStructure(this.id, next).subscribe(() => this.fetchRoots());
  }

  fetchPatterns(): void {
    this.patternOpen.set(new Map());
    this.api.patterns(this.id, this.query()).subscribe((p) => this.patterns.set(p));
  }

  togglePattern(p: Pattern): void {
    const m = new Map(this.patternOpen());
    if (m.has(p.id)) {
      m.delete(p.id);
      this.patternOpen.set(m);
      return;
    }
    this.api.lines(this.id, this.query([{ op: 'PATTERN', value: String(p.id) }], PAGE)).subscribe((page) => {
      this.patternOpen.update((x) => new Map(x).set(p.id, { lines: [...page.lines], cursor: page.nextCursor }));
    });
  }

  morePattern(p: Pattern): void {
    const cur = this.patternOpen().get(p.id);
    if (!cur?.cursor) return;
    this.api.lines(this.id, this.query([{ op: 'PATTERN', value: String(p.id) }], PAGE, cur.cursor)).subscribe((page) => {
      this.patternOpen.update((x) => new Map(x).set(p.id, { lines: [...cur.lines, ...page.lines], cursor: page.nextCursor }));
    });
  }

  // ------------------------------------------------------------------ field stats & saved views

  openStats(f: FieldDef, ev: MouseEvent): void {
    const target = ev.currentTarget as HTMLElement;
    const box = target.getBoundingClientRect();
    const host = target.closest('.lg-side')?.getBoundingClientRect();
    this.stats.set({ label: f.label, data: null, top: box.bottom - (host?.top ?? 0) + 4, left: 20 });
    this.api.fieldStats(this.id, f.label, this.query()).subscribe({
      next: (d) => this.stats.update((s) => (s && s.label === f.label ? { ...s, data: d } : s)),
      error: () => this.stats.set(null),
    });
  }

  statText(v: number | null, label: string): string {
    if (v === null) return '-';
    const f = this.fields().find((x) => x.label === label);
    if (f?.type === 'DATETIME' || f?.type === 'DATE') return this.time(v);
    if (f?.role === 'DURATION' || f?.format?.includes('ms')) return formatDuration(v);
    return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2);
  }

  distTop(stats: FieldStats): number {
    return Math.max(1, ...stats.distribution);
  }

  /** The slowest share broken down by the Service-role field (mock statsPop "group by"). */
  breakdown(label: string, p95: number | null): void {
    const service = this.roleLabel()['SERVICE'];
    if (p95 === null || !service) return;
    this.api.fieldValues(this.id, this.query([{ op: 'GT', field: label, value: String(p95) }])).subscribe((v) => {
      const top = v.fields[service]?.top ?? [];
      this.stats.update((s) => (s ? { ...s, breakdown: top.map((t) => ({ value: t.value, count: t.count })) } : s));
    });
  }

  aboveP95(label: string, p95: number | null): void {
    if (p95 === null) return;
    this.stats.set(null);
    this.addPill({ op: 'GT', field: label, value: String(p95) });
  }

  loadViews(): void {
    this.api.views(this.id).subscribe((v) => this.savedViews.set(v));
  }

  applyView(id: string): void {
    const v = this.savedViews().find((x) => x.id === id);
    if (!v) return;
    this.pills.set([...v.state.pills]);
    if (v.state.range) this.range.set(v.state.range);
    if (v.state.view) this.mode.set(v.state.view);
    this.refreshAll();
  }

  deleteView(v: SavedView): void {
    this.api.deleteView(this.id, v.id).subscribe(() => this.loadViews());
  }

  readonly viewsOpen = signal(false);

  saveView(): void {
    const name = (this.saveViewName() ?? '').trim();
    if (!name) return;
    this.api.saveView(this.id, name, { pills: this.pills(), range: this.range(), view: this.mode() }).subscribe({
      next: () => {
        this.saveViewName.set(null);
        this.loadViews();
      },
      error: (e) => this.error.set(this.errorText(e)),
    });
  }

  // ------------------------------------------------------------------ keyboard (mock keydown listener)

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement;
    if (t.matches('input, textarea, select')) return;
    if (ev.key === '/') {
      ev.preventDefault();
      this.queryInput()?.nativeElement.focus();
      return;
    }
    if (ev.key === 'Escape') {
      if (this.compare()) this.compare.set(null);
      else if (this.stats()) this.stats.set(null);
      else if (this.sel().ids.size) this.clearSelection();
      return;
    }
    if (this.mode() !== 'lines' || !this.rows().length) return;
    const order = this.order();
    const i = Math.max(0, order.indexOf(this.current() ?? ''));
    const move = (n: number) => {
      const id = order[Math.max(0, Math.min(order.length - 1, n))];
      this.current.set(id);
      if (this.drawer()) this.openDrawer(id);
      document.getElementById(`lg-row-${id}`)?.scrollIntoView({ block: 'nearest' });
      return id;
    };
    if (ev.key === 'j') move(i + 1);
    else if (ev.key === 'k') move(i - 1);
    else if (ev.key === 'J' || ev.key === 'K') {
      const from = this.current() ?? order[0];
      const to = move(ev.key === 'J' ? i + 1 : i - 1);
      const ids = new Set(this.sel().ids);
      ids.add(from);
      ids.add(to);
      this.sel.set({ ids, lastPick: to });
    } else if (ev.key === 'x' && this.current()) this.sel.set(toggle(this.sel(), this.current()!));
    else if (ev.key === 'Enter' && this.current()) this.toggleData(this.current()!);
  }
}
