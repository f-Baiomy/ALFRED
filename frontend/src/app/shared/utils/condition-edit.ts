import {
  Condition,
  ConditionOperator,
  ConditionSubject,
  JSON_ONLY_OPERATORS,
  JSON_TYPES,
  LIST_VALUE_OPERATORS,
  OPERATORS_WITHOUT_VALUE,
  OPERATOR_LABELS,
  SUBJECTS_NEEDING_NAME,
  SUBJECT_LABELS,
  WHOLE_FIELD_OPERATORS,
} from '../../core/models/interception.model';
import { RecordedCallPreview } from './recorded-call-match';
import { HelpEntry, helpForOperator, helpForSubject } from './interception-help';

/**
 * Editing one condition - what the rule editor's IF rows and Relive's step checks share, so a
 * subject, operator or list mode added here shows up in both (app-condition-row renders it).
 * Every function returns a new Condition; none touches a rule.
 */

export interface ConditionOption {
  readonly value: string;
  readonly label: string;
}

export const SUBJECT_OPTIONS: readonly ConditionOption[] = (Object.keys(SUBJECT_LABELS) as ConditionSubject[])
  .map((subject) => ({ value: subject, label: SUBJECT_LABELS[subject] }));

export const OPERATOR_OPTIONS: readonly ConditionOption[] = (Object.keys(OPERATOR_LABELS) as ConditionOperator[])
  .map((operator) => ({ value: operator, label: OPERATOR_LABELS[operator] }));

export const COMBINE_OPTIONS: readonly ConditionOption[] = [
  { value: 'ALL', label: 'all of' },
  { value: 'ANY', label: 'any of' },
];

export const ITEM_OPTIONS: readonly ConditionOption[] = [
  { value: 'ANY', label: 'any item' },
  { value: 'ALL', label: 'every item' },
  { value: 'NONE', label: 'no item' },
];

export const PATHS_MODE_OPTIONS: readonly ConditionOption[] = [
  { value: 'ANY', label: 'any of' },
  { value: 'ALL', label: 'all of' },
];

export const TYPE_OPTIONS: readonly ConditionOption[] = JSON_TYPES.map((t) => ({ value: t, label: t }));

export function isJsonCondition(condition: Condition | undefined): boolean {
  return !!condition && (condition.subject === 'REQUEST_JSON_FIELD' || condition.subject === 'RESPONSE_JSON_FIELD');
}

/** A new subject. A subject that identifies nothing by name keeps no stale name, and JSON-only
 *  parts (other fields, the item mode, a JSON-only operator) go when it stops being a JSON field. */
export function withSubject(current: Condition, subject: ConditionSubject): Condition {
  const json = subject === 'REQUEST_JSON_FIELD' || subject === 'RESPONSE_JSON_FIELD';
  return {
    ...current,
    subject,
    name: SUBJECTS_NEEDING_NAME.has(subject) ? undefined : null,
    items: json ? current.items ?? 'ANY' : null,
    ...(json ? {} : { paths: null, pathsMode: null }),
    ...(!json && JSON_ONLY_OPERATORS.has(current.operator) ? { operator: 'EQUALS' as ConditionOperator, value: '' } : {}),
  };
}

export function withOperator(current: Condition, operator: ConditionOperator): Condition {
  return {
    ...current,
    operator,
    value: OPERATORS_WITHOUT_VALUE.has(operator)
      ? null
      : operator === 'TYPE_IS'
        ? (JSON_TYPES.includes(current.value as never) ? current.value : 'text')
        : undefined,
    values: LIST_VALUE_OPERATORS.has(operator) ? current.values ?? [] : null,
    // An item mode means nothing for a whole-field test; the backend refuses the pair.
    ...(WHOLE_FIELD_OPERATORS.has(operator) || operator.startsWith('NOT_') || operator === 'EXISTS' || operator === 'NOT_EXISTS'
      ? { items: isJsonCondition(current) ? 'ANY' : null }
      : {}),
  };
}

/** The operators this condition may use - JSON-only ones only on a JSON field, and none an item mode would contradict. */
export function operatorOptions(condition: Condition): readonly ConditionOption[] {
  if (condition.subject === 'RECORDED_CALL') {
    return [{ value: 'MATCHES', label: 'matches' }];
  }
  const json = isJsonCondition(condition);
  const moded = json && (condition.items === 'ALL' || condition.items === 'NONE');
  return OPERATOR_OPTIONS.filter((o) => {
    const op = o.value as ConditionOperator;
    if (!json && JSON_ONLY_OPERATORS.has(op)) return false;
    if (moded && (op.startsWith('NOT_') || WHOLE_FIELD_OPERATORS.has(op) || op === 'EXISTS' || op === 'NOT_EXISTS')) return false;
    return true;
  });
}

/** An item mode only reads as something when an operator compares items one by one. */
export function showsItemMode(condition: Condition): boolean {
  return isJsonCondition(condition) && !WHOLE_FIELD_OPERATORS.has(condition.operator) && condition.operator !== 'IS_EMPTY';
}

export function needsConditionName(condition: Condition): boolean {
  return SUBJECTS_NEEDING_NAME.has(condition.subject);
}

/** RECORDED_CALL compares against a frozen recording, not a literal value. */
export function needsConditionValue(condition: Condition): boolean {
  return condition.subject !== 'RECORDED_CALL' && !OPERATORS_WITHOUT_VALUE.has(condition.operator);
}

export function conditionNamePlaceholder(condition: Condition): string {
  if (isJsonCondition(condition)) return 'itinerary.seatsRemaining';
  return condition.subject === 'QUERY_PARAM' ? 'currency' : 'x-api-key';
}

/** Header-named subjects - where app-name-suggest offers header names from the call. */
export function namesHeader(condition: Condition): 'request' | 'response' | null {
  if (condition.subject === 'REQUEST_HEADER') return 'request';
  if (condition.subject === 'RESPONSE_HEADER') return 'response';
  return null;
}

/** A condition row is a subject AND an operator - reading one without the other is half an answer. */
export function conditionHelp(condition: Condition): readonly HelpEntry[] {
  return [helpForSubject(condition.subject), helpForOperator(condition.operator)];
}

/** URL, stable header names, and body note for a RECORDED_CALL row. */
export function recordedCallCriteria(preview: RecordedCallPreview | null): string {
  if (!preview) {
    return 'URL, method, headers that are not auto-generated, and the body (JSON or SOAP; spacing ignored)';
  }
  const headers = preview.headerNames.length ? preview.headerNames.join(', ') : 'none';
  return `${preview.method} ${preview.url}\nheaders: ${headers}\nbody: ${preview.bodyNote}`;
}

export function withPathAdded(c: Condition): Condition {
  return { ...c, paths: [...(c.paths ?? []), ''], pathsMode: c.pathsMode ?? 'ANY' };
}

export function withPathSet(c: Condition, index: number, value: string): Condition {
  return { ...c, paths: (c.paths ?? []).map((p, i) => (i === index ? value : p)) };
}

export function withPathRemoved(c: Condition, index: number): Condition {
  const paths = (c.paths ?? []).filter((_, i) => i !== index);
  return { ...c, paths, pathsMode: paths.length ? c.pathsMode ?? 'ANY' : null };
}

/** IN / CONTAINS_ALL chips: Enter or comma adds what is typed; empty Backspace takes the last off. */
export function withChipKey(c: Condition, key: string, typed: string): Condition | null {
  const values = c.values ?? [];
  if ((key === 'Enter' || key === ',') && typed.trim()) {
    const added = typed.split(',').map((v) => v.trim()).filter((v) => v && !values.includes(v));
    return { ...c, values: [...values, ...added] };
  }
  if (key === 'Backspace' && !typed && values.length) {
    return { ...c, values: values.slice(0, -1) };
  }
  return null;
}

export function withChipRemoved(c: Condition, index: number): Condition {
  return { ...c, values: (c.values ?? []).filter((_, i) => i !== index) };
}
