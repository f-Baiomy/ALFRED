import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ExportDialogComponent } from '../../../components/export-dialog/export-dialog.component';
import { StorageExportService } from '../../../core/services/storage-export.service';
import { Observable, Subject, Subscription, debounceTime, switchMap } from 'rxjs';
import { StorageApiService } from '../../../core/services/storage-api.service';
import {
  CleanupKind, CleanupRequest, CleanupResult, DEFAULT_RULES, FileHealth, InsightCall, InsightGroup, StorageBackups, StorageBudget,
  StorageInsights, StorageOverview, StorageReliveCycle, StorageRules, StorageRun, StorageShare, StorageSplit, StorageStore,
} from '../../../core/models/storage.model';
import {
  BUDGET_CHOICES_GB, GB, MIN_GB, PRESETS, RECOMMENDED_GB, SHARES, SHARE_COLOR, SHARE_LABEL, ageOf, evenRatios, formatBytes,
  growthPerDay, historyKept, liveBytes, overflow, ratiosOf, shareBytes,
} from '../../../shared/utils/storage-budget';

type Tab = 'stored' | 'biggest' | 'relive' | 'rules' | 'history' | 'backup';
type BiggestView = 'endpoints' | 'largest' | 'projects' | 'repeats';

/** A delete waiting out its Undo window - nothing reaches the backend until it runs out. */
interface PendingDelete {
  readonly label: string;
  readonly secondsLeft: number;
}

interface Suggestion {
  readonly id: string;
  readonly tone: 'red' | 'amber' | 'blue';
  readonly title: string;
  readonly text: string;
  readonly gain: number;
  readonly action: string;
  readonly run: () => void;
}

const UNDO_SECONDS = 8;

/**
 * The page's styles live in their own stylesheet (styles-storage.scss, built as storage-page.css and not injected):
 * added once, the first time the page opens, so they are not part of the app's first download.
 */
export function loadPageStyles(doc: Document): void {
  if (doc.getElementById('alfred-storage-page-css')) return;
  const link = doc.createElement('link');
  link.id = 'alfred-storage-page-css';
  link.rel = 'stylesheet';
  link.href = 'storage-page.css';
  doc.head.appendChild(link);
}

/**
 * Settings → Storage: how much Alfred uses, the one budget it never goes above (every limit a ratio of it), free
 * space back, targeted clean-ups, Relive runs apart from session cycles, and what was removed. Fetch-on-demand: the
 * overview is read when the tab opens and after every action - nothing polls.
 */
@Component({
  selector: 'app-storage-settings',
  standalone: true,
  imports: [ExportDialogComponent],
  templateUrl: './storage-settings.component.html',
})
export class StorageSettingsComponent implements OnInit, OnDestroy {
  private readonly api = inject(StorageApiService);
  private readonly exporter = inject(StorageExportService);

  readonly overview = signal<StorageOverview | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly busy = signal<string | null>(null);
  readonly tab = signal<Tab>('stored');
  readonly openStore = signal<string | null>(null);
  readonly toast = signal<string | null>(null);
  readonly pending = signal<PendingDelete | null>(null);

  // ---- the budget being edited (starts from the saved one)
  readonly draftGb = signal<number>(RECOMMENDED_GB);
  readonly draftSplit = signal<StorageSplit>('recommended');
  readonly draftRatios = signal<Record<StorageShare, number>>({ ...PRESETS.recommended });
  readonly draftInboundCalls = signal(0);
  readonly draftOutboundCalls = signal(0);
  // A new budget deletes nothing beyond its sizes: every run kept, no age rule, until the user sets one.
  readonly draftKeepRuns = signal(0);
  readonly draftAges = signal<{ inbound: number; outbound: number; reliveRuns: number }>({ inbound: 0, outbound: 0, reliveRuns: 0 });
  readonly customGbOpen = signal(false);
  /** A budget picked that would delete data now: asked about right where it was picked. */
  readonly confirmShrink = signal<number | null>(null);

  readonly draftRules = signal<StorageRules>({ ...DEFAULT_RULES });

  // ---- Biggest and Space over time (read when their tab opens)
  readonly insights = signal<StorageInsights | null>(null);
  readonly insightsLoading = signal(false);
  readonly biggestView = signal<BiggestView>('endpoints');
  readonly gone = signal<ReadonlySet<string>>(new Set());
  readonly range = signal<7 | 14 | 30>(14);
  readonly hoverDay = signal<number | null>(null);

  // ---- Backup & files
  readonly fileHealth = signal<FileHealth[] | null>(null);
  readonly checked = signal(false);
  readonly backups = signal<StorageBackups | null>(null);
  readonly backupGroups = signal<ReadonlySet<string>>(new Set(['work', 'config']));

  // ---- clean-up dialog
  readonly cleanupOpen = signal(false);
  readonly cleanup = signal<CleanupRequest>(this.emptyCleanup('outbound'));
  readonly preview = signal<CleanupResult | null>(null);
  readonly previewLoading = signal(false);
  private readonly previewAsk = new Subject<CleanupRequest>();
  private previewSub?: Subscription;

  // ---- danger zone
  readonly dangerOpen = signal<'outbound' | 'inbound' | 'cycles' | null>(null);
  readonly dangerText = signal('');

  private undoTimer?: ReturnType<typeof setInterval>;
  private toastTimer?: ReturnType<typeof setTimeout>;

  readonly Math = Math;
  readonly ageChoices = [0, 1, 7, 14, 30, 90];
  readonly statusChoices: { value: CleanupRequest['status']; label: string }[] = [
    { value: '', label: 'Any status' }, { value: '2xx', label: '2xx / 3xx only' }, { value: '4xx', label: '4xx only' },
    { value: '5xx', label: '5xx / errors only' }, { value: 'options', label: 'OPTIONS preflights' },
  ];
  readonly trafficShares: ('inbound' | 'outbound')[] = ['inbound', 'outbound'];
  readonly shares = SHARES;
  readonly shareLabel = SHARE_LABEL;
  readonly shareColor = SHARE_COLOR;
  readonly choices = BUDGET_CHOICES_GB;
  readonly recommendedGb = RECOMMENDED_GB;
  readonly fmt = formatBytes;
  readonly age = ageOf;
  readonly groups: { id: StorageStore['group']; label: string; hint: string }[] = [
    { id: 'traffic', label: 'Recorded traffic', hint: 'grows on its own while Alfred runs' },
    { id: 'capture', label: 'Captured with calls', hint: 'deleted with their call' },
    { id: 'work', label: 'Your work', hint: 'never removed automatically' },
    { id: 'relive', label: 'Relive & replay', hint: 'replay workflows and what their runs recorded' },
    { id: 'config', label: 'Configuration', hint: 'small, part of your setup' },
  ];

  readonly budget = computed(() => this.overview()?.budget ?? null);
  readonly budgetSet = computed(() => (this.budget()?.bytes ?? 0) > 0);
  readonly maxGb = computed(() => Math.max(MIN_GB, Math.floor((this.overview()?.maxBudgetBytes ?? 0) / GB)));

  /** The draft's ratios: "same history for all" is measured from the stores themselves. */
  readonly draftEffectiveRatios = computed<Record<StorageShare, number>>(() => {
    const o = this.overview();
    const split = this.draftSplit();
    if (split === 'even' && o) return evenRatios(o);
    if (split === 'custom') return ratiosOf({ split, ratios: this.draftRatios() });
    return ratiosOf({ split, ratios: {} });
  });
  readonly draftShares = computed(() => shareBytes(this.draftGb() * GB, { split: 'custom', ratios: this.draftEffectiveRatios() }));
  readonly draftOverflow = computed(() => {
    const o = this.overview();
    return o ? overflow(o, this.draftGb() * GB, { split: 'custom', ratios: this.draftEffectiveRatios() }) : [];
  });
  /** Runs the draft's "last N per cycle" would remove now - saving asks with an Undo when this is above 0. */
  readonly draftRunsRemoved = computed(() => {
    const keep = this.draftKeepRuns();
    return (this.overview()?.relive ?? []).reduce((a, c) => a + this.overKeep(c, keep), 0);
  });
  readonly draftChanged = computed(() => {
    const b = this.budget();
    if (!b || !b.bytes) return true;
    return Math.round(b.bytes / GB * 2) / 2 !== this.draftGb() || b.split !== this.draftSplit()
      || b.inboundMaxCalls !== this.draftInboundCalls() || b.outboundMaxCalls !== this.draftOutboundCalls()
      || b.reliveKeepRuns !== this.draftKeepRuns()
      || (b.maxAgeDays.inbound ?? 0) !== this.draftAges().inbound || (b.maxAgeDays.outbound ?? 0) !== this.draftAges().outbound
      || (b.maxAgeDays.reliveRuns ?? 0) !== this.draftAges().reliveRuns
      || (this.draftSplit() === 'custom' && JSON.stringify(ratiosOf(b)) !== JSON.stringify(ratiosOf({ split: 'custom', ratios: this.draftRatios() })))
      || this.rulesChanged();
  });

  readonly rulesChanged = computed(() => JSON.stringify({ ...DEFAULT_RULES, ...(this.budget()?.rules ?? {}) }) !== JSON.stringify(this.draftRules()));

  /** The bar: each share's part of the total used, live data only. */
  readonly usedBar = computed(() => {
    const o = this.overview();
    if (!o) return [];
    const total = SHARES.reduce((a, k) => a + (o.shareUsed[k] ?? 0), 0) + o.freeInsideBytes;
    if (total <= 0) return [];
    const parts = SHARES.map((k) => ({ key: k as string, label: SHARE_LABEL[k], color: SHARE_COLOR[k], bytes: o.shareUsed[k] ?? 0 }));
    parts.push({ key: 'empty', label: 'Empty space inside files', color: 'var(--text-faint)', bytes: o.freeInsideBytes });
    return parts.filter((p) => p.bytes > 0).map((p) => ({ ...p, pct: (p.bytes / total) * 100 }));
  });

  readonly diskPct = computed(() => {
    const o = this.overview();
    return o && o.disk.totalBytes > 0 ? (o.usedBytes / o.disk.totalBytes) * 100 : 0;
  });

  readonly usedOfBudgetPct = computed(() => {
    const o = this.overview();
    const b = this.budget();
    return o && b?.bytes ? Math.round(((o.usedBytes - o.freeInsideBytes) / b.bytes) * 100) : null;
  });

  readonly inboundHistory = computed(() => {
    const o = this.overview();
    const b = this.budget();
    if (!o || !b?.bytes) return null;
    return historyKept(o.shareBytes.inbound, growthPerDay(o, 'inbound'));
  });

  readonly draftInboundHistory = computed(() => {
    const o = this.overview();
    return o ? historyKept(this.draftShares().inbound, growthPerDay(o, 'inbound')) : null;
  });

  readonly freeable = computed(() => this.overview()?.freeInsideBytes ?? 0);

  readonly storesByGroup = computed(() => {
    const o = this.overview();
    if (!o) return [];
    return this.groups.map((g) => ({ ...g, stores: o.stores.filter((s) => s.group === g.id) })).filter((g) => g.stores.length);
  });

  readonly maxStoreBytes = computed(() => Math.max(1, ...(this.overview()?.stores ?? []).map((s) => s.sizeBytes)));

  readonly suggestions = computed<Suggestion[]>(() => {
    const o = this.overview();
    if (!o) return [];
    const out: Suggestion[] = [];
    if (!this.budgetSet()) {
      out.push({
        id: 'budget', tone: 'blue', title: 'No storage budget yet', gain: 0, action: `Set ${RECOMMENDED_GB} GB`,
        text: 'Each kind of data has its own limit today, and logs have none - together they can fill the disk.',
        run: () => this.pickBudget(RECOMMENDED_GB),
      });
    }
    for (const s of o.stores) {
      if (s.limitCalls && s.items >= s.limitCalls * 0.98) {
        out.push({
          id: 'full-' + s.id, tone: 'amber', title: `${s.name} are at their ${s.limitCalls.toLocaleString()}-call limit`, gain: 0,
          action: 'Change limit', run: () => this.tab.set('rules'),
          text: `Each new call deletes the oldest. The oldest kept is ${ageOf(s.oldest) || 'recent'} old.`,
        });
      } else if (s.limitBytes && liveBytes(s) >= s.limitBytes * 0.95) {
        out.push({
          id: 'full-' + s.id, tone: 'amber', title: `${s.name} use their whole share (${formatBytes(s.limitBytes)})`, gain: 0,
          action: 'Raise budget', run: () => this.scrollTo('st-budget'),
          text: 'The oldest are deleted as new ones arrive. A bigger budget keeps more history.',
        });
      }
    }
    const keep = o.budget.reliveKeepRuns;
    for (const c of o.relive) {
      const over = keep > 0 ? c.runs.slice(keep).filter((r) => r.status !== 'RUNNING').length : 0;
      if (over > 0) {
        out.push({
          id: 'relive-' + c.id, tone: 'blue', title: `${c.name} has ${c.runs.length} runs - ${over} beyond the last ${keep}`, gain: 0,
          action: `Keep last ${keep}`, run: () => this.keepLastRuns(keep),
          text: 'The cycle, its steps and variables stay. Only the oldest runs and their recordings go.',
        });
      }
    }
    return out;
  });

  readonly navCount = computed(() => this.suggestions().length + (this.freeable() > 50 * 1024 * 1024 ? 1 : 0));

  ngOnInit(): void {
    loadPageStyles(document);
    this.refresh();
    this.previewSub = this.previewAsk.pipe(
      debounceTime(250),
      switchMap((req) => {
        this.previewLoading.set(true);
        return this.api.cleanup(req, false);
      }),
    ).subscribe({
      next: (res) => {
        this.preview.set(res);
        this.previewLoading.set(false);
      },
      error: () => this.previewLoading.set(false),
    });
  }

  ngOnDestroy(): void {
    this.previewSub?.unsubscribe();
    clearInterval(this.undoTimer);
    clearTimeout(this.toastTimer);
  }

  refresh(): void {
    this.loading.set(true);
    this.api.overview().subscribe({
      next: (o) => this.loaded(o),
      error: (e) => {
        this.loading.set(false);
        this.error.set(this.messageOf(e));
      },
    });
  }

  private loaded(o: StorageOverview): void {
    this.overview.set(o);
    this.loading.set(false);
    this.error.set(null);
    const b = o.budget;
    if (b.bytes) {
      this.draftGb.set(Math.round(b.bytes / GB * 2) / 2);
      this.draftSplit.set(b.split);
      if (b.split === 'custom') this.draftRatios.set(ratiosOf(b));
    } else {
      this.draftGb.set(Math.min(RECOMMENDED_GB, Math.max(MIN_GB, Math.floor(o.maxBudgetBytes / GB))));
    }
    const inbound = o.stores.find((s) => s.id === 'inbound');
    this.draftInboundCalls.set(b.bytes ? b.inboundMaxCalls : inbound?.limitCalls ?? 0);
    this.draftOutboundCalls.set(b.outboundMaxCalls);
    this.draftKeepRuns.set(b.reliveKeepRuns);
    this.draftAges.set({ inbound: b.maxAgeDays.inbound ?? 0, outbound: b.maxAgeDays.outbound ?? 0, reliveRuns: b.maxAgeDays.reliveRuns ?? 0 });
    this.draftRules.set({ ...DEFAULT_RULES, ...(b.rules ?? {}) });
  }

  // ================================================================== budget

  /** A choice applies at once - unless it would delete data now, then it asks right there. */
  pickBudget(gb: number): void {
    const value = Math.max(MIN_GB, Math.min(this.maxGb(), Math.round(gb * 2) / 2));
    this.draftGb.set(value);
    this.customGbOpen.set(false);
    if (this.draftOverflow().length) {
      this.confirmShrink.set(value);
      return;
    }
    this.confirmShrink.set(null);
    this.saveBudget();
  }

  cancelShrink(): void {
    this.confirmShrink.set(null);
    const b = this.budget();
    this.draftGb.set(b?.bytes ? Math.round(b.bytes / GB * 2) / 2 : RECOMMENDED_GB);
  }

  setSplit(split: StorageSplit): void {
    if (split === 'custom') this.draftRatios.set({ ...this.draftEffectiveRatios() });
    this.draftSplit.set(split);
  }

  /**
   * Dragging the divider between two shares moves ratio from one to the other (switching to Custom); the budget stays
   * the same number. Every share keeps at least 1%.
   */
  startDrag(event: PointerEvent, index: number, bar: HTMLElement): void {
    event.preventDefault();
    if (this.draftSplit() !== 'custom') this.setSplit('custom');
    const left = SHARES[index];
    const right = SHARES[index + 1];
    const rect = bar.getBoundingClientRect();
    const start = { ...this.draftEffectiveRatios() };
    const before = SHARES.slice(0, index).reduce((a, k) => a + start[k], 0);
    const pair = start[left] + start[right];
    const move = (e: PointerEvent): void => {
      const at = Math.min(Math.max((e.clientX - rect.left) / rect.width, before + 0.01), before + pair - 0.01);
      this.draftRatios.set({ ...start, [left]: at - before, [right]: before + pair - at });
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** Where each divider sits on the split bar, in percent. */
  readonly dividers = computed(() => {
    const r = this.draftEffectiveRatios();
    let at = 0;
    return SHARES.slice(0, -1).map((k, i) => {
      at += r[k];
      return { index: i, pct: at * 100 };
    });
  });

  setRatio(share: StorageShare, percent: number): void {
    const next = { ...this.draftRatios(), [share]: Math.max(0, Number(percent) || 0) / 100 };
    this.draftRatios.set(next);
  }

  setAge(kind: 'inbound' | 'outbound' | 'reliveRuns', days: number): void {
    this.draftAges.set({ ...this.draftAges(), [kind]: Math.max(0, Number(days) || 0) });
  }

  ageDaysOf(kind: string): number {
    return this.draftAges()[kind as 'inbound' | 'outbound' | 'reliveRuns'] ?? 0;
  }

  num(value: unknown): number {
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  saveBudget(): void {
    const overs = this.draftOverflow();
    const runs = this.draftRunsRemoved();
    const run = (): void => {
      this.busy.set('budget');
      this.api.saveBudget(this.draftBudget()).subscribe({
        next: (o) => {
          this.busy.set(null);
          this.confirmShrink.set(null);
          this.loaded(o);
          this.say(`Budget set · Alfred stays under ${this.draftGb()} GB`);
        },
        error: (e) => {
          this.busy.set(null);
          this.say(this.messageOf(e));
        },
      });
    };
    if (overs.length || runs > 0) {
      const parts = [];
      if (overs.length) parts.push(`${formatBytes(overs.reduce((a, o) => a + o.bytes, 0))} of oldest data`);
      if (runs > 0) parts.push(`${runs} old Relive runs`);
      this.withUndo(`Saving - deletes ${parts.join(' and ')}`, run);
    } else {
      run();
    }
  }

  removeBudget(): void {
    this.busy.set('budget');
    this.api.saveBudget({ ...this.draftBudget(), bytes: null }).subscribe({
      next: (o) => {
        this.busy.set(null);
        this.loaded(o);
        this.say('Budget removed - each kind of data has its own limit again');
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  private draftBudget(): StorageBudget {
    const split = this.draftSplit();
    return {
      bytes: Math.round(this.draftGb() * GB),
      split,
      ratios: split === 'custom' || split === 'even' ? this.draftEffectiveRatios() : {},
      inboundMaxCalls: this.draftInboundCalls(),
      outboundMaxCalls: this.draftOutboundCalls(),
      reliveKeepRuns: this.draftKeepRuns(),
      maxAgeDays: { ...this.draftAges() },
      rules: { ...this.draftRules() },
    };
  }

  setRule<K extends keyof StorageRules>(key: K, value: StorageRules[K]): void {
    this.draftRules.set({ ...this.draftRules(), [key]: value });
  }

  /** The automatic rules apply with or without a budget: without one they save next to "no budget". */
  saveAutoRules(): void {
    if (this.budgetSet()) {
      this.saveBudget();
      return;
    }
    this.busy.set('budget');
    this.api.saveBudget({ ...this.draftBudget(), bytes: null }).subscribe({
      next: (o) => {
        this.busy.set(null);
        this.loaded(o);
        this.say('Rules saved');
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  shareName(share: StorageShare): string {
    return SHARE_LABEL[share].toLowerCase();
  }

  overflowTotal(): number {
    return this.draftOverflow().reduce((a, o) => a + o.bytes, 0);
  }

  historyOf(share: StorageShare, bytes: number): string {
    const o = this.overview();
    if (share === 'work') return 'never deleted';
    if (share === 'logs') return 'what you load';
    if (!o) return '';
    if (share === 'reliveRuns') {
      const runs = o.stores.find((s) => s.id === 'reliveRuns');
      const each = runs && runs.items ? runs.sizeBytes / runs.items : 0;
      return each > 0 ? `~${Math.floor(bytes / each).toLocaleString()} runs` : 'room for many runs';
    }
    const kept = historyKept(bytes, growthPerDay(o, share));
    return kept ? `${kept} of history` : 'not measured yet';
  }

  pct(n: number): number {
    return Math.round(n * 1000) / 10;
  }

  // ================================================================== tabs

  setTab(tab: Tab): void {
    this.tab.set(tab);
    if ((tab === 'biggest' || tab === 'history') && !this.insights() && !this.insightsLoading()) this.loadInsights();
    if (tab === 'backup') {
      if (!this.fileHealth()) this.loadFiles(false);
      if (!this.backups()) this.loadBackups();
    }
  }

  loadInsights(): void {
    this.insightsLoading.set(true);
    this.api.insights().subscribe({
      next: (i) => {
        this.insights.set(i);
        this.gone.set(new Set());
        this.insightsLoading.set(false);
      },
      error: (e) => {
        this.insightsLoading.set(false);
        this.say(this.messageOf(e));
      },
    });
  }

  // ================================================================== biggest

  readonly maxEndpointBytes = computed(() => Math.max(1, ...(this.insights()?.endpoints ?? []).map((g) => g.bytes)));
  readonly maxProjectBytes = computed(() => Math.max(1, ...(this.insights()?.projects ?? []).map((g) => g.bytes)));

  groupKey(g: InsightGroup): string {
    return `${g.direction} ${g.method ?? ''} ${g.path ?? g.project ?? ''}`;
  }

  /** "Delete these" / "Keep 1 of each": waits out the Undo, then deletes those exact calls (a comment keeps a call). */
  deleteGroup(g: InsightGroup, what: string): void {
    const key = this.groupKey(g);
    this.gone.set(new Set([...this.gone(), key]));
    this.withUndo(`Deleting ${g.ids.length.toLocaleString()} calls`, () => this.sendDelete(g.direction, g.ids, what), () => {
      const next = new Set(this.gone());
      next.delete(key);
      this.gone.set(next);
    });
  }

  deleteCall(c: InsightCall): void {
    this.gone.set(new Set([...this.gone(), c.id]));
    this.withUndo('Deleting 1 call', () => this.sendDelete(c.direction, [c.id], `${c.method} ${c.url}`), () => {
      const next = new Set(this.gone());
      next.delete(c.id);
      this.gone.set(next);
    });
  }

  deleteAllRepeats(): void {
    const all = this.insights()?.repeats ?? [];
    const inbound = all.filter((g) => g.direction === 'inbound').flatMap((g) => g.ids);
    const outbound = all.filter((g) => g.direction === 'outbound').flatMap((g) => g.ids);
    this.gone.set(new Set([...this.gone(), ...all.map((g) => this.groupKey(g))]));
    this.withUndo(`Removing ${(inbound.length + outbound.length).toLocaleString()} repeats`, () => {
      this.api.deleteCalls(inbound, outbound, 'repeats, newest of each kept').subscribe({
        next: (r) => this.afterDelete(r.count, r.kept),
        error: (e) => this.say(this.messageOf(e)),
      });
    }, () => this.gone.set(new Set()));
  }

  private sendDelete(direction: 'inbound' | 'outbound', ids: readonly string[], what: string): void {
    const call = direction === 'inbound' ? this.api.deleteCalls(ids, [], what) : this.api.deleteCalls([], ids, what);
    call.subscribe({
      next: (r) => this.afterDelete(r.count, r.kept),
      error: (e) => this.say(this.messageOf(e)),
    });
  }

  private afterDelete(count: number, kept: number): void {
    this.say(`Deleted ${count.toLocaleString()} calls${kept ? ` · ${kept} kept for their comments` : ''}`);
    this.refresh();
    this.loadInsights();
  }

  // ================================================================== space over time

  readonly chartDays = computed(() => {
    const days = this.insights()?.days ?? [];
    return days.slice(Math.max(0, days.length - this.range()));
  });
  readonly chartMax = computed(() => Math.max(1, ...this.chartDays().map((d) => d.inboundBytes + d.outboundBytes), this.insights()?.perDayBytes ?? 0));
  /** Striped bars: the next days at the recent rate. */
  readonly forecastBars = computed(() => Math.max(2, Math.round(this.range() / 4)));
  readonly forecastCols = computed(() => Array.from({ length: this.forecastBars() }, (_, i) => i));
  readonly backupChoices = [
    { id: 'traffic', label: 'Recorded traffic', hint: 'outbound + inbound calls, with DB statements and log lines' },
    { id: 'work', label: 'Your work', hint: 'session cycles, comments, Relive cycles and runs, scenarios' },
    { id: 'config', label: 'Configuration', hint: 'filters, profiles, redactions, rules, stored answers' },
    { id: 'logs', label: 'Logs Explorer sources', hint: 're-loadable from the log files' },
  ];
  readonly forecast = computed(() => {
    const i = this.insights();
    const o = this.overview();
    if (!i || !o || i.perDayBytes <= 0) return null;
    const perDay = i.perDayBytes;
    const b = this.budget();
    return {
      perDay,
      diskFullDays: o.disk.freeBytes > 0 ? Math.round(o.disk.freeBytes / perDay) : null,
      budgetFullDays: b?.bytes ? Math.max(0, Math.round((b.bytes - (o.usedBytes - o.freeInsideBytes)) / perDay)) : null,
    };
  });

  dayLabel(day: string): string {
    const d = new Date(day + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // ================================================================== stop recording

  /** "inbound GET http://host/path" - what the backend's recording rule matches (the URL without its query). */
  endpointKey(g: InsightGroup): string {
    return `${g.direction} ${(g.method ?? '').toUpperCase()} ${g.path ?? ''}`;
  }

  isStopped(g: InsightGroup): boolean {
    return (this.draftRules().stopRecording ?? []).includes(this.endpointKey(g));
  }

  /** New calls to this endpoint are not stored at all (forwarding is unaffected); what is stored stays until deleted. */
  stopRecording(g: InsightGroup): void {
    const key = this.endpointKey(g);
    this.draftRules.set({ ...this.draftRules(), stopRecording: [...new Set([...(this.draftRules().stopRecording ?? []), key])] });
    this.saveAutoRules();
  }

  recordAgain(key: string): void {
    this.draftRules.set({ ...this.draftRules(), stopRecording: (this.draftRules().stopRecording ?? []).filter((k) => k !== key) });
    this.saveAutoRules();
  }

  // ================================================================== export

  readonly exporting = signal(false);

  /** Opens Alfred's own .json export on exactly these calls (loaded in full first). */
  exportIds(direction: 'inbound' | 'outbound', ids: readonly string[]): void {
    if (!ids.length || this.exporting()) return;
    this.exporting.set(true);
    this.say(`Loading ${ids.length.toLocaleString()} calls for the export…`);
    this.exporter.exportCalls(direction, ids).subscribe({
      next: (n) => {
        this.exporting.set(false);
        if (!n) this.say('None of those calls are stored any more');
      },
      error: (e) => {
        this.exporting.set(false);
        this.say(this.messageOf(e));
      },
    });
  }

  /** "Export these first" in the clean-up dialog: exactly the calls the clean-up would delete. */
  exportCleanup(): void {
    const req = this.cleanup();
    const ids = this.preview()?.ids ?? [];
    if (req.kind !== 'inbound' && req.kind !== 'outbound') return;
    this.exportIds(req.kind, ids);
  }

  /** "Export all (.json)" on a store row: every call that store holds. */
  exportStore(kind: 'inbound' | 'outbound'): void {
    this.api.cleanup({ ...this.emptyCleanup(kind), keepCommented: false }, false).subscribe({
      next: (r) => this.exportIds(kind, r.ids ?? []),
      error: (e) => this.say(this.messageOf(e)),
    });
  }

  exportGroup(g: InsightGroup): void {
    this.exportIds(g.direction, g.ids);
  }

  // ================================================================== backup & files

  loadFiles(check: boolean): void {
    this.busy.set(check ? 'check' : null);
    this.api.files(check).subscribe({
      next: (f) => {
        this.fileHealth.set(f);
        this.checked.set(check);
        this.busy.set(null);
        if (check) {
          const bad = f.filter((x) => x.check !== 'ok');
          this.say(bad.length ? `${bad.length} file(s) report a problem` : `All ${f.length} files are healthy`);
        }
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  readonly walTotal = computed(() => (this.fileHealth() ?? []).reduce((a, f) => a + f.walBytes, 0));

  foldWal(): void {
    this.busy.set('wal');
    this.api.checkpoint().subscribe({
      next: (r) => {
        this.busy.set(null);
        this.say(r.freedBytes > 0 ? `Write logs folded in · ${formatBytes(r.freedBytes)} freed` : 'Write logs were already folded in');
        this.loadFiles(false);
        this.refresh();
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  loadBackups(): void {
    this.api.backups().subscribe({ next: (b) => this.backups.set(b), error: (e) => this.say(this.messageOf(e)) });
  }

  toggleBackupGroup(group: string): void {
    const next = new Set(this.backupGroups());
    if (next.has(group)) next.delete(group); else next.add(group);
    this.backupGroups.set(next);
  }

  /** What the chosen groups hold now - a backup is a compacted copy, so usually less. */
  readonly backupEstimate = computed(() => {
    const o = this.overview();
    if (!o) return 0;
    const groups = this.backupGroups();
    const byGroup: Record<string, string[]> = {
      traffic: ['inbound', 'outbound', 'capture', 'triage'], work: ['cycles', 'comments', 'relive', 'reliveHistory', 'reliveRuns', 'scenarios'],
      config: ['config'], logs: ['logs'],
    };
    return o.stores.filter((s) => [...groups].some((g) => byGroup[g]?.includes(s.id))).reduce((a, s) => a + liveBytes(s), 0);
  });

  backUp(): void {
    this.busy.set('backup');
    this.api.backUp([...this.backupGroups()]).subscribe({
      next: (b) => {
        this.busy.set(null);
        this.say('running' in b ? 'Still backing up in the background - it shows here when you open this tab again'
          : `Backup written: ${b.name} · ${formatBytes(b.bytes)}`);
        this.loadBackups();
        this.refresh();
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  backupUrl(name: string): string {
    return this.api.backupUrl(name);
  }

  deleteBackup(name: string): void {
    this.withUndo(`Deleting backup ${name}`, () => this.api.deleteBackup(name).subscribe({
      next: () => {
        this.loadBackups();
        this.refresh();
      },
      error: (e) => this.say(this.messageOf(e)),
    }));
  }

  restore(name: string): void {
    this.api.restore(name).subscribe({
      next: (r) => {
        this.say(`Restore ready: ${r.files.length} file(s) replace the current ones at the next start of Alfred`);
        this.loadBackups();
      },
      error: (e) => this.say(this.messageOf(e)),
    });
  }

  readonly uploadProgress = signal<number | null>(null);
  static readonly CHUNK = 8 * 1024 * 1024;

  /**
   * "Restore from a file": the .zip goes up in 8 MB raw chunks (each under the gateway's body limit), one after the
   * other, becomes a backup in data/backups, and is prepared for restore - it replaces the files at the next start.
   */
  uploadAndRestore(file: File | undefined | null): void {
    if (!file) return;
    const id = (crypto.randomUUID?.() ?? Math.random().toString(16).slice(2) + Date.now().toString(16)).toLowerCase();
    const total = file.size;
    const next = (offset: number): void => {
      const end = Math.min(total, offset + StorageSettingsComponent.CHUNK);
      this.uploadProgress.set(total ? Math.round((offset / total) * 100) : 0);
      this.api.uploadChunk(id, offset, total, file.slice(offset, end)).subscribe({
        next: (r) => {
          if ('name' in r) {
            this.uploadProgress.set(null);
            this.restore(r.name);
          } else {
            next(end);
          }
        },
        error: (e) => {
          this.uploadProgress.set(null);
          this.say(this.messageOf(e));
        },
      });
    };
    next(0);
  }

  cancelRestore(): void {
    this.api.cancelRestore().subscribe({ next: () => this.loadBackups(), error: (e) => this.say(this.messageOf(e)) });
  }

  copyPath(path: string): void {
    void navigator.clipboard?.writeText(path).then(() => this.say('Path copied'), () => this.say(path));
  }

  // ================================================================== free space

  freeAll(): void {
    this.busy.set('compact');
    this.api.compact().subscribe({
      next: (r) => {
        this.busy.set(null);
        this.say(r.running ? 'Still freeing space in the background - Measure again in a minute'
          : r.freedBytes > 0 ? `${formatBytes(r.freedBytes)} freed · nothing was deleted` : 'Nothing to free');
        this.refresh();
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  freeFile(file: string): void {
    this.busy.set('compact:' + file);
    this.api.compact(file).subscribe({
      next: (r) => {
        this.busy.set(null);
        this.say(r.running ? `Still freeing ${file} in the background` : `${formatBytes(r.freedBytes)} freed in ${file}`);
        this.refresh();
      },
      error: (e) => {
        this.busy.set(null);
        this.say(this.messageOf(e));
      },
    });
  }

  firstFile(store: StorageStore): string {
    return store.files.split(' ')[0];
  }

  // ================================================================== clean-up

  private emptyCleanup(kind: CleanupKind): CleanupRequest {
    return { kind, olderThanDays: null, project: null, status: '', urlContains: null, keepCommented: true, compactAfter: true };
  }

  openCleanup(kind: CleanupKind, olderThanDays: number | null = null): void {
    this.cleanup.set({ ...this.emptyCleanup(kind), olderThanDays });
    this.preview.set(null);
    this.cleanupOpen.set(true);
    this.previewAsk.next(this.cleanup());
  }

  editCleanup(patch: Partial<CleanupRequest>): void {
    this.cleanup.set({ ...this.cleanup(), ...patch });
    this.previewAsk.next(this.cleanup());
  }

  closeCleanup(): void {
    this.cleanupOpen.set(false);
  }

  runCleanup(): void {
    const req = this.cleanup();
    const count = this.preview()?.count ?? 0;
    this.cleanupOpen.set(false);
    this.withUndo(`Deleting ${count.toLocaleString()} ${this.kindLabel(req.kind)}`, () => {
      this.busy.set('cleanup');
      this.api.cleanup(req, true).subscribe({
        next: (r) => {
          this.busy.set(null);
          this.say(`Deleted ${r.count.toLocaleString()} ${this.kindLabel(r.kind)} · ~${formatBytes(r.bytes)}`);
          this.refresh();
        },
        error: (e) => {
          this.busy.set(null);
          this.say(this.messageOf(e));
        },
      });
    });
  }

  kindLabel(kind: CleanupKind): string {
    return { inbound: 'inbound calls', outbound: 'outbound calls', cycles: 'session cycles', reliveRuns: 'Relive runs' }[kind];
  }

  // ================================================================== relive

  overKeep(c: StorageReliveCycle, keep: number): number {
    return keep > 0 ? c.runs.slice(keep).filter((r) => r.status !== 'RUNNING' && !r.starred).length : 0;
  }

  runGoes(c: StorageReliveCycle, index: number, keep: number): boolean {
    return keep > 0 && index >= keep && c.runs[index].status !== 'RUNNING' && !c.runs[index].starred;
  }

  runOk(status: string): boolean {
    return status === 'COMPLETED';
  }

  /** A starred run is never deleted by a rule or a clean-up. */
  toggleStar(cycle: StorageReliveCycle, run: StorageRun): void {
    const starred = !run.starred;
    this.api.star(run.id, starred).subscribe({
      next: () => {
        const o = this.overview();
        if (!o) return;
        this.overview.set({
          ...o,
          relive: o.relive.map((c) => c.id !== cycle.id ? c : { ...c, runs: c.runs.map((r) => r.id === run.id ? { ...r, starred } : r) }),
        });
      },
      error: (e) => this.say(this.messageOf(e)),
    });
  }

  /** Keeps the newest runs of each cycle through a rules save (asks with an Undo); the backend owns the run list. */
  keepLastRuns(keep: number): void {
    this.draftKeepRuns.set(keep);
    this.saveRulesOnly();
  }

  deleteAllRuns(c: StorageReliveCycle): void {
    this.withUndo(`Deleting ${c.runs.length} runs of ${c.name} - the cycle stays`, () => {
      this.busy.set('cleanup');
      this.api.cleanup({ ...this.emptyCleanup('reliveRuns'), project: c.id }, true).subscribe({
        next: () => {
          this.busy.set(null);
          this.refresh();
        },
        error: (e) => {
          this.busy.set(null);
          this.say(this.messageOf(e));
        },
      });
    });
  }

  /** Saves the rules tab (call limits, ages, runs kept) with the budget as it is. */
  saveRulesOnly(): void {
    if (!this.budgetSet()) {
      this.say('Set a storage budget first - the rules apply inside it');
      return;
    }
    this.saveBudget();
  }

  // ================================================================== danger zone

  readonly dangerWord = computed(() => ({ outbound: 'delete outbound', inbound: 'delete inbound', cycles: 'delete cycles' })[this.dangerOpen() ?? 'outbound']);

  openDanger(kind: 'outbound' | 'inbound' | 'cycles'): void {
    this.dangerText.set('');
    this.dangerOpen.set(kind);
  }

  runDanger(): void {
    const kind = this.dangerOpen();
    if (!kind || this.dangerText().trim().toLowerCase() !== this.dangerWord()) return;
    this.dangerOpen.set(null);
    const label = { outbound: 'Deleting all outbound calls', inbound: 'Deleting all inbound calls and their captured data',
      cycles: 'Deleting all session cycles' }[kind];
    this.withUndo(label, () => {
      const call: Observable<unknown> =
        kind === 'outbound' ? this.api.clearOutbound() : kind === 'inbound' ? this.api.clearInbound() : this.api.clearCycles();
      call.subscribe({
        next: () => {
          this.say('Done');
          this.refresh();
        },
        error: (e: unknown) => this.say(this.messageOf(e)),
      });
    });
  }

  // ================================================================== helpers

  /** Every delete waits {@link UNDO_SECONDS} with an Undo before anything is sent. */
  withUndo(label: string, run: () => void, onUndo?: () => void): void {
    clearInterval(this.undoTimer);
    this.onUndo = onUndo;
    let left = UNDO_SECONDS;
    this.pending.set({ label, secondsLeft: left });
    this.undoTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(this.undoTimer);
        this.pending.set(null);
        run();
      } else {
        this.pending.set({ label, secondsLeft: left });
      }
    }, 1000);
  }

  private onUndo?: () => void;

  undo(): void {
    clearInterval(this.undoTimer);
    this.onUndo?.();
    this.onUndo = undefined;
    this.pending.set(null);
    this.confirmShrink.set(null);
    this.say('Cancelled - nothing was deleted');
  }

  say(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(null), 3000);
  }

  scrollTo(id: string): void {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  toggleStore(id: string): void {
    this.openStore.set(this.openStore() === id ? null : id);
  }

  limitPct(s: StorageStore): number | null {
    if (s.limitCalls) return Math.min(100, (s.items / s.limitCalls) * 100);
    if (s.limitBytes) return Math.min(100, (liveBytes(s) / s.limitBytes) * 100);
    return null;
  }

  live(s: StorageStore): number {
    return liveBytes(s);
  }

  private messageOf(e: unknown): string {
    const err = e as { error?: { message?: string }; message?: string };
    return err?.error?.message ?? err?.message ?? 'Something went wrong';
  }
}
