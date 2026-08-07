import { Component, inject } from '@angular/core';
import { CallsStateService } from '../../core/state/calls-state.service';
import { SortMode } from '../../core/models/call.model';

@Component({
  selector: 'app-header',
  standalone: true,
  templateUrl: './header.component.html',
})
export class HeaderComponent {
  readonly state = inject(CallsStateService);

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
