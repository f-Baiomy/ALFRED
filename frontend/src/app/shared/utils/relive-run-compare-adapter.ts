/**
 * Adapts a Relive run's `StepResult[]` into the shape `ScenarioRunCompareComponent` (D1, built for
 * scenario runs' `DraftResult[]`) already knows how to diff, so the History tab's "Compare with
 * newest" (T072) can reuse it rather than a parallel step-diff viewer.
 */
import { DraftResult } from './resend-draft';
import { Run, StepResult } from './relive-types';
import { RunSummary, ScenarioRun } from './scenario-types';

interface ActualResponseShape {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

function isResponseShape(value: unknown): value is ActualResponseShape {
  return !!value && typeof value === 'object' && typeof (value as ActualResponseShape).status === 'number';
}

function draftResultOf(result: StepResult): DraftResult {
  const response = isResponseShape(result.actualResponse) ? result.actualResponse : null;
  return {
    key: result.stepKey,
    attempt: result.attempt,
    status: response?.status ?? null,
    durationMs: result.durationMs ?? null,
    newCallId: null,
    error: result.error ?? null,
    response,
    extracted: Object.fromEntries(result.variablesProduced.map((v) => [v.name, v.value])),
  };
}

function summaryOf(results: readonly StepResult[]): RunSummary {
  const total = results.length;
  const failed = results.filter((r) => r.state === 'FAILED').length;
  const errored = results.filter((r) => r.state === 'COMPLETED_WITH_DIFFERENCES').length;
  return { total, passed: total - failed - errored, failed, errored };
}

export function reliveRunToScenarioRun(run: Run, results: readonly StepResult[]): ScenarioRun {
  return {
    id: run.id,
    scenarioId: run.cycleId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? '',
    summary: summaryOf(results),
    results: { draftResults: results.map(draftResultOf), assertionResults: {} },
  };
}
