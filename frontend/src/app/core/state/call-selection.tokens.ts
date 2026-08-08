import { InjectionToken, Signal } from '@angular/core';
import { CallRecord } from '../models/call.model';
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
}

export const CALL_REMOVAL_STATE = new InjectionToken<CallRemovalState>('CALL_REMOVAL_STATE');

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
}

export const CALL_LIST_CONTROLS_STATE = new InjectionToken<CallListControlsState>('CALL_LIST_CONTROLS_STATE');
