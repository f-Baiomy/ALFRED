import { Component, inject, input } from '@angular/core';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { SortMode } from '../../core/models/call.model';

/** Search/limit/sort/supplier-filter/group/collapse/refresh controls, reused verbatim on both the dashboard and a session-cycle detail page - only the brand/subtitle text differs between the two. */
@Component({
  selector: 'app-header',
  standalone: true,
  templateUrl: './header.component.html',
})
export class HeaderComponent {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);

  readonly title = input('Manor');
  readonly subtitle = input('Live feed of every call Alfred intercepted, via pennyworth');

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
