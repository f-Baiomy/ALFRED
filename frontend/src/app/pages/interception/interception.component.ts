import { Component, computed, inject, signal } from '@angular/core';
import { InterceptionRule } from '../../core/models/interception.model';
import { describeAction, describeMatch } from '../../core/models/interception.model';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { PausedCallsComponent } from '../../components/paused-calls/paused-calls.component';
import { RuleEditorComponent } from '../../components/rule-editor/rule-editor.component';

/**
 * The Interception tab: the rule list, the master switch, and the paused-call inspector.
 *
 * A top-level tab rather than a fourth panel inside Settings, deliberately. Settings holds things
 * you configure once (which hosts get logged, which projects record inbound traffic); this is an
 * operational surface you toggle repeatedly while testing, and when it is on it is changing real
 * traffic - which has to be one click away and visible, not buried behind a sub-tab.
 */
@Component({
  selector: 'app-interception',
  standalone: true,
  imports: [ConfirmDialogComponent, PausedCallsComponent, RuleEditorComponent],
  templateUrl: './interception.component.html',
})
export class InterceptionComponent {
  readonly state = inject(InterceptionStateService);
  private readonly confirm = inject(ConfirmDialogService);

  /** The rule currently open in the editor: a rule to edit, 'new' for a blank one, null for closed. */
  readonly editing = signal<InterceptionRule | 'new' | null>(null);

  readonly describeMatch = describeMatch;
  readonly describeAction = describeAction;

  readonly bannerText = computed(() => {
    const rules = this.state.enabledRuleCount();
    if (!this.state.masterSwitch()) {
      return rules > 0
        ? `Interception is off — ${rules} rule${rules === 1 ? '' : 's'} ready but not applying`
        : 'Interception is off';
    }
    if (rules === 0) {
      return 'Interception is on, but no rules are enabled — nothing is being changed';
    }
    return `Interception is ON — ${rules} rule${rules === 1 ? '' : 's'} changing live traffic`;
  });

  readonly pausingWarning = computed(() => {
    const pausing = this.state.pausingRuleCount();
    if (!this.state.masterSwitch() || pausing === 0) return null;
    return `${pausing} of them can pause a call and hold its caller open. Do not leave this on unattended.`;
  });

  newRule(): void {
    this.state.clearProblems();
    this.editing.set('new');
  }

  edit(rule: InterceptionRule): void {
    this.state.clearProblems();
    this.editing.set(rule);
  }

  closeEditor(): void {
    this.state.clearProblems();
    this.editing.set(null);
  }

  toggle(rule: InterceptionRule): void {
    this.state.setRuleEnabled(rule.id, !rule.enabled).subscribe();
  }

  toggleMaster(): void {
    this.state.setMasterSwitch(!this.state.masterSwitch());
  }

  async remove(rule: InterceptionRule): Promise<void> {
    const confirmed = await this.confirm.confirm(
      `Delete "${rule.name}"? It will stop applying immediately and cannot be recovered.`,
      'Delete rule'
    );
    if (confirmed) {
      this.state.deleteRule(rule.id).subscribe();
    }
  }

  /**
   * Moves a rule one place in the list and renumbers priorities server-side. Buttons rather than
   * drag-and-drop: the list is short, and a keyboard-reachable move is one thing fewer to get
   * wrong than a drag target on a row that already has a switch and a menu on it.
   */
  move(rule: InterceptionRule, delta: number): void {
    const ids = this.state.rules().map((r) => r.id);
    const from = ids.indexOf(rule.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const reordered = [...ids];
    reordered.splice(to, 0, ...reordered.splice(from, 1));
    this.state.reorder(reordered).subscribe();
  }

  isFirst(rule: InterceptionRule): boolean {
    return this.state.rules()[0]?.id === rule.id;
  }

  isLast(rule: InterceptionRule): boolean {
    const rules = this.state.rules();
    return rules[rules.length - 1]?.id === rule.id;
  }

  pauses(rule: InterceptionRule): boolean {
    return rule.actions.some((a) => a.type.startsWith('PAUSE_'));
  }

  terminal(rule: InterceptionRule): boolean {
    return rule.actions.some((a) => a.type === 'ABORT_REQUEST' || a.type === 'MOCK_RESPONSE');
  }

  trackById(_: number, rule: InterceptionRule): string {
    return rule.id;
  }
}
