/**
 * Instant-feedback mirror of the backend's `CycleValidator` (FR-017, data-model.md
 * "ValidationFinding") - same 10 codes, same rules, so what the user sees while editing never
 * disagrees with what `POST /relive-cycles/{id}/validate` says before a run. The backend copy is
 * authoritative; this one only saves a round trip.
 */
import { reachesHost } from './relive-call-rule';
import { tokenNames } from './variable-tokens';
import { CycleRule, ReliveCycle, Step, ValidationFinding, ValidationFindingCode } from './relive-types';

function finding(severity: 'BLOCK' | 'WARN', code: ValidationFindingCode, stepKey: string | null, message: string): ValidationFinding {
  return { severity, code, stepKey, message };
}

function collectTokens(rule: CycleRule | null | undefined, into: Set<string>): void {
  if (!rule) return;
  const text = JSON.stringify(rule);
  for (const name of tokenNames(text)) into.add(name);
}

/** `existingGlobalRuleIds` is optional - omit it (or pass none loaded yet) to skip GLOBAL_RULE_GONE;
 *  the backend's own pass never skips it. */
export function validateCycle(cycle: ReliveCycle, existingGlobalRuleIds?: ReadonlySet<string>): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const steps = cycle.steps ?? [];

  for (const step of steps) {
    if (!step.recording) {
      findings.push(finding('BLOCK', 'MISSING_RECORDING', step.key, `"${step.label}" has no recording to replay or compare against.`));
    }
  }

  const seenKeys = new Set<string>();
  for (const step of steps) {
    if (seenKeys.has(step.key)) {
      findings.push(finding('BLOCK', 'DUPLICATE_STEP', step.key, `Two steps share the key "${step.key}".`));
    }
    seenKeys.add(step.key);
  }

  if (!steps.some((s) => s.enabled)) {
    findings.push(finding('BLOCK', 'NOTHING_TO_RUN', null, steps.length ? 'Every step is disabled - there is nothing for this run to do.' : 'Add calls before starting a run.'));
  }

  if (existingGlobalRuleIds && cycle.globalRules.mode === 'SELECTED') {
    for (const id of cycle.globalRules.selectedIds) {
      if (!existingGlobalRuleIds.has(id)) {
        findings.push(finding('WARN', 'GLOBAL_RULE_GONE', null, `A selected global rule (${id}) no longer exists.`));
      }
    }
  }

  const seenMatches = new Map<string, string>();
  for (const rule of cycle.cycleRules) {
    const key = JSON.stringify(rule.match ?? {});
    const earlier = seenMatches.get(key);
    if (earlier !== undefined) {
      findings.push(finding('WARN', 'RULE_OVERLAP', null, `Cycle rules "${earlier}" and "${rule.name}" match the same thing - only the first ever runs.`));
    } else {
      seenMatches.set(key, rule.name);
    }
  }

  for (const step of steps) {
    if (!step.enabled || !step.parentKey) continue;
    const { reaches } = reachesHost(step.callRule);
    if (reaches) {
      findings.push(finding('WARN', 'LIVE_EXTERNAL', step.key, `"${step.label}" can reach a real external system.`));
    }
  }

  if (cycle.settings.defaultDriver === 'GUIDED') {
    findings.push(
      finding('WARN', 'MAY_BE_UNATTRIBUTED', null, 'Guided runs attribute inbound calls by timing alone - a second call to the same project while this run is active may be misattributed.'),
    );
  }

  const declared = new Set(cycle.variables.map((v) => v.name));
  const used = new Set<string>();
  for (const step of steps) collectTokens(step.callRule, used);
  for (const rule of cycle.cycleRules) collectTokens(rule, used);
  for (const rule of cycle.unexpectedCalls.rules) collectTokens(rule, used);

  for (const name of used) {
    if (!declared.has(name)) {
      findings.push(finding('WARN', 'UNRESOLVED_VARIABLE', null, `{{${name}}} is used but never declared as a cycle variable.`));
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      findings.push(finding('WARN', 'UNUSED_VARIABLE', null, `The variable "${name}" is declared but never used.`));
    }
  }

  findings.push(...orderDependencyFindings(steps));

  return findings;
}

function orderDependencyFindings(steps: readonly Step[]): ValidationFinding[] {
  const extractedAt = new Map<string, number>();
  steps.forEach((step, index) => {
    for (const extraction of step.extract ?? []) {
      if (!extractedAt.has(extraction.as)) extractedAt.set(extraction.as, index);
    }
  });

  const findings: ValidationFinding[] = [];
  steps.forEach((step, index) => {
    const used = new Set<string>();
    collectTokens(step.callRule, used);
    for (const name of used) {
      const producedIndex = extractedAt.get(name);
      if (producedIndex !== undefined && producedIndex >= index) {
        findings.push(finding('WARN', 'ORDER_DEPENDENCY', step.key, `"${step.label}" uses {{${name}}}, which is only extracted by a later or the same step.`));
      }
    }
  });
  return findings;
}
