import { Component, inject } from '@angular/core';
import { CallPickerService } from '../../core/services/call-picker.service';
import { CallRecord } from '../../core/models/call.model';

/**
 * The floating bar shown while picking: what the pick is for, what has been picked and from where,
 * Cancel and Return. Mounted once in the main layout so it follows the user across every tab.
 */
@Component({
  selector: 'app-pick-bar',
  standalone: true,
  template: `
    @if (picker.request(); as request) {
      <div class="pick-bar" role="region" aria-label="Picking a call">
        <div class="pick-bar-head">
          <span class="pick-bar-title">Picking: {{ request.title }}</span>
          <span class="pick-bar-hint">{{ request.mode === 'multi' ? 'pick any number' : 'pick one' }} · switch tabs freely</span>
          <span class="pick-bar-spacer"></span>
          <button type="button" class="pill" (click)="picker.cancel()">Cancel</button>
          <button type="button" class="pill on" [disabled]="picker.picked().length === 0" (click)="picker.finish()">
            Return to {{ request.returnLabel }}{{ picker.picked().length > 1 ? ' (' + picker.picked().length + ')' : '' }}
          </button>
        </div>
        <div class="pick-bar-items">
          @for (p of picker.picked(); track p.ref.source + p.ref.callId + p.ref.cycleId) {
            <span class="pick-bar-chip">
              <b>{{ p.call.method }}</b>
              @if (p.call.response?.status != null) {
                <span class="pick-bar-status">{{ p.call.response!.status }}</span>
              }
              <span class="pick-bar-url" [title]="p.call.url">{{ shortUrl(p.call) }}</span>
              <span class="pick-bar-origin">· {{ p.originLabel }}</span>
              <button type="button" class="pick-bar-remove" aria-label="Unpick" (click)="picker.remove(p.ref)">✕</button>
            </span>
          } @empty {
            <span class="pick-bar-hint">Nothing picked yet. Press Pick on any call - in Live Calls or any session cycle.</span>
          }
        </div>
      </div>
    }
  `,
})
export class PickBarComponent {
  readonly picker = inject(CallPickerService);

  shortUrl(call: CallRecord): string {
    try {
      const url = new URL(call.url);
      return url.host + url.pathname;
    } catch {
      return call.url;
    }
  }
}
