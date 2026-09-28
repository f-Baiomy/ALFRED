/**
 * Classifies a step's differences (FR-038/041/041a-c): a difference is EXPECTED when the run
 * itself intended it (a rule that modified this field, a variable substitution, or a user edit
 * upstream), NOISE_AUTO when it looks like the kind of value that changes every run regardless of
 * what ALFRED did (an id, token, timestamp, trace header), NOISE_USER when the user explicitly
 * marked this field as noise (`NoiseRule`), and UNEXPECTED otherwise - the only kind that affects
 * a step's outcome (`relive-outcome.ts`).
 *
 * A user `NoiseRule` with `count: true` is a forced un-ignore: even a field an auto detector would
 * otherwise call noise stays UNEXPECTED, because the user asked to be told about it.
 */
import { NoiseRule } from './relive-types';

export type DifferenceKind = 'EXPECTED' | 'NOISE_AUTO' | 'NOISE_USER' | 'UNEXPECTED';

/** One field-level before/after, not yet classified. */
export interface RawDifference {
  readonly part: 'status' | 'header' | 'body' | 'query';
  readonly path: string;
  readonly recorded: string | null;
  readonly actual: string | null;
}

export interface ClassifiedDifference extends RawDifference {
  readonly kind: DifferenceKind;
  readonly cause: string | null;
}

/** A path already known (by the caller) to differ on purpose, and why - a matched rule's name or
 *  an upstream edit, e.g. `{ path: 'body.currency', cause: 'GLOBAL rule "Currency → AED"' }`. */
export interface ExpectedCause {
  readonly path: string;
  readonly cause: string;
}

export interface ClassifyContext {
  /** Step-scoped and cycle-scoped `NoiseRule`s, already combined by the caller. */
  readonly noiseRules: readonly NoiseRule[];
  readonly expected: readonly ExpectedCause[];
  /** Variables substituted into the effective request for this step. */
  readonly variablesUsed: readonly { readonly name: string; readonly value: string }[];
  /** Variables this step's response extracted. */
  readonly variablesProduced: readonly { readonly name: string; readonly value: string }[];
}

const TRACE_NAME = /trace|correlation|x-request-id|requestid|span-?id/i;
const CACHE_HEADER_NAME = /^(date|etag|last-modified|set-cookie)$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const EPOCH_MS_OR_S = /^\d{10}(\d{3})?$/;
const TIME_NAME = /time|timestamp|_at$|At$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_NAME = /id$/i;
const TOKEN_NAME = /token/i;

function findNoiseRule(rules: readonly NoiseRule[], diff: RawDifference): NoiseRule | null {
  for (const rule of rules) {
    if (rule.part === diff.part && rule.path === diff.path) {
      return rule;
    }
  }
  return null;
}

function matchingVariable(
  value: string | null,
  variables: readonly { readonly name: string; readonly value: string }[],
): string | null {
  if (value == null) {
    return null;
  }
  return variables.find((v) => v.value === value)?.name ?? null;
}

/** Detector name doubles as the shown "why", matching the values ALFRED already uses elsewhere
 *  (mock.html's diff rows: "trace id", "timestamp", "generated id", "token"). */
function detectAutoNoise(diff: RawDifference): string | null {
  const name = diff.path.split('.').pop() ?? diff.path;
  if (diff.part === 'header' && CACHE_HEADER_NAME.test(name)) {
    return 'header changes every response';
  }
  if (TRACE_NAME.test(name)) {
    return 'trace id';
  }
  const value = diff.actual ?? diff.recorded;
  if (value != null) {
    if (ISO_TIMESTAMP.test(value)) {
      return 'timestamp';
    }
    if (EPOCH_MS_OR_S.test(value) && TIME_NAME.test(name)) {
      return 'timestamp';
    }
    if (UUID.test(value)) {
      return 'generated id';
    }
  }
  if (TOKEN_NAME.test(name)) {
    return 'token';
  }
  if (ID_NAME.test(name) && diff.recorded !== diff.actual) {
    return 'generated id';
  }
  return null;
}

function classifyOne(diff: RawDifference, ctx: ClassifyContext): ClassifiedDifference {
  const userRule = findNoiseRule(ctx.noiseRules, diff);
  if (userRule?.count) {
    return { ...diff, kind: 'UNEXPECTED', cause: null };
  }
  if (userRule) {
    return { ...diff, kind: 'NOISE_USER', cause: 'marked as noise' };
  }

  const expected = ctx.expected.find((e) => e.path === diff.path);
  if (expected) {
    return { ...diff, kind: 'EXPECTED', cause: expected.cause };
  }

  const usedVar = matchingVariable(diff.actual, ctx.variablesUsed);
  if (usedVar) {
    return { ...diff, kind: 'EXPECTED', cause: `you substituted {{${usedVar}}}` };
  }
  const producedVar = matchingVariable(diff.actual, ctx.variablesProduced);
  if (producedVar) {
    return { ...diff, kind: 'EXPECTED', cause: `you extracted {{${producedVar}}}` };
  }

  const autoCause = detectAutoNoise(diff);
  if (autoCause) {
    return { ...diff, kind: 'NOISE_AUTO', cause: autoCause };
  }

  return { ...diff, kind: 'UNEXPECTED', cause: null };
}

export function classify(diffs: readonly RawDifference[], ctx: ClassifyContext): ClassifiedDifference[] {
  return diffs.map((d) => classifyOne(d, ctx));
}
