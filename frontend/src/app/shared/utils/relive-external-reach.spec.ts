import { applyMode, defaultCallRule } from './relive-call-rule';
import { externalReach, newlyReaching } from './relive-external-reach';
import { CycleVariable, FrozenCall, GlobalRulesSelection, ReliveCycle, ReliveSettings, Step, UnexpectedCallsPolicy } from './relive-types';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{}',
  status: 200,
  responseHeaders: {},
  responseBody: '{}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 100,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: ['internal.local'] };
const globalRules: GlobalRulesSelection = { mode: 'NONE', selectedIds: [] };
const variables: readonly CycleVariable[] = [];

function makeStep(overrides: Partial<Step> = {}): Step {
  const base: Step = {
    key: 'c-supA',
    parentKey: 's-search',
    label: 'POST /v2/search',
    enabled: true,
    optional: false,
    direction: 'outbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key: 'c-supA', parentKey: 's-search', label: 'POST /v2/search', recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: 'call-1', cycleId: null, direction: 'outbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
  return { ...base, ...overrides };
}

function makeCycle(steps: readonly Step[], unexpectedCalls: UnexpectedCallsPolicy = { policy: 'BLOCK', rules: [], fallback: 'BLOCK' }): ReliveCycle {
  return {
    id: 'c-1',
    name: 'Book flow',
    description: null,
    steps,
    variables,
    cycleRules: [],
    globalRules,
    settings,
    noise: [],
    unexpectedCalls,
    createdAt: null,
    updatedAt: null,
    transient: false,
    lastRun: null,
  };
}

describe('externalReach', () => {
  it('is empty for a fresh REPLAY child (fails closed by default)', () => {
    const cycle = makeCycle([makeStep()]);
    expect(externalReach(cycle).size).toBe(0);
  });

  it('flags an enabled LIVE child', () => {
    const step = makeStep();
    const liveStep = { ...step, callRule: applyMode(step.callRule, 'LIVE', recording) };
    const cycle = makeCycle([liveStep]);
    const reach = externalReach(cycle);
    expect(reach.has('c-supA')).toBeTrue();
    expect(reach.get('c-supA')?.host).toBe('api.supplier-a.com');
  });

  it('ignores a LIVE child on an internal host', () => {
    const internalRecording: FrozenCall = { ...recording, url: 'https://svc.internal.local/x' };
    const step = makeStep({ recording: internalRecording, callRule: defaultCallRule({ key: 'c-supA', parentKey: 's-search', label: 'x', recording: internalRecording }, settings) });
    const liveStep = { ...step, callRule: applyMode(step.callRule, 'LIVE', internalRecording) };
    const cycle = makeCycle([liveStep]);
    expect(externalReach(cycle).size).toBe(0);
  });

  it('ignores a disabled step even if LIVE', () => {
    const step = makeStep({ enabled: false });
    const liveStep = { ...step, callRule: applyMode(step.callRule, 'LIVE', recording) };
    const cycle = makeCycle([liveStep]);
    expect(externalReach(cycle).size).toBe(0);
  });

  it('flags the unexpected-call policy when it is Send to real', () => {
    const cycle = makeCycle([makeStep()], { policy: 'SEND_REAL', rules: [], fallback: 'BLOCK' });
    expect(externalReach(cycle).has('__unexpected')).toBeTrue();
  });

  it('flags the unexpected-call RULES fallback when it is Send to real', () => {
    const cycle = makeCycle([makeStep()], { policy: 'RULES', rules: [], fallback: 'SEND_REAL' });
    expect(externalReach(cycle).has('__unexpected')).toBeTrue();
  });

  it('flags a step whose unattributed choice is Send to real', () => {
    const step = makeStep({ unattributed: 'SEND_REAL' });
    const cycle = makeCycle([step]);
    expect(externalReach(cycle).has('__unattributed_c-supA')).toBeTrue();
  });
});

describe('newlyReaching', () => {
  it('returns only the keys added since the last snapshot', () => {
    const before = new Map([['a', { label: 'A', host: 'x', reason: 'r' }]]);
    const after = new Map([
      ['a', { label: 'A', host: 'x', reason: 'r' }],
      ['b', { label: 'B', host: 'y', reason: 'r2' }],
    ]);
    expect(newlyReaching(before, after)).toEqual(['b']);
  });

  it('is empty when nothing new was added', () => {
    const before = new Map([['a', { label: 'A', host: 'x', reason: 'r' }]]);
    expect(newlyReaching(before, before)).toEqual([]);
  });
});
