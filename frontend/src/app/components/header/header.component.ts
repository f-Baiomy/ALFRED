import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE } from '../../core/state/call-selection.tokens';
import { SortMode, SourceKey } from '../../core/models/call.model';
import { InternalCallServiceDto } from '../../core/services/internal-logging-api.service';
import { CallViewMode, requiresChronologicalSort } from '../../shared/utils/call-tree';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';
import { SourcesBarComponent } from '../sources-bar/sources-bar.component';
import { ActionMenuComponent } from '../action-menu/action-menu.component';
import { ALL_INTERCEPTION_FILTER, InterceptionRuleOption, ResendFilter } from '../../core/state/call-list-view';

/** Short labels: this sits in a single-row toolbar, where "200 per page" costs width the search box
 * wants. The dropdown's own options spell it out. */
const LIMIT_OPTIONS: readonly SelectOption[] = [
  { value: '10', label: '10 / page' },
  { value: '25', label: '25 / page' },
  { value: '50', label: '50 / page' },
  { value: '100', label: '100 / page' },
  { value: '200', label: '200 / page' },
];

const SORT_OPTIONS: readonly SelectOption[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'newest-call', label: 'Newest call first' },
  { value: 'oldest-call', label: 'Oldest call first' },
  { value: 'slowest', label: 'Slowest first' },
  { value: 'fastest', label: 'Fastest first' },
  { value: 'status', label: 'Status (worst first)' },
];

/** The three call views - see CallViewMode. 'waterfall' leads because it's the default. Rendered as a segmented control rather than a
 * dropdown: three mutually-exclusive views you flip between while comparing cost two clicks each
 * from inside a menu, and one from a segment. */
const VIEW_MODE_OPTIONS: readonly (SelectOption & { icon: string })[] = [
  { value: 'waterfall', label: 'Waterfall', icon: '≋' },
  { value: 'nested', label: 'Nested', icon: '⊟' },
  { value: 'flat-depth', label: 'Flat', icon: '☰' },
];

type ActiveFilterKey = 'supplier' | 'session' | 'operation' | 'request' | 'nested' | 'interception' | 'resend' | 'db' | 'logs' | 'logwarn' | 'redis';

interface ActiveFilter {
  readonly key: ActiveFilterKey;
  readonly label: string;
}

/**
 * Search/limit/sort/supplier-filter/group/collapse/refresh controls, reused verbatim on both the
 * dashboard and a session-cycle detail page - only the brand/subtitle text differs between the two.
 *
 * Publishes its own rendered height as the `--header-height` CSS custom property (on
 * `document.documentElement`) via a `ResizeObserver`, since this header is `position: sticky` and
 * `BulkActionsBarComponent` needs to stick just below it rather than at `top: 0` too - two sticky
 * siblings both pinned to the same offset means the second one sticks *underneath* the first
 * (higher z-index) once scrolled, not below it. The header's height isn't a fixed constant (its
 * `.controls` row wraps at narrow widths, and `title()`/`subtitle()` text length varies), so this
 * is measured rather than hardcoded.
 */
@Component({
  selector: 'app-header',
  standalone: true,
  imports: [SelectPickerComponent, SourcesBarComponent, ActionMenuComponent],
  templateUrl: './header.component.html',
})
export class HeaderComponent implements AfterViewInit, OnDestroy {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  /** Non-null only on a session-cycle detail page - drives whether "Custom order" appears in the
   * sort dropdown at all. The dashboard never binds this token, so it never sees that option. */
  private readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });

  readonly title = input('Live calls');
  readonly subtitle = input('Every call Alfred intercepted, via backend');

  /** When the newest call in the list started, as a clock time - a fixed time rather than "4 s ago", which would
   * need a ticking timer just to repaint itself. */
  readonly lastCallAt = computed(() => {
    let newest = 0;
    for (const call of this.state.calls()) newest = Math.max(newest, Date.parse(call.timestamp) || 0);
    return newest ? new Date(newest).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null;
  });

  /** "Newest first · 200" - order and page size share one button. */
  readonly orderLabel = computed(() => {
    const sort = this.sortOptions().find((o) => o.value === this.state.sortMode())?.label ?? 'Order';
    return `${sort} · ${this.state.limit()}`;
  });

  /** Fold all / Unfold all as one button: what it did last decides what it does next. */
  readonly folded = signal(false);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  /**
   * The Sources bar's own state - both pages (dashboard and a session-cycle detail view) bind
   * these, each to their own state service's identically-shaped selectedSources/internalServices/
   * inboundLoggingFeatureEnabled/toggleSource/toggleServiceLogging (see CallsStateService's docs).
   */
  readonly selectedSources = input<ReadonlySet<SourceKey>>(new Set());
  readonly internalServices = input<readonly InternalCallServiceDto[]>([]);
  readonly inboundLoggingFeatureEnabled = input(false);
  readonly toggleSource = output<SourceKey>();
  readonly toggleServiceLogging = output<{ name: string; enabled: boolean }>();

  readonly limitOptions = LIMIT_OPTIONS;
  readonly viewModeOptions = VIEW_MODE_OPTIONS;
  /** Nested and waterfall both draw the tree, so both can fold - see CallViewMode. */
  readonly isTreeView = computed(() => requiresChronologicalSort(this.state.viewMode()));
  readonly sortOptions = computed<readonly SelectOption[]>(() =>
    this.reorderState ? [...SORT_OPTIONS, { value: 'custom', label: 'Custom order' }] : SORT_OPTIONS
  );

  readonly supplierOptions = computed<SelectOption[]>(() => [
    { value: '', label: `All suppliers (${this.state.calls().length})` },
    ...this.state.supplierOptions().map((s) => ({ value: s.name, label: `${s.name} (${s.count})` })),
  ]);

  /**
   * The filters currently narrowing the list, as removable chips.
   *
   * Only things that actually hide calls count here - not the search box (it shows its own text),
   * and not group-by-supplier or show-OPTIONS, which change presentation rather than what matches.
   * Without this, a filter typed once and forgotten silently explains an empty list, since the ID
   * fields now live behind a popover instead of sitting permanently on screen.
   *
   * "Only nested" earns a chip on exactly that test: it lives behind the same overflow menu as
   * show-OPTIONS but, unlike it, removes calls - and it can easily remove most of them.
   */
  readonly activeFilters = computed<readonly ActiveFilter[]>(() => {
    const chips: ActiveFilter[] = [];
    const supplier = this.state.supplierFilter();
    if (supplier) chips.push({ key: 'supplier', label: `Supplier: ${supplier}` });
    const session = this.state.sessionIdFilter();
    if (session) chips.push({ key: 'session', label: `Session: ${session}` });
    const operation = this.state.operationIdFilter();
    if (operation) chips.push({ key: 'operation', label: `Operation: ${operation}` });
    const request = this.state.requestIdFilter();
    if (request) chips.push({ key: 'request', label: `Request: ${request}` });
    if (this.state.nestedOnly()) chips.push({ key: 'nested', label: 'Only calls with nested calls' });
    const interception = this.state.interceptionFilter();
    if (interception.kind === 'intercepted') chips.push({ key: 'interception', label: 'Intercepted' });
    else if (interception.kind === 'untouched') chips.push({ key: 'interception', label: 'Untouched only' });
    else if (interception.kind === 'rule') chips.push({ key: 'interception', label: `Rule: ${interception.ruleName}` });
    const resend = this.state.resendFilter();
    if (resend === 'resent') chips.push({ key: 'resend', label: 'Resent calls' });
    else if (resend === 'originals') chips.push({ key: 'resend', label: 'Originals that were resent' });
    if (this.state.dbFailureFilter()) chips.push({ key: 'db', label: 'Has DB failures' });
    if (this.state.logErrorFilter()) chips.push({ key: 'logs', label: 'Has log errors' });
    if (this.state.logWarnFilter()) chips.push({ key: 'logwarn', label: 'Has log warnings' });
    if (this.state.redisFailureFilter()) chips.push({ key: 'redis', label: 'Has Redis failures' });
    return chips;
  });

  clearFilter(key: ActiveFilterKey): void {
    switch (key) {
      case 'supplier':
        this.state.setSupplierFilter('');
        return;
      case 'session':
        this.state.setSessionIdFilter('');
        return;
      case 'operation':
        this.state.setOperationIdFilter('');
        return;
      case 'request':
        this.state.setRequestIdFilter('');
        return;
      case 'nested':
        this.state.setNestedOnly(false);
        return;
      case 'interception':
        this.state.setInterceptionFilter(ALL_INTERCEPTION_FILTER);
        return;
      case 'resend':
        this.state.setResendFilter('all');
        return;
      case 'db':
        this.state.setDbFailureFilter(false);
        return;
      case 'logs':
        this.state.setLogErrorFilter(false);
        return;
      case 'logwarn':
        this.state.setLogWarnFilter(false);
        return;
      case 'redis':
        this.state.setRedisFailureFilter(false);
        return;
    }
  }

  /** Whether the Filters menu's Intercepted/Untouched buttons should read as active - a 'rule'
   * filter is a THIRD, distinct kind (unlike the stats-bar pill, which treats it as "intercepted"
   * for its own single toggle), so neither button lights up while a specific rule is selected. */
  isInterceptionKind(kind: 'intercepted' | 'untouched'): boolean {
    return this.state.interceptionFilter().kind === kind;
  }

  setInterceptionKind(kind: 'intercepted' | 'untouched'): void {
    this.state.setInterceptionFilter({ kind });
  }

  isRuleFilter(ruleId: string): boolean {
    const filter = this.state.interceptionFilter();
    return filter.kind === 'rule' && filter.ruleId === ruleId;
  }

  setRuleFilter(rule: InterceptionRuleOption): void {
    this.state.setInterceptionFilter({ kind: 'rule', ruleId: rule.ruleId, ruleName: rule.ruleName });
  }

  setResendKind(kind: ResendFilter): void {
    this.state.setResendFilter(kind);
  }

  toggleFold(): void {
    if (this.folded()) this.state.unfoldAll();
    else this.state.foldAll();
    this.folded.update((f) => !f);
  }

  /** "/" anywhere outside a text field jumps to the search box. */
  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
    if (document.querySelector('.dialog-backdrop, .board-drawer')) return;
    event.preventDefault();
    this.searchInput()?.nativeElement.focus();
  }

  clearAllFilters(): void {
    this.activeFilters().forEach((filter) => this.clearFilter(filter.key));
  }

  private readonly headerEl = viewChild.required<ElementRef<HTMLElement>>('headerEl');
  private resizeObserver: ResizeObserver | undefined;

  ngAfterViewInit(): void {
    const element = this.headerEl().nativeElement;
    const updateHeight = () => {
      document.documentElement.style.setProperty('--header-height', `${element.offsetHeight}px`);
    };
    updateHeight();
    this.resizeObserver = new ResizeObserver(updateHeight);
    this.resizeObserver.observe(element);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  onSearchInput(value: string): void {
    this.state.setSearchQuery(value);
  }

  onLimitChange(value: string): void {
    this.state.setLimit(Number(value));
  }

  onSortChange(value: string): void {
    this.state.setSortMode(value as SortMode);
  }

  /** Picking a tree view may also move the sort back to chronological - see setViewMode's doc on
   * CallListView. The sort dropdown re-renders from state.sortMode(), so it follows along by itself. */
  onViewModeChange(value: string): void {
    this.state.setViewMode(value as CallViewMode);
  }

  onSupplierChange(value: string): void {
    this.state.setSupplierFilter(value);
  }

  onToggleSource(key: SourceKey): void {
    this.toggleSource.emit(key);
  }

  onToggleServiceLogging(event: { name: string; enabled: boolean }): void {
    this.toggleServiceLogging.emit(event);
  }

  onSessionIdInput(value: string): void {
    this.state.setSessionIdFilter(value);
  }

  onOperationIdInput(value: string): void {
    this.state.setOperationIdFilter(value);
  }

  onRequestIdInput(value: string): void {
    this.state.setRequestIdFilter(value);
  }

  toggleGroupBySupplier(): void {
    this.state.toggleGroupBySupplier();
  }

  toggleShowOptionsCalls(): void {
    this.state.toggleShowOptionsCalls();
  }

  toggleNestedOnly(): void {
    this.state.setNestedOnly(!this.state.nestedOnly());
  }

  toggleExpanded(): void {
    this.state.toggleExpanded();
  }

  refreshNow(): void {
    this.state.refreshNow();
  }
}
