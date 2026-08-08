import { Component, computed, inject } from '@angular/core';
import { CALL_LIST_CONTROLS_STATE } from '../../core/state/call-selection.tokens';
import { PinService } from '../../core/services/pin.service';
import { callKey } from '../../shared/utils/call-utils';
import { CallCardComponent } from '../call-card/call-card.component';
import { SupplierGroupComponent } from '../supplier-group/supplier-group.component';

/**
 * Pinned section + either the flat paginated list or the grouped-by-supplier view. Reused
 * verbatim on both the dashboard and a session-cycle detail page (see CALL_LIST_CONTROLS_STATE).
 * Pins come straight from PinService rather than through that token - pinning is global and
 * content-keyed (by callKey), not scoped to whichever list happens to be showing a call.
 */
@Component({
  selector: 'app-call-list',
  standalone: true,
  imports: [CallCardComponent, SupplierGroupComponent],
  templateUrl: './call-list.component.html',
})
export class CallListComponent {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  private readonly pinService = inject(PinService);

  readonly trackByCallKey = callKey;

  readonly pinnedCalls = computed(() => [...this.pinService.pinned().values()]);
  readonly hasAnyData = computed(() => this.state.calls().length > 0 || this.pinnedCalls().length > 0);

  loadMore(): void {
    this.state.loadMore();
  }
}
