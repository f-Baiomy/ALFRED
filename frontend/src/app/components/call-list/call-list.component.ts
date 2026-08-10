import { Component, computed, inject } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { CALL_LIST_CONTROLS_STATE, CALL_REORDER_STATE } from '../../core/state/call-selection.tokens';
import { CallRecord } from '../../core/models/call.model';
import { PinService } from '../../core/services/pin.service';
import { callKey } from '../../shared/utils/call-utils';
import { CallCardComponent } from '../call-card/call-card.component';
import { SupplierGroupComponent } from '../supplier-group/supplier-group.component';

/**
 * Pinned section + either the flat paginated list or the grouped-by-supplier view. Reused
 * verbatim on both the dashboard and a session-cycle detail page (see CALL_LIST_CONTROLS_STATE).
 * Pins come straight from PinService rather than through that token - pinning is global and
 * content-keyed (by callKey), not scoped to whichever list happens to be showing a call.
 *
 * Drag-and-drop reordering (CALL_REORDER_STATE) only ever applies to the flat, ungrouped list -
 * the grouped-by-supplier view has no defined meaning for "move this call to position N" across
 * group boundaries, so dragEnabled() (and therefore cdkDropList/cdkDrag) is always false there
 * regardless of what the token itself reports.
 */
@Component({
  selector: 'app-call-list',
  standalone: true,
  imports: [CallCardComponent, SupplierGroupComponent, CdkDropList, CdkDrag],
  templateUrl: './call-list.component.html',
})
export class CallListComponent {
  readonly state = inject(CALL_LIST_CONTROLS_STATE);
  private readonly pinService = inject(PinService);
  /** Non-null only on a session-cycle detail page - see CALL_REORDER_STATE. */
  private readonly reorderState = inject(CALL_REORDER_STATE, { optional: true });

  readonly trackByCallKey = callKey;

  readonly pinnedCalls = computed(() => [...this.pinService.pinned().values()]);
  readonly hasAnyData = computed(() => this.state.calls().length > 0 || this.pinnedCalls().length > 0);
  readonly dragEnabled = computed(() => !this.state.groupBySupplier() && (this.reorderState?.dragEnabled() ?? false));

  loadMore(): void {
    this.state.loadMore();
  }

  onDrop(event: CdkDragDrop<readonly CallRecord[]>): void {
    if (!this.reorderState || event.previousIndex === event.currentIndex) return;
    const reordered = [...this.state.visibleCalls()];
    moveItemInArray(reordered, event.previousIndex, event.currentIndex);
    this.reorderState.reorder(reordered);
  }
}
