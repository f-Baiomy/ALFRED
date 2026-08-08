import { AfterViewInit, Component, ElementRef, OnDestroy, inject, input, viewChild } from '@angular/core';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { SortMode } from '../../core/models/call.model';

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
  templateUrl: './header.component.html',
})
export class HeaderComponent implements AfterViewInit, OnDestroy {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);

  readonly title = input('Manor');
  readonly subtitle = input('Live feed of every call Alfred intercepted, via pennyworth');

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
