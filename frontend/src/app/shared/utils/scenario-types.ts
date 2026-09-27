/**
 * Backend-wire shapes for the scenarios slice (contracts.md section 3) plus the small pieces of
 * section 6 that are genuinely F-SCENARIO's own (AssertionResult, ScenarioRunResults) - opaque to
 * the backend, never read by anyone else.
 *
 * `Assertion`/`ExtractRule`/`RetryPolicy`/`Dataset`/`DraftResult` and `ScenarioDefinition` are NOT
 * redeclared here: F-RESEND landed the real ones in `shared/utils/resend-draft.ts` (the first four)
 * and `core/services/bulk-resend-dialog.service.ts` (`ScenarioDefinition`) - re-exported below so
 * existing imports of this file keep working.
 */
export type { Assertion, ExtractRule, RetryPolicy, Dataset, DraftResult } from './resend-draft';
export type { ScenarioDefinition } from '../../core/services/bulk-resend-dialog.service';

import { Assertion, DraftResult } from './resend-draft';

/** contracts.md section 3 - Scenario/Run wire shapes (backend-scenarios), opaque `definition`/`results`. */
export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Omitted by GET /scenarios (list view); present on GET /scenarios/{id}. */
  readonly definition?: import('../../core/services/bulk-resend-dialog.service').ScenarioDefinition;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRun: RunSummary | null;
}

export interface AssertionResult {
  readonly assertion: Assertion;
  readonly passed: boolean;
  readonly actual: string;
  readonly message: string;
}

/** What a run's opaque `results` holds - F-SCENARIO's own shape, since the backend never looks inside it. */
export interface ScenarioRunResults {
  readonly draftResults: readonly DraftResult[];
  readonly assertionResults: Readonly<Record<string /* draft key */, readonly AssertionResult[]>>;
}

export interface ScenarioRun {
  readonly id: string;
  readonly scenarioId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly summary: RunSummary;
  /** Omitted by GET .../runs (list view); present on GET .../runs/{runId}. */
  readonly results?: ScenarioRunResults;
}
