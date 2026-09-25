import { RuleDialogService } from '../../core/services/rule-dialog.service';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { directionOf } from '../../core/models/call-ref.model';
import { CallPickerService } from '../../core/services/call-picker.service';
import { AnswerPreselect } from '../../components/answer-picker/answer-picker.component';
import { CopyPreload } from '../../components/copy-from-call/copy-from-call.component';
import { EditorSnapshot, RULE_ANSWER_REQUESTER } from '../../components/rule-editor/rule-editor.component';
import { InterceptionRule, isActionEnabled, isTerminalAction } from '../../core/models/interception.model';
import { RuleMatch, SourceCallRef, describeAction, describeMatch } from '../../core/models/interception.model';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { DesktopNotificationsService } from '../../core/services/desktop-notifications.service';
import { CallRuleDraft, RuleDraftService } from '../../core/services/rule-draft.service';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { ImportRulesDialogComponent } from '../../components/import-rules-dialog/import-rules-dialog.component';
import { PausedCallsComponent } from '../../components/paused-calls/paused-calls.component';
import { RuleEditorComponent } from '../../components/rule-editor/rule-editor.component';
import { downloadJson } from '../../shared/utils/download';
import { rulesFileName } from '../../shared/utils/interception-rules-file';

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
  imports: [ConfirmDialogComponent, ImportRulesDialogComponent, PausedCallsComponent, RuleEditorComponent],
  templateUrl: './interception.component.html',
})
export class InterceptionComponent {
  readonly state = inject(InterceptionStateService);
  readonly notifications = inject(DesktopNotificationsService);
  private readonly confirm = inject(ConfirmDialogService);

  /** The rule currently open in the editor: a rule to edit, 'new' for a blank one, null for closed. */
  readonly editing = signal<InterceptionRule | 'new' | null>(null);

  /** Set when this page was opened from a call card's "Use as answer in a new rule…" - the new rule starts from that call. */
  readonly draft = signal<CallRuleDraft | null>(inject(RuleDraftService).take());

  readonly importing = signal(false);

  /** A form parked by the rule editor's "Pick from anywhere…", reopened on Return or Cancel. */
  readonly snapshot = signal<EditorSnapshot | null>(null);
  readonly pickedAnswer = signal<AnswerPreselect | null>(null);
  readonly pickedCopy = signal<CopyPreload | null>(null);

  private readonly picker = inject(CallPickerService);

  constructor() {
    if (this.draft()) this.editing.set('new');

    // Rebuilt when the user comes back from another tab; still alive when they never left.
    effect(() => {
      if (!this.picker.hasResult(RULE_ANSWER_REQUESTER)) return;
      untracked(() => {
        const result = this.picker.takeResult(RULE_ANSWER_REQUESTER);
        const snapshot = result?.resume as EditorSnapshot | null;
        if (!snapshot) return;
        const picked = result?.picked[0];
        this.draft.set(null);
        this.snapshot.set(snapshot);
        this.pickedAnswer.set(picked && (snapshot.purpose ?? 'answer') === 'answer' ? { direction: directionOf(picked.ref), callId: picked.ref.callId, cycleId: picked.ref.cycleId } : null);
        // "Copy from a call…" and "Fill from a call…" both reopen at their choose step with the picked call.
        this.pickedCopy.set(picked && (snapshot.purpose === 'copy' || snapshot.purpose === 'match') ? { ref: picked.ref, call: picked.call } : null);
        // Closed first so an editor still open from before the pick is rebuilt from the snapshot, not reused.
        this.editing.set(null);
        queueMicrotask(() => this.editing.set('new'));
      });
    });
  }

  /**
   * "Made from…" in this tab's editor: the popup rule dialog takes the unsaved form over (it lives
   * in main-layout, so it survives leaving this page), and this editor closes.
   */
  goToCall(event: { source: SourceCallRef; snapshot: EditorSnapshot }, rule: InterceptionRule | null): void {
    this.ruleDialog.goToCall(event.source, event.snapshot, rule);
    this.closeEditor();
  }

  private readonly ruleDialog = inject(RuleDialogService);

  describeMatch(match: RuleMatch): string {
    return describeMatch(match, this.state.sensitiveNames());
  }
  readonly describeAction = describeAction;
  readonly isActionEnabled = isActionEnabled;

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
    this.draft.set(null);
    this.snapshot.set(null);
    this.pickedAnswer.set(null);
    this.pickedCopy.set(null);
    this.editing.set('new');
  }

  /**
   * Writes the rules to a file the importer can read back. Pure client-side: GET /rules already
   * returns everything, and the builder strips the three fields the server assigns.
   */
  exportAll(): void {
    this.exportRules(this.state.rules());
  }

  exportOne(rule: InterceptionRule, event: Event): void {
    // The row itself opens the editor on click.
    event.stopPropagation();
    this.exportRules([rule]);
  }

  /**
   * Through the backend: a rule that answers with a stored answer needs that answer's body in the
   * file, and only the backend has it.
   */
  private exportRules(rules: readonly InterceptionRule[]): void {
    if (rules.length === 0) return;
    this.state.exportRules(rules.map((rule) => rule.id)).subscribe((file) => downloadJson(file, rulesFileName(rules)));
  }

  /**
   * Copies a rule and opens the editor on the copy.
   *
   * Nobody duplicates a rule to keep two identical ones - you duplicate to change something - so
   * landing in the editor is the next step either way. The copy keeps the original's enabled
   * state, which for a rule that delays or pauses means two rules now act on the same traffic;
   * the list marks a pausing rule "holds the caller" for exactly that reason.
   */
  duplicate(rule: InterceptionRule, event: Event): void {
    event.stopPropagation();
    this.state.clearProblems();
    this.state.duplicateRule(rule).subscribe((created) => {
      if (created) this.editing.set(created);
    });
  }

  openImport(): void {
    this.importing.set(true);
  }

  closeImport(): void {
    this.importing.set(false);
  }

  edit(rule: InterceptionRule): void {
    this.state.clearProblems();
    this.editing.set(rule);
  }

  closeEditor(): void {
    this.state.clearProblems();
    // Used once - the next "New rule" starts blank.
    this.draft.set(null);
    this.snapshot.set(null);
    this.pickedAnswer.set(null);
    this.pickedCopy.set(null);
    this.editing.set(null);
  }

  toggle(rule: InterceptionRule): void {
    this.state.setRuleEnabled(rule.id, !rule.enabled).subscribe();
  }

  toggleMaster(): void {
    this.state.setMasterSwitch(!this.state.masterSwitch());
  }

  /** What the bell button says - three states, not two, since "blocked in the browser" needs to
   * read differently from "just hasn't been turned on yet" rather than looking identical. */
  readonly notificationsLabel = computed(() => {
    if (this.notifications.permission() === 'denied') return '🔕 Notifications blocked';
    return this.notifications.enabled() ? '🔔 Notify me: on' : '🔕 Notify me: off';
  });

  readonly notificationsTitle = computed(() => {
    if (this.notifications.permission() === 'denied') {
      return 'Blocked in your browser\'s site settings for this page - re-enable it there, then click again.';
    }
    return this.notifications.enabled()
      ? 'A desktop notification fires when a call gets paused. Click to turn off.'
      : 'Get a desktop notification the moment a call gets paused, even from another tab.';
  });

  toggleNotifications(): void {
    this.notifications.toggle();
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

  /** Only an ENABLED pause earns the "holds the caller" warning - a disabled one holds nobody. */
  pauses(rule: InterceptionRule): boolean {
    return rule.actions.some((a) => isActionEnabled(a) && a.type.startsWith('PAUSE_'));
  }

  terminal(rule: InterceptionRule): boolean {
    return rule.actions.some((a) => isActionEnabled(a) && isTerminalAction(a.type));
  }

  trackById(_: number, rule: InterceptionRule): string {
    return rule.id;
  }
}
