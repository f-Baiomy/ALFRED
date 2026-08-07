import { Component, computed, inject, input } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import {
  callKey,
  durationClass as durationClassOf,
  methodClass as methodClassOf,
  statusClass as statusClassOf,
} from '../../shared/utils/call-utils';
import { CallActionsComponent } from '../call-actions/call-actions.component';
import { JsonPanelComponent } from '../json-panel/json-panel.component';
import { CallsStateService } from '../../core/state/calls-state.service';

/** One logged request/response pair: selection checkbox, badges, from/to urls, actions, and the four Headers/Body panels. */
@Component({
  selector: 'app-call-card',
  standalone: true,
  imports: [CallActionsComponent, JsonPanelComponent],
  templateUrl: './call-card.component.html',
})
export class CallCardComponent {
  private readonly state = inject(CallsStateService);

  readonly call = input.required<CallRecord>();
  readonly pinned = input<boolean>(false);

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
}
