import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CallFocus, CallFocusService } from '../../core/services/call-focus.service';
import { RuleAction } from '../../core/models/interception.model';
import { applyMode, checkpointOf, modeOf, onRequestChangedOf, setCheckpoint } from '../../shared/utils/relive-call-rule';
import { ActionLine, HostCardInfo, describeAction, hostCard } from '../../shared/utils/relive-call-rule-describe';
import { OnRequestChanged, Step, StepMode } from '../../shared/utils/relive-types';

type DrawerTab = 'configure' | 'request' | 'response' | 'extract';

/**
 * The step drawer's Configure tab (FR-006, FR-010a; mock.html `drawer()`/`configTab()`/
 * `callRuleSection()`). Request and Response show the recording read-only for now - a future task
 * makes Request editable; Extract & assert is wired in US5.
 */
@Component({
  selector: 'app-relive-step-drawer',
  standalone: true,
  templateUrl: './relive-step-drawer.component.html',
})
export class ReliveStepDrawerComponent {
  private readonly callFocus = inject(CallFocusService);

  readonly step = input.required<Step>();
  /** "#n in <parent label>" for a child step - the cycle page computes it (siblings sharing this
   *  step's endpoint), since the drawer only ever sees one step at a time. Null for an inbound step. */
  readonly orderLabel = input<string | null>(null);

  readonly stepChange = output<Step>();
  readonly closed = output<void>();
  /** "Reset call rule" (FR-010b) - the parent shows the confirmation popup before calling
   *  `ReliveCycleEditorState.resetStep`; this only asks for it. */
  readonly resetRequested = output<string>();
  readonly duplicateRequested = output<string>();
  readonly openCallRule = output<string>();
  readonly openRequestDiffers = output<string>();

  readonly tab = signal<DrawerTab>('configure');

  readonly mode = computed(() => modeOf(this.step().callRule));
  readonly checkpoint = computed(() => checkpointOf(this.step().callRule));
  readonly onRequestChanged = computed(() => onRequestChangedOf(this.step().callRule));
  readonly requestActions = computed<readonly ActionLine[]>(() => describeActions(this.step().callRule.actions, 'request'));
  readonly responseActions = computed<readonly ActionLine[]>(() => describeActions(this.step().callRule.actions, 'response'));
  readonly host = computed<HostCardInfo>(() => hostCard(this.step().callRule.actions, this.step().serviceName || 'the app'));

  setTab(tab: DrawerTab): void {
    this.tab.set(tab);
  }

  setLabel(label: string): void {
    this.stepChange.emit({ ...this.step(), label });
  }

  setOptional(optional: boolean): void {
    this.stepChange.emit({ ...this.step(), optional });
  }

  setMode(mode: StepMode): void {
    const step = this.step();
    if (modeOf(step.callRule) === mode) return;
    this.stepChange.emit({ ...step, callRule: applyMode(step.callRule, mode, step.recording) });
  }

  togglePause(at: 'before' | 'after'): void {
    const step = this.step();
    const cp = checkpointOf(step.callRule);
    const on = at === 'before' ? cp.before : cp.after;
    this.stepChange.emit({ ...step, callRule: setCheckpoint(step.callRule, at, !on) });
  }

  setUnattributed(choice: Step['unattributed']): void {
    this.stepChange.emit({ ...this.step(), unattributed: choice });
  }

  requestDiffersLabel(): string {
    const labels: Record<OnRequestChanged, string> = { FAIL: 'Mock a failure', ASK: 'Ask me', REPLAY: 'Replay recording anyway', LIVE: 'Call live ⚠' };
    return labels[this.onRequestChanged()];
  }

  openOriginal(): void {
    const step = this.step();
    // CallFocusService.revealIn is a no-op when the source has no cycleId (a call picked from
    // Live Calls, which a Step's `source` allows) - go() handles both origins.
    const focus: CallFocus = { callId: step.source.callId, cycleId: step.source.cycleId, direction: step.source.direction, serviceName: step.serviceName ?? null };
    this.callFocus.go(focus);
  }

  requestReset(): void {
    this.resetRequested.emit(this.step().key);
  }

  requestDuplicate(): void {
    this.duplicateRequested.emit(this.step().key);
  }

  requestOpenCallRule(): void {
    this.openCallRule.emit(this.step().key);
  }

  requestOpenRequestDiffers(): void {
    this.openRequestDiffers.emit(this.step().key);
  }

  close(): void {
    this.closed.emit();
  }
}

function describeActions(actions: readonly RuleAction[], phase: 'request' | 'response'): ActionLine[] {
  // Response-phase types by name (mirrors actionPhase()'s name-based fallback in interception.model.ts,
  // good enough for a read-only preview - the authoritative phase comes from the server's action
  // catalog, used everywhere an action is actually added/removed).
  const isResponse = (type: string) => type.includes('RESPONSE') && type !== 'MOCK_RESPONSE';
  return actions.filter((a) => (phase === 'response') === isResponse(a.type)).map(describeAction);
}
