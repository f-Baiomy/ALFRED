import { CdkDrag, CdkDragDrop, CdkDropList, DragDropRegistry } from '@angular/cdk/drag-drop';
import { Component, ElementRef, EventEmitter, Input, OnInit, Output, computed, inject, signal } from '@angular/core';
import {
  ACTION_LABELS,
  ActionPhase,
  ActionType,
  Condition,
  ConditionBranch,
  ConditionOperator,
  ConditionSubject,
  OPERATORS_WITHOUT_VALUE,
  OPERATOR_LABELS,
  RESPONSE_SUBJECTS,
  SUBJECTS_NEEDING_NAME,
  SUBJECT_LABELS,
  describeBranch,
  isConditionalAction,
  FAILURE_HINTS,
  FAILURE_LABELS,
  describeAction,
  describeCondition,
  FailureMode,
  InterceptionRule,
  InterceptionRuleDraft,
  RuleAction,
  RuleSource,
  actionPhase,
  isActionEnabled,
} from '../../core/models/interception.model';
import { SelectOption, SelectPickerComponent } from '../select-picker/select-picker.component';
import { MultiSelectPickerComponent } from '../multi-select-picker/multi-select-picker.component';
import { RuleActionCardComponent } from '../rule-action-card/rule-action-card.component';
import { InterceptionStateService } from '../../core/state/interception-state.service';
import { InternalLoggingApiService } from '../../core/services/internal-logging-api.service';
import {
  FAILURE_HELP,
  HelpEntry,
  helpForAction,
  helpForOperator,
  helpForSubject,
} from '../../shared/utils/interception-help';

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

const METHOD_OPTIONS: readonly SelectOption[] = METHODS.map((m) => ({ value: m, label: m }));

const FAILURE_OPTIONS: readonly SelectOption[] = (Object.keys(FAILURE_LABELS) as FailureMode[])
  .map((mode) => ({ value: mode, label: FAILURE_LABELS[mode] }));

/** The only statuses a gateway failure can be - anything else is the supplier answering. */
const GATEWAY_STATUSES = [502, 503, 504];

const SUBJECT_OPTIONS: readonly SelectOption[] = (Object.keys(SUBJECT_LABELS) as ConditionSubject[])
  .map((subject) => ({ value: subject, label: SUBJECT_LABELS[subject] }));

const OPERATOR_OPTIONS: readonly SelectOption[] = (Object.keys(OPERATOR_LABELS) as ConditionOperator[])
  .map((operator) => ({ value: operator, label: OPERATOR_LABELS[operator] }));

const COMBINE_OPTIONS: readonly SelectOption[] = [
  { value: 'ALL', label: 'all of' },
  { value: 'ANY', label: 'any of' },
];

/**
 * The action tree, edited immutably.
 *
 * These are plain functions rather than methods because they are about the shape of the list,
 * not about the form - and because a recursive update reads better without `this` in the middle
 * of it.
 */
function updateAt(
  actions: readonly RuleAction[],
  path: readonly number[],
  change: (action: RuleAction) => RuleAction
): RuleAction[] {
  const [index, branchIndex, ...rest] = path;
  return actions.map((action, i) => {
    if (i !== index) return action;
    if (branchIndex === undefined) return change(action);
    return withBranchList(action, branchIndex, (list) => updateAt(list, [rest[0], ...rest.slice(1)], change));
  });
}

function removeAt(actions: readonly RuleAction[], path: readonly number[]): RuleAction[] {
  const [index, branchIndex, ...rest] = path;
  if (branchIndex === undefined) return actions.filter((_, i) => i !== index);
  return actions.map((action, i) =>
    i === index ? withBranchList(action, branchIndex, (list) => removeAt(list, rest)) : action
  );
}

function moveAt(actions: readonly RuleAction[], path: readonly number[], delta: number): RuleAction[] {
  const [index, branchIndex, ...rest] = path;
  if (branchIndex === undefined) {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return [...actions];
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }
  return actions.map((action, i) =>
    i === index ? withBranchList(action, branchIndex, (list) => moveAt(list, rest, delta)) : action
  );
}

function listAt(actions: readonly RuleAction[], path: readonly number[]): readonly RuleAction[] {
  if (path.length === 0) return actions;
  const [index, branchIndex, ...rest] = path;
  const action = actions[index];
  if (!action || branchIndex === undefined) return actions;
  const list = branchIndex < 0 ? action.otherwise ?? [] : action.branches?.[branchIndex]?.actions ?? [];
  return listAt(list, rest);
}

function actionAt(actions: readonly RuleAction[], path: readonly number[]): RuleAction | null {
  const [index, branchIndex, ...rest] = path;
  const action = actions[index];
  if (!action) return null;
  if (branchIndex === undefined) return action;
  const list = branchIndex < 0 ? action.otherwise ?? [] : action.branches?.[branchIndex]?.actions ?? [];
  return actionAt(list, rest);
}

/**
 * Inserts `item` at `index` in the LIST at `listPath` - the array itself, not an action within
 * it, so `listPath` is one shorter than the path to an action inside that list ([] for the
 * top-level array, [actionIndex, branchIndex] for a branch's own actions or its ELSE).
 *
 * The drag-and-drop counterpart to `removeAt`: a move is expressed as removing the action from
 * its source path, then inserting it here - which is also what keeps a same-list reorder and a
 * move into a completely different scope the same one code path in the component.
 */
function insertInList(
  actions: readonly RuleAction[],
  listPath: readonly number[],
  index: number,
  item: RuleAction
): RuleAction[] {
  if (listPath.length === 0) {
    const next = [...actions];
    next.splice(index, 0, item);
    return next;
  }
  const [actionIndex, branchIndex, ...rest] = listPath;
  return actions.map((action, i) =>
    i === actionIndex ? withBranchList(action, branchIndex, (list) => insertInList(list, rest, index, item)) : action
  );
}

/**
 * Where in the FULL top-level array lane-local position `laneIndex` actually lands.
 *
 * The pipeline draws one flat array as two lanes - request-phase steps and response-phase steps -
 * filtered by `actionPhase`, not two separate arrays (see requestSteps/responseSteps). A drag
 * within or into a lane reports its drop index in THAT FILTERED VIEW, so it has to be translated
 * back to a real splice position: the real index of the `laneIndex`'th action whose phase matches,
 * or the end of the array if the lane has fewer than that many.
 */
function realIndexForLanePosition(actions: readonly RuleAction[], phase: ActionPhase, laneIndex: number): number {
  let seen = 0;
  for (let i = 0; i < actions.length; i++) {
    if (actionPhase(actions[i].type) === phase) {
      if (seen === laneIndex) return i;
      seen++;
    }
  }
  return actions.length;
}

/**
 * Drop-list ids. The two pipeline lanes are named literally, since they are not really separate
 * arrays (see requestSteps/responseSteps) and so have no path of their own to derive an id from.
 * Every nested list (a branch's own actions, or an ELSE) gets an id from its list path instead -
 * `list:` followed by the path joined with a comma, `-1` reading as the ELSE the way it already
 * does everywhere else in this component.
 *
 * A comma, not a dash: the ELSE index IS -1, and joining with `-` made `[0, -1]` and `[0, 0, 1]`
 * the same string ("0--1" splits back into ['0', '', '1']). Found by a test for exactly the ELSE
 * case the whole scheme exists to name.
 */
const TOP_REQUEST_LIST = 'top:request';
const TOP_RESPONSE_LIST = 'top:response';

function laneListId(phase: ActionPhase): string {
  return phase === 'request' ? TOP_REQUEST_LIST : TOP_RESPONSE_LIST;
}

function nestedListId(listPath: readonly number[]): string {
  return `list:${listPath.join(',')}`;
}

function parseNestedListId(id: string): number[] {
  return id.slice('list:'.length).split(',').map(Number);
}

/** Every nested list currently in the tree, at any depth - what a drop list connects to besides the two lanes. */
function collectListIds(actions: readonly RuleAction[], prefix: readonly number[] = []): string[] {
  const ids: string[] = [];
  actions.forEach((action, i) => {
    (action.branches ?? []).forEach((branch, bi) => {
      const branchPath = [...prefix, i, bi];
      ids.push(nestedListId(branchPath));
      ids.push(...collectListIds(branch.actions, branchPath));
    });
    if (action.otherwise) {
      const otherwisePath = [...prefix, i, -1];
      ids.push(nestedListId(otherwisePath));
      ids.push(...collectListIds(action.otherwise, otherwisePath));
    }
  });
  return ids;
}

/**
 * The part of CDK's internal DropListRef this component has to reach for: where the list is, and
 * "measure yourself again". Neither is on the public API, and there is no public way to ask CDK to
 * re-measure mid-drag - see onDragMoved for why that is needed at all. Narrowed to these two
 * members so a CDK upgrade that renames either fails here, loudly, rather than silently making
 * nested drops stop working again.
 */
interface MeasurableDropList {
  readonly element: HTMLElement;
  _cacheParentPositions(): void;
}

/** What a `cdkDrag` here carries: enough to find the action again after it moves. */
interface DragStep {
  readonly action: RuleAction;
  readonly index: number;
  readonly path: readonly number[];
}

/** Applies a change to one branch's action list, or to the ELSE list when branchIndex is -1. */
function withBranchList(
  action: RuleAction,
  branchIndex: number,
  change: (actions: readonly RuleAction[]) => RuleAction[]
): RuleAction {
  if (branchIndex < 0) {
    return { ...action, otherwise: change(action.otherwise ?? []) };
  }
  return {
    ...action,
    branches: (action.branches ?? []).map((branch, i) =>
      i === branchIndex ? { ...branch, actions: change(branch.actions) } : branch
    ),
  };
}

/**
 * Whether an action means the host is never reached, on EVERY path through it.
 *
 * A terminal inside a conditional does not count: the branch may not be taken, so the host is
 * still reachable and the response lane can still run. Saying otherwise would grey out a half of
 * the rule that is perfectly live.
 */
function alwaysShortCircuits(action: RuleAction): boolean {
  return (
    action.type === 'MOCK_RESPONSE' ||
    action.type === 'ABORT_REQUEST' ||
    action.type === 'SIMULATE_FAILURE'
  );
}

function emptyBranch(): ConditionBranch {
  return { combine: 'ALL', conditions: [], actions: [] };
}

function defaultCondition(phase: ActionPhase): Condition {
  // Starts as something that is already valid and already says something true about a call, so a
  // freshly added condition is a working example rather than a form to decipher.
  return phase === 'request'
    ? { subject: 'REQUEST_HEADER', name: 'x-api-key', operator: 'NOT_EXISTS' }
    : { subject: 'RESPONSE_STATUS', operator: 'AT_LEAST', value: '500' };
}

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
  // One action-card definition rendered into both pipeline lanes and into every branch, rather
  // than the same 70 lines of field rows duplicated per phase - as a COMPONENT, because that is
  // what lets each card be a real item of the list it is drawn in. See RuleActionCardComponent.
  // SelectPickerComponent rather than a native <select>: a native dropdown's LIST is drawn by the
  // OS and only inconsistently honours page theming, so it renders as a pale system menu on
  // Alfred's dark surfaces (verified live). See that component's own docstring.
  imports: [
    SelectPickerComponent,
    MultiSelectPickerComponent,
    RuleActionCardComponent,
    CdkDropList,
    CdkDrag,
  ],
  templateUrl: './rule-editor.component.html',
})
export class RuleEditorComponent implements OnInit {
  /** Null for a brand-new rule. */
  @Input() rule: InterceptionRule | null = null;
  @Output() readonly closed = new EventEmitter<void>();

  readonly state = inject(InterceptionStateService);
  private readonly projectsApi = inject(InternalLoggingApiService);

  readonly methods = METHODS;
  readonly actionLabels = ACTION_LABELS;
  readonly directionOptions = DIRECTION_OPTIONS;
  readonly onTimeoutOptions = ON_TIMEOUT_OPTIONS;
  readonly methodOptions = METHOD_OPTIONS;
  readonly failureOptions = FAILURE_OPTIONS;
  readonly gatewayStatuses = GATEWAY_STATUSES;
  readonly failureHints = FAILURE_HINTS;
  readonly operatorOptions = OPERATOR_OPTIONS;
  readonly combineOptions = COMBINE_OPTIONS;

  /**
   * The configured projects, from the same endpoint the Settings page and Sources bar read.
   * Fetched rather than typed: a rule scoped to a project whose name is misspelled matches
   * nothing at all, and nothing about the silence says why.
   */
  readonly projectOptions = signal<readonly SelectOption[]>([]);

  readonly name = signal('');
  readonly description = signal('');
  readonly stopProcessing = signal(false);

  readonly source = signal<RuleSource>('both');
  readonly serviceNames = signal<readonly string[]>([]);
  readonly selectedMethods = signal<readonly string[]>([]);
  readonly host = signal('');
  readonly pathContains = signal('');
  readonly pathRegex = signal('');

  /** Mutable working copy - the domain type is readonly, and this is the one place a rule is edited. */
  readonly actions = signal<RuleAction[]>([]);

  readonly isNew = computed(() => this.rule === null);

  // `selectable === false` is ABORT_REQUEST: still evaluated for rules that use it, but reached
  // through SIMULATE_FAILURE now rather than offered as a second way to do the same thing.
  readonly requestActionTypes = computed(() =>
    this.state.actionTypes()
      .filter((t) => t.phase === 'request' && t.selectable !== false)
      .map((t) => t.type)
  );
  readonly responseActionTypes = computed(() =>
    this.state.actionTypes()
      .filter((t) => t.phase === 'response' && t.selectable !== false)
      .map((t) => t.type)
  );

  /**
   * A rule with a terminal action never reaches a pause, and two terminals contradict each other.
   * Surfaced here as a hint rather than enforced, because the backend is the authority and a
   * client-side block would be a second implementation of the same rule.
   */
  readonly conflictHint = computed(() => {
    const types = this.actions().map((a) => a.type);
    const terminals = types.filter(
      (t) => t === 'ABORT_REQUEST' || t === 'MOCK_RESPONSE' || t === 'SIMULATE_FAILURE'
    ).length;
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
      .map((action, index) => ({ action, index, path: [index] }))
      .filter((step) => actionPhase(step.action.type) === 'request')
  );

  readonly responseSteps = computed(() =>
    this.actions()
      .map((action, index) => ({ action, index, path: [index] }))
      .filter((step) => actionPhase(step.action.type) === 'response')
  );

  /**
   * Whether this rule ever reaches upstream. A rule that mocks or aborts does not, and its response
   * actions can never run - worth drawing, because "why did my response rule not fire" is otherwise
   * a puzzle rather than something visible in the form.
   */
  readonly reachesHost = computed(
    () => !this.actions().some(alwaysShortCircuits)
  );

  ngOnInit(): void {
    this.projectsApi.getServices().subscribe((services) => {
      // The reserved "unknown" entry (null ports) is a bucket for traffic that arrived on no
      // configured listener, not a project anybody would scope a rule to.
      this.projectOptions.set(
        services
          .filter((s) => s.listenPort !== null)
          .map((s) => ({ value: s.name, label: s.name }))
      );
    });

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
    // Either shape - a rule saved before the field was a list still has to load into the form
    // it is now edited with.
    this.serviceNames.set(
      rule.match.serviceNames?.length
        ? [...rule.match.serviceNames]
        : rule.match.serviceName
          ? [rule.match.serviceName]
          : []
    );
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

  isConditional(type: ActionType): boolean {
    return isConditionalAction(type);
  }

  removeAt(path: readonly number[]): void {
    this.actions.update((actions) => removeAt(actions, path));
  }

  moveAt(path: readonly number[], delta: number): void {
    this.actions.update((actions) => moveAt(actions, path, delta));
  }

  /**
   * Toggles whether the engine runs THIS action. It stays in the rule either way, still fully
   * editable - disabling is "skip this for now," not "delete and retype it later."
   *
   * For a conditional, turning it off skips its whole subtree in one step (see
   * proxy/interception.py's _prepare_actions) - but a nested action's OWN switch is untouched by
   * that, which is why one is still shown dimmed rather than hidden: it reports whether IT will
   * run once its ancestors do, and keeps whatever you set it to for when they come back on.
   */
  toggleEnabled(path: readonly number[]): void {
    this.actions.update((actions) =>
      updateAt(actions, path, (action) => ({ ...action, enabled: !isActionEnabled(action) }))
    );
  }

  isActionEnabled = isActionEnabled;

  // ---- dragging an action between scopes -------------------------------------------------
  //
  // Every action list in the rule is a connected drop target at once - both pipeline lanes,
  // every branch's `then`, every ELSE - so an action can move from top-level into a condition,
  // out of one, or straight from one branch into another. A move is always expressed as removing
  // the action from its own real path, then inserting it at the destination: the same operation
  // whether the two ends are the same list (a reorder) or different ones (a move across scopes).

  /** Every drop list currently on screen, connected to every other one. */
  readonly dropListIds = computed(() => [TOP_REQUEST_LIST, TOP_RESPONSE_LIST, ...collectListIds(this.actions())]);

  /**
   * This component, for the action cards to call back into - `[editor]="self"`.
   *
   * The cards own their layout and their nesting; every field, button and handler still lives
   * here, so one rule's editing logic stays in one file. See RuleActionCardComponent.
   */
  readonly self = this;

  /**
   * Re-measures every drop zone in this dialog while a drag is in flight.
   *
   * CDK measures a drop list ONCE, when the drag starts, and then hit-tests the pointer against
   * that stored rectangle. That holds for a list that stays put - but a condition's `then` list
   * lives INSIDE a condition card, and that card is itself an item of the lane being sorted. The
   * moment CDK shuffles the lane to open a gap, it slides the condition card (and the drop zone
   * inside it) somewhere its stored rectangle no longer describes. CDK then hit-tests the old
   * position, finds the "+ Add" buttons sitting there instead of the list, and refuses to enter -
   * so an action could never be dropped into a branch, which is the whole point of nesting.
   * Measured: pointer dead centre in the zone, `enterPredicate` true, and `_canReceive` still
   * false because `elementFromPoint` landed on a button.
   *
   * Re-measuring on every move costs a handful of `getBoundingClientRect` calls per pointer event
   * - the same thing CDK already does while sorting - and a rule has single digits of lists.
   */
  onDragMoved(): void {
    const dialog = this.hostElement.nativeElement;
    this.dropListRefs().forEach((ref) => {
      if (dialog.contains(ref.element)) {
        ref._cacheParentPositions();
      }
    });
  }

  /**
   * Every live drop list CDK knows about. Read from CDK's own registry rather than tracked by
   * hand, so branches that appear and disappear stay in step with no bookkeeping here.
   */
  private dropListRefs(): Set<MeasurableDropList> {
    return (this.dragDropRegistry as unknown as { _dropInstances: Set<MeasurableDropList> })._dropInstances;
  }

  private readonly dragDropRegistry = inject(DragDropRegistry);
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

  listId(listPath: readonly number[]): string {
    return nestedListId(listPath);
  }

  laneListId = laneListId;

  /**
   * Rejects a drop before it happens rather than after saving fails: a scope only accepts an
   * action of its own phase, and no deeper than the two levels of nesting the backend allows -
   * the same two checks `nestableTypes` already applies to the "+" buttons for adding a NEW
   * action here. It does not re-check the depth of what is INSIDE the dragged action - a
   * doubly-nested condition dragged one level deeper than this predicate accounts for is a rare
   * enough case that the save-time validator, which is authoritative regardless, is where it is
   * actually caught.
   */
  canDropInto = (drag: CdkDrag<DragStep>, drop: CdkDropList): boolean => {
    const dragged = drag.data;
    if (!dragged) return false;
    if (drop.id === TOP_REQUEST_LIST) return actionPhase(dragged.action.type) === 'request';
    if (drop.id === TOP_RESPONSE_LIST) return actionPhase(dragged.action.type) === 'response';
    const listPath = parseNestedListId(drop.id);
    return this.nestableTypes(listPath.slice(0, -1)).includes(dragged.action.type);
  };

  onActionDropped(event: CdkDragDrop<unknown, unknown, DragStep>): void {
    const dragged = event.item.data;
    const toId = event.container.id;

    this.actions.update((actions) => {
      const moved = actionAt(actions, dragged.path);
      if (!moved) return actions;
      const without = removeAt(actions, dragged.path);

      if (toId === TOP_REQUEST_LIST || toId === TOP_RESPONSE_LIST) {
        const phase: ActionPhase = toId === TOP_REQUEST_LIST ? 'request' : 'response';
        return insertInList(without, [], realIndexForLanePosition(without, phase, event.currentIndex), moved);
      }

      const listPath = [...parseNestedListId(toId)];
      // The destination's id was rendered against the tree as it stood BEFORE this drop, so its
      // leading index is only stale in the one case a removal can actually move a sibling: the
      // dragged action came from the TOP-LEVEL array, at a position before this destination's own
      // top-level ancestor. A removal anywhere else in the tree cannot shift another list's
      // indices - only the array something was spliced out of ever renumbers. Found by a test
      // that dragged a top-level action into a later top-level action's branch.
      if (dragged.path.length === 1 && listPath[0] > dragged.path[0]) {
        listPath[0] -= 1;
      }
      return insertInList(without, listPath, event.currentIndex, moved);
    });
  }

  /** How many siblings an action has where it sits - the move buttons need it to disable at the ends. */
  siblingCount(path: readonly number[]): number {
    return listAt(this.actions(), path.slice(0, -1)).length;
  }

  // ---- conditionals ---------------------------------------------------------------------

  addBranch(path: readonly number[]): void {
    this.actions.update((actions) =>
      updateAt(actions, path, (action) => ({
        ...action,
        branches: [...(action.branches ?? []), emptyBranch()],
      }))
    );
  }

  removeBranch(path: readonly number[], branchIndex: number): void {
    this.actions.update((actions) =>
      updateAt(actions, path, (action) => ({
        ...action,
        branches: (action.branches ?? []).filter((_, i) => i !== branchIndex),
      }))
    );
  }

  setCombine(path: readonly number[], branchIndex: number, combine: string): void {
    this.patchBranch(path, branchIndex, (branch) => ({
      ...branch,
      combine: combine === 'ANY' ? 'ANY' : 'ALL',
    }));
  }

  addCondition(path: readonly number[], branchIndex: number): void {
    this.patchBranch(path, branchIndex, (branch) => ({
      ...branch,
      conditions: [...branch.conditions, defaultCondition(this.conditionalPhase(path))],
    }));
  }

  removeCondition(path: readonly number[], branchIndex: number, conditionIndex: number): void {
    this.patchBranch(path, branchIndex, (branch) => ({
      ...branch,
      conditions: branch.conditions.filter((_, i) => i !== conditionIndex),
    }));
  }

  patchCondition(
    path: readonly number[],
    branchIndex: number,
    conditionIndex: number,
    patch: Partial<Condition>
  ): void {
    this.patchBranch(path, branchIndex, (branch) => ({
      ...branch,
      conditions: branch.conditions.map((c, i) => (i === conditionIndex ? { ...c, ...patch } : c)),
    }));
  }

  onSubjectChange(path: readonly number[], branchIndex: number, conditionIndex: number, value: string): void {
    const subject = value as ConditionSubject;
    // A subject that identifies nothing by name keeps no stale name: a leftover header name on a
    // METHOD condition would be saved, ignored, and look like it was doing something.
    this.patchCondition(path, branchIndex, conditionIndex, {
      subject,
      name: SUBJECTS_NEEDING_NAME.has(subject) ? undefined : null,
    });
  }

  onOperatorChange(path: readonly number[], branchIndex: number, conditionIndex: number, value: string): void {
    const operator = value as ConditionOperator;
    this.patchCondition(path, branchIndex, conditionIndex, {
      operator,
      value: OPERATORS_WITHOUT_VALUE.has(operator) ? null : undefined,
    });
  }

  onConditionText(
    path: readonly number[],
    branchIndex: number,
    conditionIndex: number,
    field: 'name' | 'value',
    event: Event
  ): void {
    this.patchCondition(path, branchIndex, conditionIndex, {
      [field]: (event.target as HTMLInputElement).value,
    });
  }

  onCaseSensitive(path: readonly number[], branchIndex: number, conditionIndex: number, event: Event): void {
    this.patchCondition(path, branchIndex, conditionIndex, {
      caseSensitive: (event.target as HTMLInputElement).checked,
    });
  }

  /** Adds an action to a branch, or to the ELSE when branchIndex is -1. */
  addBranchAction(path: readonly number[], branchIndex: number, type: ActionType): void {
    this.actions.update((actions) =>
      updateAt(actions, path, (action) =>
        branchIndex < 0
          ? { ...action, otherwise: [...(action.otherwise ?? []), defaultsFor(type)] }
          : {
              ...action,
              branches: (action.branches ?? []).map((branch, i) =>
                i === branchIndex ? { ...branch, actions: [...branch.actions, defaultsFor(type)] } : branch
              ),
            }
      )
    );
  }

  /** The actions a conditional at this path may contain - its own phase, and no deeper nesting. */
  nestableTypes(path: readonly number[]): readonly ActionType[] {
    const phase = this.conditionalPhase(path);
    const types = phase === 'request' ? this.requestActionTypes() : this.responseActionTypes();
    // Two levels is the limit the backend enforces; offering a third here would only produce a
    // rule that cannot be saved.
    return path.length >= 3 ? types.filter((type) => !isConditionalAction(type)) : types;
  }

  conditionsOf(action: RuleAction, branchIndex: number): readonly Condition[] {
    return action.branches?.[branchIndex]?.conditions ?? [];
  }

  /** Which subjects make sense here - response subjects do not exist during the request phase. */
  subjectOptions(path: readonly number[]): readonly SelectOption[] {
    const request = this.conditionalPhase(path) === 'request';
    return SUBJECT_OPTIONS.filter((option) => !request || !RESPONSE_SUBJECTS.has(option.value as ConditionSubject));
  }

  needsConditionName(condition: Condition): boolean {
    return SUBJECTS_NEEDING_NAME.has(condition.subject);
  }

  needsConditionValue(condition: Condition): boolean {
    return !OPERATORS_WITHOUT_VALUE.has(condition.operator);
  }

  conditionNamePlaceholder(condition: Condition): string {
    if (condition.subject === 'REQUEST_JSON_FIELD' || condition.subject === 'RESPONSE_JSON_FIELD') {
      return 'itinerary.seatsRemaining';
    }
    return condition.subject === 'QUERY_PARAM' ? 'currency' : 'x-api-key';
  }

  describeBranch = describeBranch;

  // ---- help -----------------------------------------------------------------------------

  /**
   * What the ⓘ on an action card shows. A list because the panel renders several entries, and a
   * failure action has a second one: the mode it is set to is the thing you actually want
   * explained, not the action in general.
   */
  actionHelp(action: RuleAction): readonly HelpEntry[] {
    const entry = helpForAction(action.type);
    if (action.type !== 'SIMULATE_FAILURE' || !action.failure) return [entry];
    return [
      entry,
      {
        title: FAILURE_LABELS[action.failure],
        code: action.failure,
        what: FAILURE_HELP[action.failure],
      },
    ];
  }

  /** A condition row is a subject AND an operator - reading one without the other is half an answer. */
  conditionHelp(condition: Condition): readonly HelpEntry[] {
    return [helpForSubject(condition.subject), helpForOperator(condition.operator)];
  }

  /** The card restated in the same words the call log will use for it. */
  summaryOf(action: RuleAction): string {
    return describeAction(action);
  }

  describeCondition = describeCondition;

  private conditionalPhase(path: readonly number[]): ActionPhase {
    const action = actionAt(this.actions(), path);
    return action && actionPhase(action.type) === 'response' ? 'response' : 'request';
  }

  private patchBranch(
    path: readonly number[],
    branchIndex: number,
    change: (branch: ConditionBranch) => ConditionBranch
  ): void {
    this.actions.update((actions) =>
      updateAt(actions, path, (action) => ({
        ...action,
        branches: (action.branches ?? []).map((branch, i) => (i === branchIndex ? change(branch) : branch)),
      }))
    );
  }

  /**
   * Where an action lives. `[2]` is the third top-level action; `[2, 0, 1]` is the second action
   * inside the first branch of that one; a branch index of -1 means the ELSE.
   *
   * A path rather than an index because a conditional holds actions inside its branches, so
   * "the third action" stops being a number - and every edit, move and delete has to say which
   * three-deep slot it means.
   */
  patchAt(path: readonly number[], patch: Partial<RuleAction>): void {
    this.actions.update((actions) => updateAt(actions, path, (action) => ({ ...action, ...patch })));
  }

  onText(path: readonly number[], field: 'name' | 'path' | 'body', event: Event): void {
    this.patchAt(path, { [field]: (event.target as HTMLInputElement).value });
  }

  onNumber(path: readonly number[], field: 'durationMs' | 'status' | 'timeoutSeconds', event: Event): void {
    const parsed = Number.parseInt((event.target as HTMLInputElement).value, 10);
    this.patchAt(path, { [field]: Number.isFinite(parsed) ? parsed : null });
  }

  onTimeoutChange(path: readonly number[], value: string): void {
    this.patchAt(path, { onTimeout: value === 'abort' ? 'abort' : 'release' });
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

  onValue(path: readonly number[], event: Event, asJson: boolean): void {
    const raw = (event.target as HTMLInputElement).value;
    if (!asJson) {
      this.patchAt(path, { value: raw });
      return;
    }
    // A value that does not parse is kept as a string, not rejected: `EUR` is a perfectly
    // reasonable thing to type into a field that will become `"EUR"`.
    try {
      this.patchAt(path, { value: JSON.parse(raw) as unknown });
    } catch {
      this.patchAt(path, { value: raw });
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

  isFailure(type: ActionType): boolean {
    return type === 'SIMULATE_FAILURE';
  }

  onFailureChange(path: readonly number[], value: string): void {
    const mode = value as FailureMode;
    // Carry the fields that mode needs, and only those - leaving a stale gateway status on a
    // reset would be saved and then ignored, which is the confusing kind of dead data.
    this.patchAt(path, {
      failure: mode,
      durationMs: mode === 'HANG_THEN_DROP' ? 30000 : null,
      status: mode === 'GATEWAY_ERROR' ? 504 : null,
      body: mode === 'TRUNCATED_BODY' ? '{"offers":[{"id":"OFF-1","price":412.50}]}' : null,
    });
  }

  failureHint(action: RuleAction): string {
    return action.failure ? FAILURE_HINTS[action.failure] : '';
  }

  needsHangDuration(action: RuleAction): boolean {
    return action.failure === 'HANG_THEN_DROP';
  }

  needsGatewayStatus(action: RuleAction): boolean {
    return action.failure === 'GATEWAY_ERROR';
  }

  needsTruncatedBody(action: RuleAction): boolean {
    return action.failure === 'TRUNCATED_BODY';
  }

  onStatusChange(path: readonly number[], status: number): void {
    this.patchAt(path, { status });
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
        serviceNames: this.serviceNames(),
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
    case 'SIMULATE_FAILURE':
      // Reset is the one that needs no other field, so a freshly added failure is valid before
      // the user has chosen anything.
      return { type, failure: 'CONNECTION_RESET' };
    case 'IF_REQUEST':
    case 'IF_RESPONSE':
      // One branch with one condition: a conditional with no branches is the one shape the
      // backend always rejects, and an empty IF explains nothing about what it is for.
      return {
        type,
        branches: [{
          combine: 'ALL',
          conditions: [defaultCondition(type === 'IF_REQUEST' ? 'request' : 'response')],
          actions: [],
        }],
        otherwise: [],
      };
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
