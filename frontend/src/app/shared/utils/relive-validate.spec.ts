import { applyMode, defaultCallRule } from './relive-call-rule';
import { validateCycle } from './relive-validate';
import { CycleRule, FrozenCall, GlobalRulesSelection, ReliveCycle, ReliveSettings, Step, UnexpectedCallsPolicy } from './relive-types';

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

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };
const globalRules: GlobalRulesSelection = { mode: 'NONE', selectedIds: [] };
const unexpectedCalls: UnexpectedCallsPolicy = { policy: 'BLOCK', rules: [], fallback: 'BLOCK' };

function makeStep(key: string, parentKey: string | null, overrides: Partial<Step> = {}): Step {
  return {
    key,
    parentKey,
    label: key,
    enabled: true,
    optional: false,
    direction: parentKey ? 'outbound' : 'inbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key, parentKey, label: key, recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: key, cycleId: null, direction: parentKey ? 'outbound' : 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...overrides,
  };
}

function cycle(overrides: Partial<ReliveCycle> = {}): ReliveCycle {
  return {
    id: 'c-1',
    name: 'Book flow',
    description: null,
    steps: [],
    variables: [],
    cycleRules: [],
    globalRules,
    settings,
    noise: [],
    unexpectedCalls,
    createdAt: null,
    updatedAt: null,
    transient: false,
    lastRun: null,
    ...overrides,
  };
}

function has(findings: ReturnType<typeof validateCycle>, code: string): boolean {
  return findings.some((f) => f.code === code);
}

describe('validateCycle', () => {
  it('MISSING_RECORDING is blocking', () => {
    const step = { ...makeStep('s-1', null), recording: null as unknown as FrozenCall };
    expect(has(validateCycle(cycle({ steps: [step] })), 'MISSING_RECORDING')).toBeTrue();
  });

  it('DUPLICATE_STEP is blocking', () => {
    const findings = validateCycle(cycle({ steps: [makeStep('dup', null), makeStep('dup', null)] }));
    expect(has(findings, 'DUPLICATE_STEP')).toBeTrue();
  });

  it('NOTHING_TO_RUN when every step is disabled', () => {
    const findings = validateCycle(cycle({ steps: [makeStep('s-1', null, { enabled: false })] }));
    expect(has(findings, 'NOTHING_TO_RUN')).toBeTrue();
  });

  it('blocks an empty cycle before a run starts', () => {
    const finding = validateCycle(cycle()).find((entry) => entry.code === 'NOTHING_TO_RUN');
    expect(finding?.severity).toBe('BLOCK');
    expect(finding?.message).toContain('Add calls');
  });

  it('GLOBAL_RULE_GONE when a selected global rule no longer exists', () => {
    const findings = validateCycle(
      cycle({ steps: [makeStep('s-1', null)], globalRules: { mode: 'SELECTED', selectedIds: ['r-gone'] } }),
      new Set(['r-exists']),
    );
    expect(has(findings, 'GLOBAL_RULE_GONE')).toBeTrue();
  });

  it('RULE_OVERLAP when two cycle rules share the same match', () => {
    const ruleA: CycleRule = { name: 'A', match: { host: 'x' }, actions: [] };
    const ruleB: CycleRule = { name: 'B', match: { host: 'x' }, actions: [] };
    const findings = validateCycle(cycle({ cycleRules: [ruleA, ruleB] }));
    expect(has(findings, 'RULE_OVERLAP')).toBeTrue();
    expect(has(validateCycle(cycle({ cycleRules: [{ ...ruleA, enabled: false }, ruleB] })), 'RULE_OVERLAP')).toBeFalse();
  });

  it('LIVE_EXTERNAL for a child step that reaches a real host', () => {
    const child = makeStep('c-1', 's-1');
    const liveChild = { ...child, callRule: applyMode(child.callRule, 'LIVE', recording) };
    const findings = validateCycle(cycle({ steps: [makeStep('s-1', null), liveChild] }));
    expect(has(findings, 'LIVE_EXTERNAL')).toBeTrue();
  });

  it('MAY_BE_UNATTRIBUTED for a Guided driver', () => {
    const findings = validateCycle(cycle({ settings: { ...settings, defaultDriver: 'GUIDED' } }));
    expect(has(findings, 'MAY_BE_UNATTRIBUTED')).toBeTrue();
  });

  it('UNRESOLVED_VARIABLE when a token is used but never declared', () => {
    const step = makeStep('s-1', null);
    const withToken = { ...step, callRule: { ...step.callRule, actions: [...step.callRule.actions, { type: 'SET_REQUEST_HEADER' as const, name: 'X', value: '{{token}}', enabled: true }] } };
    const findings = validateCycle(cycle({ steps: [withToken] }));
    expect(has(findings, 'UNRESOLVED_VARIABLE')).toBeTrue();
  });

  it('UNUSED_VARIABLE when a variable is declared but never referenced', () => {
    const findings = validateCycle(cycle({ variables: [{ name: 'unused', value: 'v', secret: false, note: null }] }));
    expect(has(findings, 'UNUSED_VARIABLE')).toBeTrue();
  });

  it('ORDER_DEPENDENCY when a step uses a variable only a later step extracts', () => {
    const early = makeStep('s-early', null);
    const withToken = { ...early, callRule: { ...early.callRule, actions: [...early.callRule.actions, { type: 'SET_QUERY_PARAM' as const, name: 'sid', value: '{{searchId}}', enabled: true }] } };
    const later = makeStep('s-later', null, { extract: [{ from: 'JSON', path: '$.id', as: 'searchId', missing: 'SKIP' }] });
    const findings = validateCycle(cycle({ steps: [withToken, later] }));
    expect(has(findings, 'ORDER_DEPENDENCY')).toBeTrue();
  });
});
