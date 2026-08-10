import { Component, HostListener, computed, inject, input } from '@angular/core';
import { CdkDragHandle } from '@angular/cdk/drag-drop';
import { CallRecord } from '../../core/models/call.model';
import {
  callKey,
  durationClass as durationClassOf,
  methodClass as methodClassOf,
  statusClass as statusClassOf,
} from '../../shared/utils/call-utils';
import { CallActionsComponent } from '../call-actions/call-actions.component';
import { JsonPanelComponent } from '../json-panel/json-panel.component';
import { CALL_REMOVAL_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';

/** Clicking/dragging on these (or their descendants) must never toggle selection - they're either already-interactive controls or areas the user expects to select/copy text from. */
const SELECTION_EXEMPT_SELECTOR =
  'button, a, input, textarea, select, label, .uri-value, app-call-actions, app-json-panel, .drag-handle';

/** One logged request/response pair: selection checkbox, badges, from/to urls, actions, and the four Headers/Body panels. */
@Component({
  selector: 'app-call-card',
  standalone: true,
  imports: [CallActionsComponent, JsonPanelComponent, CdkDragHandle],
  templateUrl: './call-card.component.html',
})
export class CallCardComponent {
  private readonly state = inject(CALL_SELECTION_STATE);
  private readonly confirmDialog = inject(ConfirmDialogService);
  /** Non-null only where something binds CALL_REMOVAL_STATE (a session-cycle detail view) - drives whether the "Remove" button renders at all. */
  readonly removalState = inject(CALL_REMOVAL_STATE, { optional: true });

  readonly call = input.required<CallRecord>();
  readonly pinned = input<boolean>(false);
  /** True only when the parent CallListComponent has cdkDrag enabled on this card's host element
   * (a session-cycle detail page, ungrouped, with CALL_REORDER_STATE bound) - drives whether the
   * drag-handle grip icon renders at all. The dashboard never sets this. */
  readonly dragHandle = input<boolean>(false);

  readonly idBase = computed(() => callKey(this.call()));
  readonly methodClass = computed(() => methodClassOf(this.call().method));
  readonly statusClass = computed(() => statusClassOf(this.call().response?.status ?? null));
  readonly durationClass = computed(() => durationClassOf(this.call().duration_ms));
  readonly formattedTime = computed(() => {
    const ts = this.call().timestamp;
    return ts ? new Date(ts).toLocaleString() : '';
  });

  isSelected(): boolean {
    return this.state.isSelected(this.call());
  }

  toggleSelected(): void {
    this.state.toggleSelected(this.call());
  }

  async remove(): Promise<void> {
    if (!this.removalState) return;
    const confirmed = await this.confirmDialog.confirm('Remove this call from the cycle?', 'Remove');
    if (!confirmed) return;
    this.removalState.remove(this.call());
  }

  /**
   * Clicking anywhere on the card outside an interactive control toggles
   * its selection, and dragging from there across other cards paints the
   * same selection state onto each one - the checkbox stays as a small,
   * precise alternative to this larger "click the row" target.
   */
  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(SELECTION_EXEMPT_SELECTOR)) return;

    event.preventDefault();
    this.state.startDragSelect(this.call());
  }

  @HostListener('mouseenter')
  onMouseEnter(): void {
    this.state.dragSelectOver(this.call());
  }

  @HostListener('window:mouseup')
  onWindowMouseUp(): void {
    this.state.endDragSelect();
  }
}
