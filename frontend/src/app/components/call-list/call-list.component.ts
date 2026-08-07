import { Component, computed, inject } from '@angular/core';
import { CallsStateService } from '../../core/state/calls-state.service';
import { callKey } from '../../shared/utils/call-utils';
import { CallCardComponent } from '../call-card/call-card.component';
import { SupplierGroupComponent } from '../supplier-group/supplier-group.component';

/** Pinned section + either the flat paginated list or the grouped-by-supplier view. */
@Component({
  selector: 'app-call-list',
  standalone: true,
  imports: [CallCardComponent, SupplierGroupComponent],
  templateUrl: './call-list.component.html',
})
export class CallListComponent {
  readonly state = inject(CallsStateService);

  readonly trackByCallKey = callKey;

  readonly pinnedCalls = computed(() => [...this.state.pinned().values()]);
  readonly hasAnyData = computed(() => this.state.calls().length > 0 || this.pinnedCalls().length > 0);

  loadMore(): void {
    this.state.loadMore();
  }
}
