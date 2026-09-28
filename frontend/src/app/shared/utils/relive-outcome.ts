/**
 * A step's outcome (FR-034a): Failed on a transport error, timeout, no answer, a 5xx response, a
 * change of status class compared with the recording (e.g. 2xx → 4xx), or any failed assertion;
 * otherwise Completed with differences when at least one UNEXPECTED difference remains (expected
 * differences, FR-041, never change the outcome); otherwise Completed.
 */
import { AssertionResult } from './scenario-types';
import { DifferenceEntry, FrozenCall } from './relive-types';

export type StepOutcome = 'COMPLETED' | 'COMPLETED_WITH_DIFFERENCES' | 'FAILED';

/** What actually happened, as far as the outcome check cares - not the whole logged call. */
export interface ActualCallOutcome {
  readonly transportError: boolean;
  readonly timedOut: boolean;
  /** No response at all was ever received (distinct from a transport error/timeout - e.g. the
   *  call was blocked/aborted and there is genuinely nothing to grade). */
  readonly noAnswer: boolean;
  readonly status: number | null;
}

function statusClass(status: number): number {
  return Math.floor(status / 100);
}

export function outcomeOf(
  actual: ActualCallOutcome,
  recording: Pick<FrozenCall, 'status'>,
  assertionResults: readonly AssertionResult[],
  differences: readonly DifferenceEntry[],
): StepOutcome {
  if (actual.transportError || actual.timedOut || actual.noAnswer || actual.status == null) {
    return 'FAILED';
  }
  if (statusClass(actual.status) === 5) {
    return 'FAILED';
  }
  if (statusClass(actual.status) !== statusClass(recording.status)) {
    return 'FAILED';
  }
  if (assertionResults.some((a) => !a.passed)) {
    return 'FAILED';
  }
  if (differences.some((d) => d.kind === 'UNEXPECTED')) {
    return 'COMPLETED_WITH_DIFFERENCES';
  }
  return 'COMPLETED';
}
