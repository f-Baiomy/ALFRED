import { Component, computed, inject, input } from '@angular/core';
import { CallRecord } from '../../core/models/call.model';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CALL_ORIGIN, LIVE_ORIGIN_LABEL } from '../../core/state/call-origin.token';

/**
 * The Pick button a call gets while something is picking (see CallPickerService). Renders nothing
 * otherwise. Drop it next to any call to make that call pickable - every call card already has one
 * through CallActionsComponent, so a new list built from `app-call-card` needs nothing extra.
 */
@Component({
  selector: 'app-pick-call',
  standalone: true,
  template: `
    @if (picker.active()) {
      <button
        type="button"
        class="pick-call-btn"
        [class.picked]="picked()"
        [disabled]="refusal() !== null"
        [attr.aria-pressed]="picked()"
        [title]="refusal() ?? (picked() ? 'Picked - press again to unpick' : 'Pick this call')"
        (click)="toggle($event)"
      >
        {{ picked() ? '✓ Picked' : 'Pick' }}
      </button>
    }
  `,
})
export class PickCallButtonComponent {
  readonly picker = inject(CallPickerService);
  private readonly origin = inject(CALL_ORIGIN, { optional: true });

  readonly call = input.required<CallRecord>();

  private readonly cycleId = computed(() => this.origin?.cycleId() ?? null);
  readonly picked = computed(() => this.picker.isPicked(this.call(), this.cycleId()));
  readonly refusal = computed(() => this.picker.refusal(this.call(), this.cycleId()));

  toggle(event: Event): void {
    // A card or waterfall row reacts to clicks itself - picking must not also expand or select it.
    event.stopPropagation();
    this.picker.toggle(this.call(), this.cycleId(), this.origin?.label() ?? LIVE_ORIGIN_LABEL);
  }
}
