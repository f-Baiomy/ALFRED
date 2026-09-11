import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, input, output, viewChild } from '@angular/core';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE } from '../../core/state/call-selection.tokens';
import { SortMode, SourceKey } from '../../core/models/call.model';
import { InternalCallServiceDto } from '../../core/services/internal-logging-api.service';
import { CallViewMode } from '../../shared/utils/call-tree';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';
import { SourcesBarComponent } from '../sources-bar/sources-bar.component';

const LIMIT_OPTIONS: readonly SelectOption[] = [
  { value: '10', label: '10 per page' },
  { value: '25', label: '25 per page' },
  { value: '50', label: '50 per page' },
  { value: '100', label: '100 per page' },
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

/** The three call views - see CallViewMode. 'flat-depth' leads because it's the default and the
 * only one that works under every sort mode. */
const VIEW_MODE_OPTIONS: readonly SelectOption[] = [
  { value: 'flat-depth', label: 'Flat + depth' },
  { value: 'nested', label: 'Nested' },
  { value: 'waterfall', label: 'Waterfall' },
];

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
  imports: [SelectPickerComponent, SourcesBarComponent],
  templateUrl: './header.component.html',
})
export class HeaderComponent implements AfterViewInit, OnDestroy {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  /** Non-null only on a session-cycle detail page - drives whether "Custom order" appears in the
   * sort dropdown at all. The dashboard never binds this token, so it never sees that option. */
  private readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });

  readonly title = input('ALFRED');
  readonly subtitle = input('Live feed of every call Alfred intercepted, via backend');

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
  readonly sortOptions = computed<readonly SelectOption[]>(() =>
    this.reorderState ? [...SORT_OPTIONS, { value: 'custom', label: 'Custom order' }] : SORT_OPTIONS
  );

  readonly supplierOptions = computed<SelectOption[]>(() => [
    { value: '', label: `All suppliers (${this.state.calls().length})` },
    ...this.state.supplierOptions().map((s) => ({ value: s.name, label: `${s.name} (${s.count})` })),
  ]);

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

  toggleExpanded(): void {
    this.state.toggleExpanded();
  }

  refreshNow(): void {
    this.state.refreshNow();
  }
}
