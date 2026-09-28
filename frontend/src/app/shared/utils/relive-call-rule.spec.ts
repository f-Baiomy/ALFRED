import { RuleAction } from '../../core/models/interception.model';
import {
  applyMode,
  checkpointOf,
  defaultCallRule,
  isModified,
  modeOf,
  onRequestChangedOf,
  reachesHost,
  setCheckpoint,
  setMockResponse,
  setOnRequestChanged,
} from './relive-call-rule';
import { CycleRule, FrozenCall, ReliveSettings, Step } from './relive-types';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{"origin":"DXB"}',
  status: 200,
  responseHeaders: { 'Content-Type': 'application/json' },
  responseBody: '{"results":12}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 420,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settingsLive: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const settingsReplay: ReliveSettings = { ...settingsLive, inboundMode: 'REPLAY' };

const child: Pick<Step, 'key' | 'parentKey' | 'label' | 'recording'> = {
  key: 'c-supA',
  parentKey: 's-search',
  label: 'POST /v2/search',
  recording,
};

const inbound: Pick<Step, 'key' | 'parentKey' | 'label' | 'recording'> = {
  key: 's-search',
  parentKey: null,
  label: 'POST /search',
  recording: { ...recording, url: 'https://app.local/search', source: 'inbound' },
};

describe('relive-call-rule: defaultCallRule', () => {
  it('gives a child an IF_REQUEST(FAIL) + MOCK_RESPONSE pipeline', () => {
    const rule = defaultCallRule(child, settingsLive);
    expect(modeOf(rule)).toBe('REPLAY');
    expect(onRequestChangedOf(rule)).toBe('FAIL');
  });

  it('replays a standalone outbound root without contacting the supplier', () => {
    const rule = defaultCallRule({ ...child, parentKey: null }, settingsLive);
    expect(modeOf(rule)).toBe('REPLAY');
    expect(reachesHost(rule).reaches).toBeFalse();
    expect(rule.actions.find((action) => action.type === 'MOCK_RESPONSE')?.body).toBe(recording.responseBody);
  });

  it('gives an inbound step an empty pipeline when inboundMode is LIVE', () => {
    const rule = defaultCallRule(inbound, settingsLive);
    expect(rule.actions).toEqual([]);
  });

  it('gives an inbound step a mock when inboundMode is REPLAY', () => {
    const rule = defaultCallRule(inbound, settingsReplay);
    expect(modeOf(rule)).toBe('REPLAY');
  });
});

describe('relive-call-rule: applyMode', () => {
  function ruleWithMock(): CycleRule {
    return defaultCallRule(child, settingsLive);
  }

  it('LIVE keeps edited mock data and switching back to REPLAY restores it', () => {
    let rule = ruleWithMock();
    // Edit the mock's body (as if the user typed a different recorded answer).
    rule = { ...rule, actions: rule.actions.map((a) => (a.type === 'MOCK_RESPONSE' ? { ...a, body: '{"edited":true}' } : a)) };

    rule = applyMode(rule, 'LIVE', recording);
    expect(modeOf(rule)).toBe('LIVE');
    const mockAfterLive = rule.actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mockAfterLive?.body).toBe('{"edited":true}');
    expect(mockAfterLive?.enabled).toBe(false);

    rule = applyMode(rule, 'REPLAY', recording);
    expect(modeOf(rule)).toBe('REPLAY');
    const mockAfterReplay = rule.actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mockAfterReplay?.body).toBe('{"edited":true}');
  });

  it('re-creates the mock from the recording when it was deleted', () => {
    let rule = ruleWithMock();
    rule = { ...rule, actions: rule.actions.filter((a) => a.type !== 'MOCK_RESPONSE') };
    expect(rule.actions.find((a) => a.type === 'MOCK_RESPONSE')).toBeUndefined();

    rule = applyMode(rule, 'REPLAY', recording);
    const mock = rule.actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mock).toBeDefined();
    expect(mock?.body).toBe(recording.responseBody);
    expect(mock?.enabled).not.toBe(false);
  });

  it('LIVE_MOCKED turns the replace on and the mock off', () => {
    let rule = ruleWithMock();
    rule = applyMode(rule, 'LIVE_MOCKED', recording);
    expect(modeOf(rule)).toBe('LIVE_MOCKED');
    const replace = rule.actions.find((a) => a.type === 'REPLACE_RESPONSE');
    expect(replace?.enabled).not.toBe(false);
    expect(replace?.body).toBe(recording.responseBody);
    const mock = rule.actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mock?.enabled).toBe(false);
  });

  it('never touches an unrelated action added through the rule editor', () => {
    let rule = ruleWithMock();
    const otherAction: RuleAction = { type: 'SET_REQUEST_HEADER', name: 'X-Debug', value: 'on', enabled: true };
    rule = { ...rule, actions: [...rule.actions, otherAction] };

    rule = applyMode(rule, 'LIVE', recording);
    expect(rule.actions.some((a) => a.type === 'SET_REQUEST_HEADER' && a.name === 'X-Debug')).toBeTrue();
  });
});

describe('relive-call-rule: setMockResponse (T074 "Mock with it")', () => {
  it('overwrites the mock status/body and switches LIVE back to REPLAY', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = applyMode(rule, 'LIVE', recording);

    rule = setMockResponse(rule, recording, 500, '{"error":"boom"}');

    expect(modeOf(rule)).toBe('REPLAY');
    const mock = rule.actions.find((a) => a.type === 'MOCK_RESPONSE');
    expect(mock?.status).toBe(500);
    expect(mock?.body).toBe('{"error":"boom"}');
  });
});

describe('relive-call-rule: request-differs (onRequestChanged)', () => {
  it('FAIL is the default for a fresh child', () => {
    const rule = defaultCallRule(child, settingsLive);
    expect(onRequestChangedOf(rule)).toBe('FAIL');
  });

  it('ASK sets a PAUSE_REQUEST as the differs-branch', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = setOnRequestChanged(rule, 'ASK', child.key);
    expect(onRequestChangedOf(rule)).toBe('ASK');
  });

  it('LIVE sets SEND_TO_HOST as the differs-branch', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = setOnRequestChanged(rule, 'LIVE', child.key);
    expect(onRequestChangedOf(rule)).toBe('LIVE');
  });

  it('REPLAY removes the condition entirely', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = setOnRequestChanged(rule, 'REPLAY', child.key);
    expect(onRequestChangedOf(rule)).toBe('REPLAY');
    expect(rule.actions.some((a) => a.type === 'IF_REQUEST')).toBeFalse();
  });
});

describe('relive-call-rule: checkpoints', () => {
  it('setCheckpoint before/after adds PAUSE_REQUEST/PAUSE_RESPONSE and checkpointOf reads them back', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = setCheckpoint(rule, 'before', true, 45);
    rule = setCheckpoint(rule, 'after', true, 45);
    const cp = checkpointOf(rule);
    expect(cp.before).toBeTrue();
    expect(cp.after).toBeTrue();
    expect(cp.timeoutSeconds).toBe(45);

    rule = setCheckpoint(rule, 'before', false);
    expect(checkpointOf(rule).before).toBeFalse();
  });
});

describe('relive-call-rule: reachesHost', () => {
  it('is true when the mock is turned off', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = applyMode(rule, 'LIVE', recording);
    expect(reachesHost(rule).reaches).toBeTrue();
  });

  it('is true when the mock action was deleted entirely', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = { ...rule, actions: rule.actions.filter((a) => a.type !== 'MOCK_RESPONSE') };
    expect(reachesHost(rule).reaches).toBeTrue();
  });

  it('is true when the request-differs branch is SEND_TO_HOST (LIVE)', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = setOnRequestChanged(rule, 'LIVE', child.key);
    expect(reachesHost(rule).reaches).toBeTrue();
  });

  it('is true when a REWRITE_URL action is present', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = { ...rule, actions: rule.actions.map((a) => (a.type === 'MOCK_RESPONSE' ? { ...a, enabled: false } : a)) };
    rule = { ...rule, actions: [...rule.actions, { type: 'REWRITE_URL', enabled: true, target: { host: 'other.example.com' } }] };
    expect(reachesHost(rule).reaches).toBeTrue();
  });

  it('is false when the request-differs branch is FAIL', () => {
    const rule = defaultCallRule(child, settingsLive); // default is FAIL
    expect(reachesHost(rule).reaches).toBeFalse();
  });

  it('is false when the request-differs branch is a PAUSE (ASK)', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = setOnRequestChanged(rule, 'ASK', child.key);
    expect(reachesHost(rule).reaches).toBeFalse();
  });
});

describe('relive-call-rule: isModified', () => {
  it('is false for a freshly built rule', () => {
    const rule = defaultCallRule(child, settingsLive);
    expect(isModified(rule, child, settingsLive)).toBeFalse();
  });

  it('is true once the mock body is edited', () => {
    let rule = defaultCallRule(child, settingsLive);
    rule = { ...rule, actions: rule.actions.map((a) => (a.type === 'MOCK_RESPONSE' ? { ...a, body: '{"edited":true}' } : a)) };
    expect(isModified(rule, child, settingsLive)).toBeTrue();
  });
});
