import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, input, viewChild } from '@angular/core';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE } from '../../core/state/call-selection.tokens';
import { SortMode } from '../../core/models/call.model';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';

const LIMIT_OPTIONS: readonly SelectOption[] = [
  { value: '20', label: 'Last 20' },
  { value: '50', label: 'Last 50' },
  { value: '100', label: 'Last 100' },
  { value: '200', label: 'Last 200' },
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
  imports: [SelectPickerComponent],
  templateUrl: './header.component.html',
})
export class HeaderComponent implements AfterViewInit, OnDestroy {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  /** Non-null only on a session-cycle detail page - drives whether "Custom order" appears in the
   * sort dropdown at all. The dashboard never binds this token, so it never sees that option. */
  private readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });

  readonly title = input('ALFRED');
  readonly subtitle = input('Live feed of every call Alfred intercepted, via backend');

  readonly limitOptions = LIMIT_OPTIONS;
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

  onSupplierChange(value: string): void {
    this.state.setSupplierFilter(value);
  }

  toggleGroupBySupplier(): void {
    this.state.toggleGroupBySupplier();
  }

  toggleExpanded(): void {
    this.state.toggleExpanded();
  }

  refreshNow(): void {
    this.state.refreshNow();
  }
}
