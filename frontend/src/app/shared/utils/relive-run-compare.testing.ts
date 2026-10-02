/** Builders for run-comparison specs (relive-run-compare, relive-run-compare component, History). */
import { FullRun } from './relive-run-compare';
import { ReliveCycle, Step, StepResult } from './relive-types';

export function cmpStep(key: string, overrides: Partial<Step> = {}): Step {
  return {
    key,
    parentKey: null,
    label: `Step ${key}`,
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'app',
    callRule: { name: key, enabled: true, priority: 0, stopProcessing: true, match: {}, actions: [] },
    unattributed: 'BLOCK',
    recording: {
      method: 'POST',
      url: `https://app.local/api/${key}`,
      requestHeaders: {},
      requestBody: '{}',
      status: 200,
      responseHeaders: {},
      responseBody: '{"ok":true}',
      timestamp: '2026-10-01T10:00:00Z',
      durationMs: 100,
      source: 'inbound',
    },
    source: { callId: key, cycleId: null, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
    ...overrides,
  };
}

export function cmpResult(stepKey: string, state: StepResult['state'], response: { status: number; body?: string; headers?: Record<string, string> } | null, overrides: Partial<StepResult> = {}): StepResult {
  return {
    runId: 'r',
    stepKey,
    attempt: 1,
    state,
    mode: 'LIVE',
    attribution: 'HEADER',
    actualRequest: { method: 'POST', url: `https://app.local/api/${stepKey}`, headers: {}, body: '{}' },
    actualResponse: response ? { status: response.status, headers: response.headers ?? {}, body: response.body ?? '{"ok":true}' } : undefined,
    differences: [],
    rulesApplied: [],
    variablesUsed: [],
    variablesProduced: [],
    unexpectedCalls: [],
    pauses: [],
    durationMs: 100,
    ...overrides,
  };
}

export function cmpCycle(steps: readonly Step[], overrides: Partial<ReliveCycle> = {}): ReliveCycle {
  return {
    id: 'c1',
    name: 'Booking',
    steps,
    variables: [],
    cycleRules: [],
    globalRules: { mode: 'NONE', selectedIds: [] },
    settings: { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] },
    noise: [],
    unexpectedCalls: { policy: 'BLOCK', rules: [], fallback: 'BLOCK' },
    transient: false,
    ...overrides,
  };
}

export function cmpRun(id: string, startedAt: string, steps: readonly Step[], results: readonly StepResult[], overrides: Partial<FullRun> = {}): FullRun {
  return {
    id,
    cycleId: 'c1',
    driver: 'AUTOMATIC',
    status: results.some((r) => r.state === 'FAILED') ? 'FAILED' : 'COMPLETED',
    startedAt,
    finishedAt: startedAt,
    definition: cmpCycle(steps),
    seedVariables: [],
    variableTimeline: [],
    summary: { total: steps.length, completed: results.length, different: 0, failed: 0, skipped: 0, notCalled: 0, cancelled: 0, live: 0, replayed: 0, unattributed: 0 },
    resumed: [],
    log: [],
    stepResults: results.map((r) => ({ ...r, runId: id })),
    secrets: [],
    ...overrides,
  };
}
