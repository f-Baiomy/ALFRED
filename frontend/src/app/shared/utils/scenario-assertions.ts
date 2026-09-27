import { valuesAt, asText } from './json-paths';
import { Assertion, AssertionResult, DraftResult } from './scenario-types';

/**
 * Pure assertion evaluator (D1) - contracts.md section 6's Assertion, run against one draft's
 * result. A draft that never got a response (error, or no `response`) fails every assertion with a
 * clear message instead of throwing or silently passing - a scenario asserting on a supplier that
 * is down should read as a failure, not a green run that happened to check nothing.
 */
export function evaluate(assertions: readonly Assertion[], result: DraftResult): AssertionResult[] {
  return assertions.map((assertion) => evaluateOne(assertion, result));
}

function evaluateOne(assertion: Assertion, result: DraftResult): AssertionResult {
  if (result.error && !result.response) {
    return { assertion, passed: false, actual: '', message: `Call failed before a response: ${result.error}` };
  }
  switch (assertion.kind) {
    case 'STATUS':
      return evaluateStatus(assertion, result);
    case 'HEADER':
      return evaluateHeader(assertion, result);
    case 'JSON':
      return evaluateJson(assertion, result);
    case 'LATENCY':
      return evaluateLatency(assertion, result);
  }
}

function fail(assertion: Assertion, actual: string, message: string): AssertionResult {
  return { assertion, passed: false, actual, message };
}
function pass(assertion: Assertion, actual: string, message: string): AssertionResult {
  return { assertion, passed: true, actual, message };
}

function evaluateStatus(assertion: Assertion, result: DraftResult): AssertionResult {
  const status = result.status;
  const actual = status === null ? '(no status)' : String(status);
  if (status === null) return fail(assertion, actual, 'No response status was recorded.');
  return compareScalar(assertion, actual, String(status), (a) => Number(a));
}

function evaluateLatency(assertion: Assertion, result: DraftResult): AssertionResult {
  const ms = result.durationMs;
  const actual = ms === null ? '(no duration)' : `${ms}`;
  if (ms === null) return fail(assertion, actual, 'No duration was recorded.');
  return compareScalar(assertion, actual, String(ms), (a) => Number(a));
}

function evaluateHeader(assertion: Assertion, result: DraftResult): AssertionResult {
  const name = (assertion.path ?? '').trim().toLowerCase();
  if (!name) return fail(assertion, '', 'HEADER assertion needs a header name in "path".');
  const headers = result.response?.headers ?? {};
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const actual = match ? match[1] : undefined;
  return evaluatePresenceOrValue(assertion, actual, `header "${assertion.path}"`);
}

function evaluateJson(assertion: Assertion, result: DraftResult): AssertionResult {
  const path = assertion.path ?? '';
  const body = result.response?.body;
  if (body === null || body === undefined) return fail(assertion, '', 'No response body to evaluate JSON against.');
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return fail(assertion, body.slice(0, 200), 'Response body is not valid JSON.');
  }
  const values = valuesAt(doc, path);
  if (values.length === 0) {
    return evaluatePresenceOrValue(assertion, undefined, `JSON path "${path}"`);
  }
  // A wildcard path resolves to several values; a plain assertion passes when ANY of them matches -
  // "some item has status CONFIRMED" is what a rule author means, not "every item does".
  const actualTexts = values.map((v) => asText(v));
  const actual = actualTexts.length === 1 ? actualTexts[0] : actualTexts.join(', ');
  return evaluatePresenceOrValue(assertion, actualTexts.length === 1 ? actualTexts[0] : undefined, `JSON path "${path}"`, actualTexts, actual);
}

/** Shared EXISTS/NOT_EXISTS/EQUALS/NOT_EQUALS/CONTAINS/MATCHES logic for HEADER and JSON (single value). */
function evaluatePresenceOrValue(
  assertion: Assertion,
  singleActual: string | undefined,
  label: string,
  multiActual?: readonly string[],
  displayActual?: string
): AssertionResult {
  const present = multiActual ? multiActual.length > 0 : singleActual !== undefined;
  const shown = displayActual ?? singleActual ?? '(absent)';
  switch (assertion.operator) {
    case 'EXISTS':
      return present ? pass(assertion, shown, `${label} is present.`) : fail(assertion, shown, `${label} is missing.`);
    case 'NOT_EXISTS':
      return !present ? pass(assertion, shown, `${label} is absent.`) : fail(assertion, shown, `${label} is present.`);
    case 'GT':
    case 'LT':
      if (!present) return fail(assertion, shown, `${label} is missing.`);
      return compareScalar(assertion, shown, singleActual ?? shown, (a) => Number(a));
  }
  if (!present) {
    // EQUALS/NOT_EQUALS/CONTAINS/MATCHES against a missing value: NOT_EQUALS trivially passes
    // (undefined never equals the wanted value), everything else fails.
    if (assertion.operator === 'NOT_EQUALS') return pass(assertion, shown, `${label} is absent, which is not equal.`);
    return fail(assertion, shown, `${label} is missing.`);
  }
  const candidates = multiActual ?? (singleActual !== undefined ? [singleActual] : []);
  const wanted = assertion.value ?? '';
  switch (assertion.operator) {
    case 'EQUALS':
      return candidates.some((c) => c === wanted)
        ? pass(assertion, shown, `${label} equals "${wanted}".`)
        : fail(assertion, shown, `${label} was "${shown}", expected "${wanted}".`);
    case 'NOT_EQUALS':
      return candidates.every((c) => c !== wanted)
        ? pass(assertion, shown, `${label} does not equal "${wanted}".`)
        : fail(assertion, shown, `${label} equals "${wanted}".`);
    case 'CONTAINS':
      return candidates.some((c) => c.includes(wanted))
        ? pass(assertion, shown, `${label} contains "${wanted}".`)
        : fail(assertion, shown, `${label} was "${shown}", does not contain "${wanted}".`);
    case 'MATCHES': {
      let re: RegExp;
      try {
        re = new RegExp(wanted);
      } catch {
        return fail(assertion, shown, `"${wanted}" is not a valid regular expression.`);
      }
      return candidates.some((c) => re.test(c))
        ? pass(assertion, shown, `${label} matches /${wanted}/.`)
        : fail(assertion, shown, `${label} was "${shown}", does not match /${wanted}/.`);
    }
    default:
      return fail(assertion, shown, `Unsupported operator for ${label}.`);
  }
}

function compareScalar(assertion: Assertion, shown: string, rawActual: string, toNumber: (s: string) => number): AssertionResult {
  const actualNum = toNumber(rawActual);
  const wantedNum = Number(assertion.value ?? NaN);
  switch (assertion.operator) {
    case 'EQUALS':
      return String(actualNum) === (assertion.value ?? '') || actualNum === wantedNum
        ? pass(assertion, shown, `Equals ${assertion.value}.`)
        : fail(assertion, shown, `Was ${shown}, expected ${assertion.value}.`);
    case 'NOT_EQUALS':
      return actualNum !== wantedNum
        ? pass(assertion, shown, `Does not equal ${assertion.value}.`)
        : fail(assertion, shown, `Equals ${assertion.value}.`);
    case 'GT':
      if (Number.isNaN(wantedNum)) return fail(assertion, shown, `"${assertion.value}" is not a number.`);
      return actualNum > wantedNum ? pass(assertion, shown, `${shown} > ${assertion.value}.`) : fail(assertion, shown, `${shown} is not > ${assertion.value}.`);
    case 'LT':
      if (Number.isNaN(wantedNum)) return fail(assertion, shown, `"${assertion.value}" is not a number.`);
      return actualNum < wantedNum ? pass(assertion, shown, `${shown} < ${assertion.value}.`) : fail(assertion, shown, `${shown} is not < ${assertion.value}.`);
    case 'EXISTS':
      return pass(assertion, shown, 'Present.');
    case 'NOT_EXISTS':
      return fail(assertion, shown, 'Present.');
    case 'CONTAINS':
      return shown.includes(assertion.value ?? '') ? pass(assertion, shown, 'Contains.') : fail(assertion, shown, 'Does not contain.');
    case 'MATCHES': {
      try {
        const re = new RegExp(assertion.value ?? '');
        return re.test(shown) ? pass(assertion, shown, 'Matches.') : fail(assertion, shown, 'Does not match.');
      } catch {
        return fail(assertion, shown, `"${assertion.value}" is not a valid regular expression.`);
      }
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */

export type FieldChangeKind = 'added' | 'removed' | 'changed';

export interface FieldChange {
  readonly path: string;
  readonly kind: FieldChangeKind;
  readonly before?: string;
  readonly after?: string;
}

export interface DraftDiff {
  readonly key: string;
  readonly statusBefore: number | null;
  readonly statusAfter: number | null;
  readonly latencyBefore: number | null;
  readonly latencyAfter: number | null;
  readonly fieldChanges: readonly FieldChange[];
}

/**
 * Compares two runs' per-draft results by key: status, latency, and response JSON field-by-field
 * (added/removed/changed paths), for the D1 compare view. A draft present in only one run is still
 * reported (the other side's status/latency come back null) rather than silently skipped, since
 * "this draft used to run and now doesn't" is exactly the kind of drift a comparison exists to show.
 */
export function diffRuns(runA: readonly DraftResult[], runB: readonly DraftResult[]): DraftDiff[] {
  const byKeyA = new Map(runA.map((r) => [r.key, r]));
  const byKeyB = new Map(runB.map((r) => [r.key, r]));
  const keys = [...new Set([...byKeyA.keys(), ...byKeyB.keys()])];
  return keys.map((key) => {
    const a = byKeyA.get(key) ?? null;
    const b = byKeyB.get(key) ?? null;
    return {
      key,
      statusBefore: a?.status ?? null,
      statusAfter: b?.status ?? null,
      latencyBefore: a?.durationMs ?? null,
      latencyAfter: b?.durationMs ?? null,
      fieldChanges: diffJsonBodies(a?.response?.body, b?.response?.body),
    };
  });
}

function diffJsonBodies(before: string | null | undefined, after: string | null | undefined): FieldChange[] {
  const docBefore = safeParse(before);
  const docAfter = safeParse(after);
  if (docBefore === undefined && docAfter === undefined) return [];
  const leavesBefore = new Map(leafPaths(docBefore, ''));
  const leavesAfter = new Map(leafPaths(docAfter, ''));
  const paths = [...new Set([...leavesBefore.keys(), ...leavesAfter.keys()])].sort();
  const changes: FieldChange[] = [];
  for (const path of paths) {
    const hasBefore = leavesBefore.has(path);
    const hasAfter = leavesAfter.has(path);
    const beforeVal = leavesBefore.get(path);
    const afterVal = leavesAfter.get(path);
    if (hasBefore && !hasAfter) changes.push({ path, kind: 'removed', before: beforeVal });
    else if (!hasBefore && hasAfter) changes.push({ path, kind: 'added', after: afterVal });
    else if (beforeVal !== afterVal) changes.push({ path, kind: 'changed', before: beforeVal, after: afterVal });
  }
  return changes;
}

function safeParse(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Flattens a JSON document to `path -> stringified leaf value` pairs, dotted/bracket paths like json-paths.ts. */
function leafPaths(node: unknown, path: string): [string, string][] {
  if (node === null || node === undefined) return path ? [[path, 'null']] : [];
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => leafPaths(item, path ? `${path}[${i}]` : `[${i}]`));
  }
  if (typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => leafPaths(value, path ? `${path}.${key}` : key));
  }
  return path ? [[path, asText(node)]] : [];
}
