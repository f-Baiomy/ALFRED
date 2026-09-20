import {
  Condition,
  ConditionBranch,
  OPERATORS_WITHOUT_VALUE,
  RESPONSE_SUBJECTS,
  SUBJECTS_NEEDING_NAME,
  actionPhase,
  describeAction,
  describeBranch,
  describeCondition,
  isConditionalAction,
} from './interception.model';

/**
 * The condition vocabulary. These are the plain-language forms the editor and the call log both
 * read from, so they are worth pinning: a condition that reads one way in the form and another
 * way in the log is a condition nobody trusts.
 */
describe('condition model', () => {
  it('reads a condition back as a sentence', () => {
    const condition: Condition = { subject: 'REQUEST_HEADER', name: 'x-api-key', operator: 'NOT_EXISTS' };

    expect(describeCondition(condition)).toBe('Request header x-api-key does not exist');
  });

  it('leaves the value out of an existence check, which compares against nothing', () => {
    expect(describeCondition({ subject: 'REQUEST_BODY', operator: 'EXISTS', value: 'ignored' }))
      .toBe('Request body exists');
  });

  it('joins a branch with and, or with or when it is any-of', () => {
    const conditions: Condition[] = [
      { subject: 'RESPONSE_STATUS', operator: 'AT_LEAST', value: '500' },
      { subject: 'RESPONSE_BODY', operator: 'CONTAINS', value: 'RATE_LIMIT' },
    ];

    expect(describeBranch({ combine: 'ALL', conditions, actions: [] }))
      .toBe('Response status is at least 500 and Response body contains RATE_LIMIT');
    expect(describeBranch({ combine: 'ANY', conditions, actions: [] })).toContain(' or ');
  });

  it('puts a conditional in the lane its name says', () => {
    // The whole reason there are two action types rather than one with a phase field.
    expect(actionPhase('IF_REQUEST')).toBe('request');
    expect(actionPhase('IF_RESPONSE')).toBe('response');
    expect(isConditionalAction('IF_RESPONSE')).toBeTrue();
    expect(isConditionalAction('MOCK_RESPONSE')).toBeFalse();
  });

  it('summarises a conditional by its shape, since its actions are nested out of sight', () => {
    const branch: ConditionBranch = { conditions: [], actions: [] };

    expect(describeAction({ type: 'IF_REQUEST', branches: [branch] })).toBe('If 1 condition');
    expect(describeAction({ type: 'IF_REQUEST', branches: [branch, branch], otherwise: [{ type: 'SEND_TO_HOST' }] }))
      .toBe('If 2 branches · else');
  });

  it('knows which subjects need a name and which do not exist yet in the request phase', () => {
    expect(SUBJECTS_NEEDING_NAME.has('REQUEST_HEADER')).toBeTrue();
    expect(SUBJECTS_NEEDING_NAME.has('METHOD')).toBeFalse();
    expect(RESPONSE_SUBJECTS.has('RESPONSE_STATUS')).toBeTrue();
    expect(RESPONSE_SUBJECTS.has('URL')).toBeFalse();
    expect(OPERATORS_WITHOUT_VALUE.has('NOT_EXISTS')).toBeTrue();
    expect(OPERATORS_WITHOUT_VALUE.has('NOT_EQUALS')).toBeFalse();
  });
});
