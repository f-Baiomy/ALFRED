import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CallFocus, CallFocusService } from '../../core/services/call-focus.service';
import { modeOf } from '../../shared/utils/relive-call-rule';
import { Step } from '../../shared/utils/relive-types';

type DrawerTab = 'configure' | 'request' | 'response' | 'extract';

/**
 * The step drawer's Configure tab (FR-006, FR-010a; mock.html `drawer()`/`configTab()`). Request
 * and Response show the recording read-only for now - T037 makes Request editable and adds the
 * call-rule section; Extract & assert is wired in US5.
 */
@Component({
  selector: 'app-relive-step-drawer',
  standalone: true,
  templateUrl: './relive-step-drawer.component.html',
})
export class ReliveStepDrawerComponent {
  private readonly callFocus = inject(CallFocusService);

  readonly step = input.required<Step>();
  readonly stepChange = output<Step>();
  readonly closed = output<void>();

  readonly tab = signal<DrawerTab>('configure');

  readonly mode = computed(() => modeOf(this.step().callRule));

  setTab(tab: DrawerTab): void {
    this.tab.set(tab);
  }

  setLabel(label: string): void {
    this.stepChange.emit({ ...this.step(), label });
  }

  setOptional(optional: boolean): void {
    this.stepChange.emit({ ...this.step(), optional });
  }

  openOriginal(): void {
    const step = this.step();
    // CallFocusService.revealIn is a no-op when the source has no cycleId (a call picked from
    // Live Calls, which a Step's `source` allows) - go() handles both origins.
    const focus: CallFocus = { callId: step.source.callId, cycleId: step.source.cycleId, direction: step.source.direction, serviceName: step.serviceName ?? null };
    this.callFocus.go(focus);
  }

  close(): void {
    this.closed.emit();
  }
}
