import {
  ACTION_LABELS,
  ActionType,
  ConditionOperator,
  ConditionSubject,
  FAILURE_LABELS,
  FailureMode,
  OPERATOR_LABELS,
  SUBJECT_LABELS,
} from '../../core/models/interception.model';
import { ACTION_HELP, FAILURE_HELP, OPERATOR_HELP, SUBJECT_HELP } from './interception-help';

/**
 * The guard that keeps the help honest.
 *
 * Help that covers most of the vocabulary is worse than none: the gap is invisible until somebody
 * clicks the one control nobody wrote about. These walk the vocabularies themselves, so an action
 * or an operator added later cannot ship undocumented - the same shape as the engine's
 * EveryActionIsCoveredTest.
 */
describe('interception help', () => {
  it('documents every action there is', () => {
    const actions = Object.keys(ACTION_LABELS) as ActionType[];

    expect(actions.filter((type) => !ACTION_HELP[type])).toEqual([]);
  });

  it('documents every condition subject and operator', () => {
    const subjects = Object.keys(SUBJECT_LABELS) as ConditionSubject[];
    const operators = Object.keys(OPERATOR_LABELS) as ConditionOperator[];

    expect(subjects.filter((subject) => !SUBJECT_HELP[subject])).toEqual([]);
    expect(operators.filter((operator) => !OPERATOR_HELP[operator])).toEqual([]);
  });

  it('documents every failure mode', () => {
    const modes = Object.keys(FAILURE_LABELS) as FailureMode[];

    expect(modes.filter((mode) => !FAILURE_HELP[mode])).toEqual([]);
  });

  it('gives every entry a wire code that matches the key it is filed under', () => {
    // The code is shown in the panel precisely so what you read here matches what the call log
    // prints. A mismatch would make the two disagree about the same thing.
    for (const [key, entry] of Object.entries({ ...ACTION_HELP, ...SUBJECT_HELP, ...OPERATOR_HELP })) {
      expect(entry.code).withContext(key).toBe(key);
    }
  });

  it('says something real rather than restating the label', () => {
    for (const [key, entry] of Object.entries({ ...ACTION_HELP, ...SUBJECT_HELP, ...OPERATOR_HELP })) {
      expect(entry.what.length).withContext(`${key} explanation`).toBeGreaterThan(40);
      expect(entry.title.length).withContext(`${key} title`).toBeGreaterThan(0);
    }
  });

  it('names the raw-versus-parsed trap on the body subjects, which is the one that cost real time', () => {
    expect(SUBJECT_HELP.REQUEST_BODY.warning).toContain('PRETTY-PRINT');
    expect(SUBJECT_HELP.REQUEST_JSON_FIELD.what).toContain('formatting do not matter');
  });

  it('warns that a negative operator is satisfied by something missing', () => {
    // The single most surprising semantic in the whole feature.
    for (const operator of ['NOT_EQUALS', 'NOT_CONTAINS', 'NOT_MATCHES'] as ConditionOperator[]) {
      expect(OPERATOR_HELP[operator].warning ?? '').withContext(operator).toMatch(/absent|missing/i);
    }
  });
});
