import { NgTemplateOutlet } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import {
  ACTION_LABELS,
  ActionType,
  InterceptionRule,
  InterceptionRuleDraft,
  RuleAction,
  RuleSource,
  actionPhase,
} from '../../core/models/interception.model';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';
import { InterceptionStateService } from '../../core/state/interception-state.service';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const DIRECTION_OPTIONS: readonly SelectOption[] = [
  { value: 'both', label: 'Any direction' },
  { value: 'outbound', label: 'Outbound (to suppliers)' },
  { value: 'inbound', label: 'Inbound (into our services)' },
];

const ON_TIMEOUT_OPTIONS: readonly SelectOption[] = [
  { value: 'release', label: 'Release it unchanged' },
  { value: 'abort', label: 'Abort the connection' },
];

/**
 * Create/edit form for one interception rule.
 *
 * A form, deliberately never a code box. The whole point of the feature is that simulating a slow
 * supplier or a bad payload should not require writing Python into a proxy addon, so every matcher
 * and every action parameter is a labelled field. The cost is that adding an action type means
 * adding a row of inputs here; the benefit is that a rule can be read and trusted by someone who
 * did not write it, which matters when the rule is changing production-shaped traffic.
 *
 * Validation is NOT duplicated here. The backend returns every problem with a rule at once
 * (RuleValidator), and mirroring those checks client-side would create two rule-languages that
 * drift. The form only prevents the shapes it would be absurd to submit - an action with no type.
 */
@Component({
  selector: 'app-rule-editor',
  standalone: true,
  // One action-card definition rendered into both pipeline lanes, rather than the same 70 lines
  // of field rows duplicated per phase.
  // SelectPickerComponent rather than a native <select>: a native dropdown's LIST is drawn by the
  // OS and only inconsistently honours page theming, so it renders as a pale system menu on
  // Alfred's dark surfaces (verified live). See that component's own docstring.
  imports: [NgTemplateOutlet, SelectPickerComponent],
  templateUrl: './rule-editor.component.html',
})
export class RuleEditorComponent implements OnInit {
  /** Null for a brand-new rule. */
  @Input() rule: InterceptionRule | null = null;
  @Output() readonly closed = new EventEmitter<void>();

  readonly state = inject(InterceptionStateService);

  readonly methods = METHODS;
  readonly actionLabels = ACTION_LABELS;
  readonly directionOptions = DIRECTION_OPTIONS;
  readonly onTimeoutOptions = ON_TIMEOUT_OPTIONS;

  readonly name = signal('');
  readonly description = signal('');
  readonly stopProcessing = signal(false);

  readonly source = signal<RuleSource>('both');
  readonly serviceName = signal('');
  readonly selectedMethods = signal<readonly string[]>([]);
  readonly host = signal('');
  readonly pathContains = signal('');
  readonly pathRegex = signal('');

  /** Mutable working copy - the domain type is readonly, and this is the one place a rule is edited. */
  readonly actions = signal<RuleAction[]>([]);

  readonly isNew = computed(() => this.rule === null);

  readonly requestActionTypes = computed(() =>
    this.state.actionTypes().filter((t) => t.phase === 'request').map((t) => t.type)
  );
  readonly responseActionTypes = computed(() =>
    this.state.actionTypes().filter((t) => t.phase === 'response').map((t) => t.type)
  );

  /**
   * A rule with a terminal action never reaches a pause, and two terminals contradict each other.
   * Surfaced here as a hint rather than enforced, because the backend is the authority and a
   * client-side block would be a second implementation of the same rule.
   */
  readonly conflictHint = computed(() => {
    const types = this.actions().map((a) => a.type);
    const terminals = types.filter((t) => t === 'ABORT_REQUEST' || t === 'MOCK_RESPONSE').length;
    const pauses = types.filter((t) => t.startsWith('PAUSE_')).length;
    if (terminals > 1) return 'Two actions both end the request — only the first would ever run.';
    if (terminals > 0 && pauses > 0) return 'This rule ends the request before it could pause.';
    if (pauses > 1) return 'A call can only be paused once.';
    return null;
  });

  readonly holdsCaller = computed(() => this.actions().some((a) => a.type.startsWith('PAUSE_')));

  /** Actions split by phase, so the editor can draw the request half, the host, then the response half. */
  readonly requestSteps = computed(() =>
    this.actions()
      .map((action, index) => ({ action, index }))
      .filter((step) => actionPhase(step.action.type) === 'request')
  );

  readonly responseSteps = computed(() =>
    this.actions()
      .map((action, index) => ({ action, index }))
      .filter((step) => actionPhase(step.action.type) === 'response')
  );

  /**
   * Whether this rule ever reaches upstream. A rule that mocks or aborts does not, and its response
   * actions can never run - worth drawing, because "why did my response rule not fire" is otherwise
   * a puzzle rather than something visible in the form.
   */
  readonly reachesHost = computed(
    () => !this.actions().some((a) => a.type === 'MOCK_RESPONSE' || a.type === 'ABORT_REQUEST')
  );

  ngOnInit(): void {
    const rule = this.rule;
    if (!rule) {
      // A new rule starts with one delay action rather than none: an empty action list is the one
      // thing the backend always rejects, and "here is the shape of an action" is a better first
      // screen than a blank panel with an Add button.
      this.actions.set([{ type: 'DELAY_REQUEST', durationMs: 5000 }]);
      return;
    }
    this.name.set(rule.name);
    this.description.set(rule.description ?? '');
    this.stopProcessing.set(rule.stopProcessing);
    this.source.set((rule.match.source as RuleSource) ?? 'both');
    this.serviceName.set(rule.match.serviceName ?? '');
    this.selectedMethods.set(rule.match.methods ?? []);
    this.host.set(rule.match.host ?? '');
    this.pathContains.set(rule.match.pathContains ?? '');
    this.pathRegex.set(rule.match.pathRegex ?? '');
    this.actions.set(rule.actions.map((a) => ({ ...a })));
  }

  toggleMethod(method: string): void {
    const current = this.selectedMethods();
    this.selectedMethods.set(
      current.includes(method) ? current.filter((m) => m !== method) : [...current, method]
    );
  }

  methodSelected(method: string): boolean {
    return this.selectedMethods().includes(method);
  }

  addAction(type: ActionType): void {
    this.actions.update((actions) => [...actions, defaultsFor(type)]);
  }

  removeAction(index: number): void {
    this.actions.update((actions) => actions.filter((_, i) => i !== index));
  }

  moveAction(index: number, delta: number): void {
    const target = index + delta;
    const actions = this.actions();
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    this.actions.set(next);
  }

  patchAction(index: number, patch: Partial<RuleAction>): void {
    this.actions.update((actions) => actions.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  onText(index: number, field: 'name' | 'path' | 'body', event: Event): void {
    this.patchAction(index, { [field]: (event.target as HTMLInputElement).value });
  }

  onNumber(index: number, field: 'durationMs' | 'status' | 'timeoutSeconds', event: Event): void {
    const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.patchAction(index, { [field]: Number.isFinite(parsed) ? parsed : null });
  }

  onTimeoutChange(index: number, value: string): void {
    this.patchAction(index, { onTimeout: value === 'abort' ? 'abort' : 'release' });
  }

  /**
   * The raw JSON text of an action's `value`, so a user can write a number, a string, `true` or
   * `null` and get that type through to the body rather than everything becoming a string - which
   * is the one place JSON types actually matter.
   */
  valueText(action: RuleAction): string {
    if (action.value === undefined || action.value === null) return '';
    return typeof action.value === 'string' ? action.value : JSON.stringify(action.value);
  }

  onValue(index: number, event: Event, asJson: boolean): void {
    const raw = (event.target as HTMLInputElement).value;
    if (!asJson) {
      this.patchAction(index, { value: raw });
      return;
    }
    // A value that does not parse is kept as a string, not rejected: `EUR` is a perfectly
    // reasonable thing to type into a field that will become `"EUR"`.
    try {
      this.patchAction(index, { value: JSON.parse(raw) as unknown });
    } catch {
      this.patchAction(index, { value: raw });
    }
  }

  /**
   * Indexing ACTION_LABELS directly from the template fails under strictTemplates: an
   * `ng-template` context variable is typed `any`, and `any` cannot index a Record. A method call
   * keeps the lookup typed in one place instead of scattering casts through the markup.
   */
  labelFor(type: ActionType): string {
    return ACTION_LABELS[type] ?? type;
  }

  phaseOf(type: ActionType): string {
    return actionPhase(type) === 'request' ? 'Request' : 'Response';
  }

  isDelay(type: ActionType): boolean {
    return type === 'DELAY_REQUEST' || type === 'DELAY_RESPONSE';
  }

  isHeaderSet(type: ActionType): boolean {
    return type === 'SET_REQUEST_HEADER' || type === 'SET_RESPONSE_HEADER' || type === 'SET_QUERY_PARAM';
  }

  isNameOnly(type: ActionType): boolean {
    return type === 'REMOVE_REQUEST_HEADER' || type === 'REMOVE_RESPONSE_HEADER' || type === 'REMOVE_QUERY_PARAM';
  }

  isJsonField(type: ActionType): boolean {
    return type === 'SET_REQUEST_JSON_FIELD' || type === 'SET_RESPONSE_JSON_FIELD';
  }

  isStatus(type: ActionType): boolean {
    return type === 'SET_RESPONSE_STATUS';
  }

  isMock(type: ActionType): boolean {
    return type === 'MOCK_RESPONSE';
  }

  /** MOCK_RESPONSE and REPLACE_RESPONSE take the same three fields; only their timing differs. */
  isReplace(type: ActionType): boolean {
    return type === 'REPLACE_RESPONSE';
  }

  isBodyOnly(type: ActionType): boolean {
    return type === 'SET_RESPONSE_BODY';
  }

  /** Takes no parameters at all - the card is the whole statement. */
  isBare(type: ActionType): boolean {
    return type === 'ABORT_REQUEST' || type === 'SEND_TO_HOST';
  }

  isPause(type: ActionType): boolean {
    return type.startsWith('PAUSE_');
  }

  save(): void {
    const draft: InterceptionRuleDraft = {
      name: this.name().trim(),
      description: this.description().trim() || null,
      enabled: this.rule?.enabled ?? true,
      priority: this.rule?.priority ?? 100,
      stopProcessing: this.stopProcessing(),
      match: {
        source: this.source(),
        serviceName: this.serviceName().trim() || null,
        methods: this.selectedMethods(),
        host: this.host().trim() || null,
        pathContains: this.pathContains().trim() || null,
        pathRegex: this.pathRegex().trim() || null,
      },
      actions: this.actions(),
    };

    const saved = this.rule ? this.state.updateRule(this.rule.id, draft) : this.state.createRule(draft);
    saved.subscribe((result) => {
      // Null means the backend rejected it - `problems` is already populated and the form stays
      // open with every problem listed at once.
      if (result) this.closed.emit();
    });
  }

  cancel(): void {
    this.closed.emit();
  }

  trackByIndex(index: number): number {
    return index;
  }
}

/**
 * Sensible starting values per action type, so a freshly added action is already valid rather than
 * starting life as something the backend will reject.
 */
function defaultsFor(type: ActionType): RuleAction {
  switch (type) {
    case 'DELAY_REQUEST':
    case 'DELAY_RESPONSE':
      return { type, durationMs: 5000 };
    case 'SET_REQUEST_HEADER':
    case 'SET_RESPONSE_HEADER':
      return { type, name: 'X-Alfred-Test', value: 'true' };
    case 'SET_QUERY_PARAM':
      return { type, name: '', value: '' };
    case 'REMOVE_REQUEST_HEADER':
    case 'REMOVE_RESPONSE_HEADER':
    case 'REMOVE_QUERY_PARAM':
      return { type, name: '' };
    case 'SET_REQUEST_JSON_FIELD':
    case 'SET_RESPONSE_JSON_FIELD':
      return { type, path: '', value: null };
    case 'SET_RESPONSE_STATUS':
      return { type, status: 500 };
    case 'SET_RESPONSE_BODY':
      return { type, body: '' };
    case 'REPLACE_RESPONSE':
      return { type, status: 500, body: '{"error":"Replaced by Alfred"}' };
    case 'SEND_TO_HOST':
      return { type };
    case 'MOCK_RESPONSE':
      return {
        type,
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: '{"error":"Simulated supplier failure"}',
      };
    case 'PAUSE_REQUEST':
    case 'PAUSE_RESPONSE':
      // 30 seconds and release-unchanged: a breakpoint that defaults to aborting would make an
      // unattended rule destructive, and one with no timeout is not allowed at all.
      return { type, timeoutSeconds: 30, onTimeout: 'release' };
    default:
      return { type };
  }
}
