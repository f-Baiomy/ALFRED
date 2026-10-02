import { Component, computed, inject, input, output } from '@angular/core';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionRule } from '../../core/models/interception.model';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { applyMode, isModified } from '../../shared/utils/relive-call-rule';
import { validateCycle } from '../../shared/utils/relive-validate';
import { CycleRule, GlobalRulesMode, InboundMode, ReliveCycle, UnexpectedCallsPolicyKind, ValidationFinding } from '../../shared/utils/relive-types';

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
  private readonly interceptionState = inject(InterceptionStateService);

  readonly cycle = input.required<ReliveCycle>();
  readonly cycleChange = output<ReliveCycle>();
  readonly openCycleRule = output<string | null>();
  readonly openUnexpectedRule = output<string | null>();

  readonly globalRules = this.interceptionState.rules;

  readonly overlapWarnings = computed<readonly ValidationFinding[]>(() =>
    validateCycle(this.cycle(), new Set(this.globalRules().map((r) => r.id))).filter((f) => f.code === 'RULE_OVERLAP'),
  );

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

  /** FR-041b: marked fields are listed here and can be un-ignored. */
  removeNoiseRule(index: number): void {
    this.cycleChange.emit({ ...this.cycle(), noise: this.cycle().noise.filter((_, i) => i !== index) });
  }

  removeCycleRule(index: number): void {
    const cycle = this.cycle();
    this.cycleChange.emit({ ...cycle, cycleRules: cycle.cycleRules.filter((_, i) => i !== index) });
  }

  toggleCycleRule(index: number): void {
    const cycle = this.cycle();
    this.cycleChange.emit({
      ...cycle,
      cycleRules: cycle.cycleRules.map((rule, i) =>
        i === index ? { ...rule, enabled: rule.enabled === false } : rule),
    });
  }

  setGlobalRulesMode(mode: GlobalRulesMode): void {
    const cycle = this.cycle();
    this.cycleChange.emit({ ...cycle, globalRules: { ...cycle.globalRules, mode } });
  }

  toggleSelectedGlobalRule(id: string): void {
    const cycle = this.cycle();
    const selected = new Set(cycle.globalRules.selectedIds);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    this.cycleChange.emit({ ...cycle, globalRules: { ...cycle.globalRules, selectedIds: [...selected] } });
  }

  /** Whether a global rule currently participates in this cycle's runs (research D4). */
  globalRuleApplies(rule: InterceptionRule): boolean {
    const g = this.cycle().globalRules;
    if (g.mode === 'NONE') return false;
    if (g.mode === 'ALL') return true;
    return g.selectedIds.includes(rule.id);
  }

  /** "Copy into cycle" (FR-025-029b): becomes an independent CYCLE-tier rule the user can then edit
   *  without touching the global rule it started from. */
  copyGlobalRuleIntoCycle(rule: InterceptionRule): void {
    const cycle = this.cycle();
    const copy: CycleRule = {
      name: rule.name,
      enabled: true,
      priority: rule.priority,
      stopProcessing: rule.stopProcessing,
      match: rule.match,
      actions: rule.actions,
      copiedFrom: { ruleId: rule.id, name: rule.name, copiedAt: new Date().toISOString() },
    };
    this.cycleChange.emit({ ...cycle, cycleRules: [...cycle.cycleRules, copy] });
  }

  ruleName(rule: CycleRule): string {
    return rule.name || '(unnamed rule)';
  }
}
