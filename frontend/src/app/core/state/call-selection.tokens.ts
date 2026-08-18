import { InjectionToken, Signal } from '@angular/core';
import { Observable } from 'rxjs';
import { CallDetail, CallEndpointSource, CallRecord } from '../models/call.model';
import { CallListView } from './call-list-view';

/**
 * The per-card selection surface CallCardComponent needs (checkbox/drag-select). Injected via a
 * token rather than the concrete CallsStateService so the same component renders both on the
 * main dashboard and inside a session-cycle detail view, each backed by its own selection state.
 */
export interface CallSelectionState {
  isSelected(call: CallRecord): boolean;
  toggleSelected(call: CallRecord): void;
  startDragSelect(call: CallRecord): void;
  dragSelectOver(call: CallRecord): void;
  endDragSelect(): void;
}

/** The bulk-selection surface BulkActionsBarComponent needs, for the same reason as above. */
export interface BulkSelectionState {
  selectedCalls(): readonly CallRecord[];
  selectAll(): void;
  clearSelection(): void;
}

export const CALL_SELECTION_STATE = new InjectionToken<CallSelectionState>('CALL_SELECTION_STATE');
export const BULK_SELECTION_STATE = new InjectionToken<BulkSelectionState>('BULK_SELECTION_STATE');

/**
 * Optional per-card removal surface - CallCardComponent injects this with `optional: true` and
 * only renders a "Remove" button when something provides it. The dashboard never binds this
 * token (nothing there is removable), so the button never appears there; SessionCycleDetailComponent
 * binds it to SessionCycleDetailStateService, so it appears on every card in a cycle detail view
 * with zero changes to CallListComponent/SupplierGroupComponent in between.
 */
export interface CallRemovalState {
  remove(call: CallRecord): void;
  /** Bulk counterpart to remove() - one request instead of one per call, for BulkActionsBarComponent's "Remove selected". */
  removeMany(calls: readonly CallRecord[]): void;
}

export const CALL_REMOVAL_STATE = new InjectionToken<CallRemovalState>('CALL_REMOVAL_STATE');

/**
 * Optional per-list drag-and-drop reordering surface, same "only some pages provide it" shape as
 * CallRemovalState above. Only SessionCycleDetailComponent binds this token - the dashboard never
 * does, so CallListComponent/CallCardComponent never render a drag handle or enable CDK's
 * cdkDropList/cdkDrag there, and HeaderComponent never offers the "Custom order" sort option
 * there either. `dragEnabled` is false while grouped by supplier, since reordering across group
 * boundaries has no defined meaning.
 */
export interface CallReorderState {
  readonly dragEnabled: Signal<boolean>;
  reorder(orderedCalls: readonly CallRecord[]): void;
}

export const CALL_REORDER_STATE = new InjectionToken<CallReorderState>('CALL_REORDER_STATE');

/**
 * The search/sort/filter/group/paginate/stats surface HeaderComponent, StatsBarComponent, and
 * CallListComponent need - the entire `CallListView` shape plus `error`/`refreshNow`, which are
 * specific to how each concrete state fetches its raw calls rather than derived from them.
 * Injected via a token for the same reason as the two above: the dashboard and a session-cycle
 * detail view share these three components verbatim, backed by different state.
 */
export interface CallListControlsState extends CallListView {
  readonly error: Signal<string | null>;
  /** Every call in scope, before search/supplier filtering - used for the "All suppliers (N)" option's count. */
  readonly calls: Signal<readonly CallRecord[]>;
  refreshNow(): void;
  /**
   * The full request/response for one call, fetched only once it's actually expanded - and always
   * via a real network call, never from a cache, even if this same call's detail was already
   * fetched earlier (this session or otherwise), so it's never possible for a stale/leftover
   * hydration (e.g. from exporting or duplicating-to-cycles) to make a later expand skip the
   * request. Each concrete state knows which endpoint to hit - the dashboard's GET
   * /calls/{id}/detail, or a session-cycle's GET /session-cycles/{id}/calls/{callId}/detail - so
   * CallCardComponent doesn't need to know or care which context it's rendering in. `source`
   * (a CallRecord's own stamped source, see its doc) picks /calls vs /internal-calls on the
   * dashboard; session-cycles' implementation ignores it (it never captures 'internal' calls).
   */
  getCallDetail(callId: string, source?: CallEndpointSource): Observable<CallDetail>;
}

export const CALL_LIST_CONTROLS_STATE = new InjectionToken<CallListControlsState>('CALL_LIST_CONTROLS_STATE');
