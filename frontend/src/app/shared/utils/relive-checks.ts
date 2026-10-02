import { Condition, ConditionOperator, describeCondition } from '../../core/models/interception.model';
import { Assertion } from './scenario-types';

/**
 * A Relive step's "Check the response": groups of rule conditions. Each group is one IF block -
 * its conditions joined ALL (and) or ANY (or) - and every group must pass. What a miss means
 * (FAIL: the step fails and the run holds there; WARN: a warning, the run carries on) belongs to
 * the group, with one default for the step. The proxy evaluates them with the rule engine's own
 * condition code (POST /relive-cycles/checks/evaluate), for the editor's "On the recording"
 * preview and for a run's result alike.
 *
 * Stored in the step's `assertions` field (opaque to the backend). A step saved before checks
 * existed holds the older Assertion[] there; `stepChecks` reads either.
 */

export type CheckOnMiss = 'FAIL' | 'WARN';

export interface CheckGroup {
  readonly combine: 'ALL' | 'ANY';
  /** DEFAULT follows the step's own `onMiss`. */
  readonly onMiss: 'DEFAULT' | CheckOnMiss;
  readonly conditions: readonly Condition[];
}

export interface StepChecks {
  readonly version: 2;
  readonly onMiss: CheckOnMiss;
  readonly groups: readonly CheckGroup[];
}

export type StepAssertions = StepChecks | readonly Assertion[];

/** What one condition found in the answer - see proxy/interception.py `_explain`. */
export interface CheckFound {
  readonly fields?: readonly { readonly path: string; readonly count: number; readonly values: readonly (string | null)[]; readonly itemHolds?: readonly boolean[] | null }[];
  readonly values?: readonly (string | null)[];
}

export interface CheckRowResult {
  readonly holds: boolean;
  readonly error?: string;
  readonly found?: CheckFound;
}

export interface CheckGroupResult {
  readonly passed: boolean;
  readonly rows: readonly CheckRowResult[];
}

/** A run's check results, stored on the StepResult (its `assertions`). */
export interface StepCheckResults {
  readonly kind: 'checks';
  readonly groups: readonly (CheckGroupResult & { readonly onMiss: CheckOnMiss; readonly combine: 'ALL' | 'ANY'; readonly conditions: readonly Condition[] })[];
  /** Set when the checks could not be evaluated at all (the proxy did not answer). */
  readonly error?: string | null;
}

export const EMPTY_CHECKS: StepChecks = { version: 2, onMiss: 'FAIL', groups: [] };

export function isStepChecks(raw: unknown): raw is StepChecks {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as StepChecks).version === 2;
}

/** The step's checks, converting an older Assertion[] (every one had to pass, a miss failed). */
export function stepChecks(raw: unknown): StepChecks {
  if (isStepChecks(raw)) return raw;
  if (!Array.isArray(raw) || !raw.length) return EMPTY_CHECKS;
  return { version: 2, onMiss: 'FAIL', groups: [{ combine: 'ALL', onMiss: 'DEFAULT', conditions: (raw as Assertion[]).map(assertionToCondition) }] };
}

export function checkCount(checks: StepChecks): number {
  return checks.groups.reduce((n, g) => n + g.conditions.length, 0);
}

export function effectiveOnMiss(checks: StepChecks, group: CheckGroup): CheckOnMiss {
  return group.onMiss === 'DEFAULT' ? checks.onMiss : group.onMiss;
}

const PATH_PREFIX = /^\$\.?/;

/** One older Assertion as the condition that means the same thing. */
export function assertionToCondition(a: Assertion): Condition {
  const op = a.operator;
  const numeric = op === 'GT' || op === 'LT';
  const n = Number(a.value);
  const whole = Number.isInteger(n);
  const operator: ConditionOperator = op === 'GT' ? 'AT_LEAST' : op === 'LT' ? 'AT_MOST' : (op as ConditionOperator);
  const value = numeric && whole ? String(op === 'GT' ? n + 1 : n - 1) : a.value ?? null;
  switch (a.kind) {
    case 'STATUS':
      return { subject: 'RESPONSE_STATUS', operator, value };
    case 'HEADER':
      return { subject: 'RESPONSE_HEADER', name: a.path ?? '', operator, value };
    case 'LATENCY':
      return { subject: 'RESPONSE_TIME', operator, value };
    default:
      return { subject: 'RESPONSE_JSON_FIELD', name: (a.path ?? '').replace(PATH_PREFIX, ''), operator, value };
  }
}

/** A new check: a working example rather than a blank form. */
export function defaultCheck(): Condition {
  return { subject: 'RESPONSE_STATUS', operator: 'EQUALS', value: '200' };
}

/** The payload POST /relive-cycles/checks/evaluate takes. */
export function evaluationRequest(checks: StepChecks, answer: { status: number | null; headers: Readonly<Record<string, string>>; body: string | null },
                                  responseTimeMs: number | null) {
  return {
    groups: checks.groups.map((g) => ({ combine: g.combine, conditions: g.conditions })),
    answer: { status: answer.status ?? 0, headers: answer.headers, body: answer.body },
    responseTimeMs,
  };
}

/** The proxy's verdicts joined to the groups they are for. */
export function checkResults(checks: StepChecks, groups: readonly CheckGroupResult[] | null, error: string | null = null): StepCheckResults {
  return {
    kind: 'checks',
    error,
    groups: checks.groups.map((g, i) => {
      const got = groups?.[i];
      const rows = got?.rows ?? g.conditions.map(() => ({ holds: false, error: error ?? 'not evaluated' }));
      return { combine: g.combine, onMiss: effectiveOnMiss(checks, g), conditions: g.conditions, passed: got?.passed ?? false, rows };
    }),
  };
}

export function isCheckResults(raw: unknown): raw is StepCheckResults {
  return !!raw && typeof raw === 'object' && (raw as StepCheckResults).kind === 'checks';
}

export interface CheckTally {
  readonly passed: number;
  readonly failed: number;
  readonly warned: number;
}

export function tally(results: StepCheckResults | null | undefined): CheckTally {
  const groups = results?.groups ?? [];
  const failed = groups.filter((g) => !g.passed && g.onMiss === 'FAIL').length;
  const warned = groups.filter((g) => !g.passed && g.onMiss === 'WARN').length;
  return { passed: groups.length - failed - warned, failed, warned };
}

/** "Check 2 failed: none of … holds" - for the step's reasons and the run's hold box. */
export function missLines(results: StepCheckResults | null | undefined): readonly { readonly failed: boolean; readonly text: string }[] {
  const groups = results?.groups ?? [];
  return groups.flatMap((g, i) => {
    if (g.passed) return [];
    const parts = g.conditions.map((c) => describeCondition(c));
    const what = g.conditions.length > 1 ? `${g.combine === 'ANY' ? 'none of' : 'not all of'}: ${parts.join(g.combine === 'ANY' ? ' OR ' : ' AND ')}` : parts[0] ?? 'the check';
    const label = groups.length > 1 ? `Check ${i + 1}` : 'Check';
    return [{ failed: g.onMiss === 'FAIL', text: `${label} ${g.onMiss === 'FAIL' ? 'failed' : 'warning'} - ${what}${results?.error ? ` (${results.error})` : ''}` }];
  });
}

/** A short line for what a condition found: "got 200", "14 items · 2 do not match". */
export function foundLine(row: CheckRowResult): string {
  if (row.error) return row.error;
  const found = row.found;
  if (!found) return '';
  if (found.fields) {
    return found.fields
      .map((f) => {
        const misses = f.itemHolds ? f.itemHolds.filter((h) => !h).length : 0;
        const head = f.count === 1 && !f.itemHolds ? `got ${f.values[0] ?? 'null'}` : f.count ? `${f.count} item${f.count === 1 ? '' : 's'}` : 'not found';
        return `${f.path}: ${head}${f.itemHolds && f.count ? (misses ? ` · ${misses} do not match` : ' · all match') : ''}`;
      })
      .join(' · ');
  }
  const values = found.values ?? [];
  return values.length ? `got ${values.map((v) => v ?? 'null').join(', ')}` : 'not found';
}
