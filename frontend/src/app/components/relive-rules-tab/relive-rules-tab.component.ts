import { Component, inject, input, output } from '@angular/core';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { applyMode, isModified } from '../../shared/utils/relive-call-rule';
import { CycleRule, InboundMode, ReliveCycle, UnexpectedCallsPolicyKind } from '../../shared/utils/relive-types';

/**
 * The cycle's Rules tab: the cycle-wide inbound switch (FR-011), the cycle rules list, and the
 * unexpected-calls section (FR-014f; mock.html `unexpectedSection()`).
 */
@Component({
  selector: 'app-relive-rules-tab',
  standalone: true,
  templateUrl: './relive-rules-tab.component.html',
})
export class ReliveRulesTabComponent {
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly cycle = input.required<ReliveCycle>();
  readonly cycleChange = output<ReliveCycle>();
  readonly openCycleRule = output<string | null>();
  readonly openUnexpectedRule = output<string | null>();

  async setInboundMode(mode: InboundMode): Promise<void> {
    const cycle = this.cycle();
    if (cycle.settings.inboundMode === mode) return;

    const inboundSteps = cycle.steps.filter((s) => !s.parentKey);
    const handEdited = inboundSteps.filter((s) => isModified(s.callRule, s, cycle.settings));
    if (handEdited.length) {
      const confirmed = await this.confirmDialog.confirm(
        `${handEdited.length} inbound step${handEdited.length === 1 ? ' has' : 's have'} a hand-edited call rule (${handEdited.map((s) => s.label).join(', ')}). Apply ${mode} to all inbound steps anyway?`,
        'Apply to all',
      );
      if (!confirmed) return;
    }

    const settings = { ...cycle.settings, inboundMode: mode };
    const steps = cycle.steps.map((s) => (s.parentKey ? s : { ...s, callRule: applyMode(s.callRule, mode, s.recording) }));
    this.cycleChange.emit({ ...cycle, settings, steps });
  }

  setUnexpectedPolicy(policy: UnexpectedCallsPolicyKind): void {
    const cycle = this.cycle();
    this.cycleChange.emit({ ...cycle, unexpectedCalls: { ...cycle.unexpectedCalls, policy } });
  }

  setUnexpectedFallback(fallback: 'BLOCK' | 'SEND_REAL'): void {
    const cycle = this.cycle();
    this.cycleChange.emit({ ...cycle, unexpectedCalls: { ...cycle.unexpectedCalls, fallback } });
  }

  removeUnexpectedRule(index: number): void {
    const cycle = this.cycle();
    const rules = cycle.unexpectedCalls.rules.filter((_, i) => i !== index);
    this.cycleChange.emit({ ...cycle, unexpectedCalls: { ...cycle.unexpectedCalls, rules } });
  }

  removeCycleRule(index: number): void {
    const cycle = this.cycle();
    this.cycleChange.emit({ ...cycle, cycleRules: cycle.cycleRules.filter((_, i) => i !== index) });
  }

  ruleName(rule: CycleRule): string {
    return rule.name || '(unnamed rule)';
  }
}
