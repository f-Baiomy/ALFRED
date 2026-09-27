import { of, throwError } from 'rxjs';
import { InterceptionRule } from '../../core/models/interception.model';
import {
  buildInterceptionLogGroups,
  friendlyInterceptionAction,
  openInterceptionRule,
  parseCaptureLink,
  parseDelayMs,
} from './interception-log';

describe('buildInterceptionLogGroups', () => {
  it('returns an empty list for a call with no interception at all', () => {
    expect(buildInterceptionLogGroups(null)).toEqual([]);
    expect(buildInterceptionLogGroups(undefined)).toEqual([]);
  });

  it('groups consecutive actions from the same rule and numbers them in execution order', () => {
    const groups = buildInterceptionLogGroups({
      applied: [
        { ruleId: 'same', ruleName: 'Booking rule', action: 'DELAY_REQUEST', detail: '5000 ms' },
        { ruleId: 'same', ruleName: 'Booking rule', action: 'SET_REQUEST_JSON_FIELD', detail: 'test[1].added' },
        { ruleId: 'other', ruleName: 'Other rule', action: 'SET_RESPONSE_HEADER', detail: 'X-Test' },
      ],
    });

    expect(groups.length).toBe(2);
    expect(groups[0].ruleId).toBe('same');
    expect(groups[0].actions.map((a) => a.number)).toEqual([1, 2]);
    expect(groups[1].ruleId).toBe('other');
    expect(groups[1].actions[0].number).toBe(3);
  });

  it('labels an entry with no ruleName as "Manual edit"', () => {
    const groups = buildInterceptionLogGroups({ applied: [{ action: 'BREAKPOINT_REQUEST' }] });
    expect(groups[0].ruleName).toBe('Manual edit');
  });
});

describe('friendlyInterceptionAction', () => {
  it('renders known prefixes with friendlier words', () => {
    expect(friendlyInterceptionAction('CAPTURE_GLOBAL')).toBe('Captured variable');
    expect(friendlyInterceptionAction('SET_REQUEST_JSON_FIELD')).toBe('Set JSON field');
    expect(friendlyInterceptionAction('DELAY_REQUEST')).toBe('Waited');
  });

  it('falls back to title-cased words for anything else', () => {
    expect(friendlyInterceptionAction('MOCK_RESPONSE')).toBe('Mock response');
  });
});

describe('parseCaptureLink', () => {
  it('splits a GLOBAL capture detail on its trailing "-> {{name}}"', () => {
    expect(parseCaptureLink('Authorization header -> {{token}}')).toEqual({ prefix: 'Authorization header', name: 'token' });
  });

  it('returns null for a LOCAL capture (this.x) or plain text', () => {
    expect(parseCaptureLink('Authorization header -> this.token')).toBeNull();
    expect(parseCaptureLink('X-Test')).toBeNull();
    expect(parseCaptureLink(null)).toBeNull();
    expect(parseCaptureLink(undefined)).toBeNull();
  });
});

describe('parseDelayMs', () => {
  it('parses the injected delay out of a DELAY_* detail', () => {
    expect(parseDelayMs('1500 ms')).toBe(1500);
    expect(parseDelayMs('250ms')).toBe(250);
  });

  it('returns null for zero, negative or unparsable details', () => {
    expect(parseDelayMs('0 ms')).toBeNull();
    expect(parseDelayMs('X-Test')).toBeNull();
    expect(parseDelayMs(null)).toBeNull();
  });
});

describe('openInterceptionRule', () => {
  const rule: InterceptionRule = { id: 'r-1', name: 'Login token', match: {}, actions: [] } as unknown as InterceptionRule;

  it('opens the rule in the dialog when it is still found', () => {
    const api = { listRules: () => of([rule]) };
    const openRule = jasmine.createSpy('openRule');
    const onError = jasmine.createSpy('onError');
    const onDone = jasmine.createSpy('onDone');

    openInterceptionRule(api, { openRule }, 'r-1', { onError, onDone });

    expect(openRule).toHaveBeenCalledWith(rule);
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('reports the rule is gone when the current rule list no longer has it', () => {
    const api = { listRules: () => of([]) };
    const openRule = jasmine.createSpy('openRule');
    const onError = jasmine.createSpy('onError');
    const onDone = jasmine.createSpy('onDone');

    openInterceptionRule(api, { openRule }, 'r-1', { onError, onDone });

    expect(openRule).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('This rule no longer exists.');
    expect(onDone).toHaveBeenCalled();
  });

  it('reports a fetch failure distinctly', () => {
    const api = { listRules: () => throwError(() => new Error('boom')) };
    const onError = jasmine.createSpy('onError');
    const onDone = jasmine.createSpy('onDone');

    openInterceptionRule(api, { openRule: jasmine.createSpy() }, 'r-1', { onError, onDone });

    expect(onError).toHaveBeenCalledWith('Could not load the rule. Try again.');
    expect(onDone).toHaveBeenCalled();
  });
});
