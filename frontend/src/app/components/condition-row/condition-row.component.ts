import { Component, computed, input, output } from '@angular/core';
import { Condition, ConditionOperator, ConditionSubject, describeCondition } from '../../core/models/interception.model';
import { PathEntry } from '../../shared/utils/json-paths';
import { RecordedCallPreview } from '../../shared/utils/recorded-call-match';
import {
  ConditionOption,
  ITEM_OPTIONS,
  PATHS_MODE_OPTIONS,
  TYPE_OPTIONS,
  conditionHelp,
  conditionNamePlaceholder,
  isJsonCondition,
  needsConditionName,
  needsConditionValue,
  operatorOptions,
  recordedCallCriteria,
  showsItemMode,
  withChipKey,
  withChipRemoved,
  withOperator,
  withPathAdded,
  withPathRemoved,
  withPathSet,
  withSubject,
} from '../../shared/utils/condition-edit';
import { NameSuggestion } from '../../shared/utils/name-suggestions';
import { HelpPopoverComponent } from '../help-popover/help-popover.component';
import { JsonPathInputComponent } from '../json-path-input/json-path-input.component';
import { NameSuggestComponent } from '../name-suggest/name-suggest.component';
import { SelectPickerComponent } from '../select-picker/select-picker.component';

let nextId = 0;

/**
 * One condition, edited in place: subject, the field(s) it reads, any / every item, operator and
 * value. The rule editor's IF rows and Relive's step checks both render THIS - the logic lives in
 * shared/utils/condition-edit.ts - so anything a condition learns shows up in both. The host owns
 * where the condition is stored; this only emits the edited copy.
 */
@Component({
  selector: 'app-condition-row',
  standalone: true,
  imports: [HelpPopoverComponent, JsonPathInputComponent, NameSuggestComponent, SelectPickerComponent],
  templateUrl: './condition-row.component.html',
})
export class ConditionRowComponent {
  readonly condition = input.required<Condition>();
  readonly subjectOptions = input.required<readonly ConditionOption[]>();
  /** '', 'and' or 'or' - the word in front of the row. */
  readonly joiner = input('');
  /** JSON paths to suggest for a JSON field (the rule's sample call, or the step's recording). */
  readonly paths = input<readonly PathEntry[] | null>(null);
  /** Values a JSON field had in that call - offered for the value box. */
  readonly valueHints = input<readonly string[]>([]);
  /** Header names (with values) to offer in a header name box. */
  readonly headerNames = input<readonly NameSuggestion[]>([]);
  readonly headerNamesTitle = input('');
  /** RECORDED_CALL rows: the step's frozen request, when the host knows it. */
  readonly recordedCallPreview = input<RecordedCallPreview | null>(null);

  readonly conditionChange = output<Condition>();
  readonly remove = output<void>();

  readonly listId = `cond-values-${nextId++}`;
  readonly itemOptions = ITEM_OPTIONS;
  readonly pathsModeOptions = PATHS_MODE_OPTIONS;
  readonly typeOptions = TYPE_OPTIONS;

  readonly json = computed(() => isJsonCondition(this.condition()));
  readonly operators = computed(() => operatorOptions(this.condition()));
  readonly help = computed(() => conditionHelp(this.condition()));
  readonly summary = computed(() => describeCondition(this.condition()));
  readonly needsName = computed(() => needsConditionName(this.condition()));
  readonly needsValue = computed(() => needsConditionValue(this.condition()));
  readonly itemMode = computed(() => showsItemMode(this.condition()));
  readonly placeholder = computed(() => conditionNamePlaceholder(this.condition()));
  readonly headerNamed = computed(() => {
    const subject = this.condition().subject;
    return subject === 'REQUEST_HEADER' || subject === 'RESPONSE_HEADER';
  });
  readonly criteria = computed(() => recordedCallCriteria(this.recordedCallPreview()));

  private emit(next: Condition): void {
    this.conditionChange.emit(next);
  }

  patch(patch: Partial<Condition>): void {
    this.emit({ ...this.condition(), ...patch });
  }

  setSubject(value: string): void {
    this.emit(withSubject(this.condition(), value as ConditionSubject));
  }

  setOperator(value: string): void {
    this.emit(withOperator(this.condition(), value as ConditionOperator));
  }

  addPath(): void {
    this.emit(withPathAdded(this.condition()));
  }

  setPath(index: number, value: string): void {
    this.emit(withPathSet(this.condition(), index, value));
  }

  removePath(index: number): void {
    this.emit(withPathRemoved(this.condition(), index));
  }

  onChipKey(event: KeyboardEvent): void {
    const box = event.target as HTMLInputElement;
    const next = withChipKey(this.condition(), event.key, box.value);
    if (!next) return;
    if (event.key !== 'Backspace') {
      event.preventDefault();
      box.value = '';
    }
    this.emit(next);
  }

  removeChip(index: number): void {
    this.emit(withChipRemoved(this.condition(), index));
  }
}
