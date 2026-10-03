/**
 * Comparing Relive runs (T134, specs/003-relive-cycle/run-compare-mock.html option C): two runs
 * side by side - or a run against the recording - step by step, and a matrix of every step across
 * the last runs. Pure functions over what `getRun` already returns (definition, stepResults,
 * variableTimeline); no backend data of its own.
 *
 * A field difference between the two sides is found and graded exactly as a step's own
 * differences against the recording are (`relive-canonical-body.ts`, `relive-noise.ts`): the noise
 * rules of the cycle and of the step apply, so a timestamp or a session id does not make every
 * step "changed". Those fields are kept, flagged as noise, for "Show noise fields".
 */
import { allResponseDifferences, GradedResponse } from './relive-canonical-body';
import { classify, ClassifiedDifference, RawDifference } from './relive-noise';
import { displayedState } from './relive-outcome';
import { FrozenCall, NoiseRule, ReliveDriver, Run, RunStatus, Step, StepResult } from './relive-types';

/** A run with its results, as `getRun` returns it. */
export type FullRun = Run & { readonly stepResults: readonly StepResult[]; readonly secrets?: readonly string[] };

/** One side of a comparison: a run, or the recording every step was made from. */
export interface CompareSide {
  /** The run id, or `RECORDING_SIDE`. */
  readonly id: string;
  readonly isRecording: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly status: RunStatus | null;
  readonly driver: ReliveDriver | null;
  readonly cycleUpdatedAt: string | null;
  readonly steps: readonly Step[];
  readonly results: Readonly<Record<string, StepResult>>;
  /** Each value the run captured or set, last one per name, with the step that saved it. */
  readonly variables: readonly { readonly name: string; readonly value: string; readonly stepKey: string | null }[];
  readonly secretNames: readonly string[];
}

export const RECORDING_SIDE = 'recording';

export type SideOutcome = 'ok' | 'diff' | 'fail' | 'skip';

export type StepVerdict = 'NEW_FAILURE' | 'FIXED' | 'CHANGED' | 'NOT_RUN' | 'SLOWER' | 'FASTER' | 'SAME';

/** What one side did for one step. */
export interface StepSide {
  readonly outcome: SideOutcome;
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly mode: 'LIVE' | 'REPLAY' | 'RECORDED' | null;
  readonly result: StepResult | null;
  readonly request: HttpShape | null;
  readonly response: HttpShape | null;
  readonly error: string | null;
}

export interface HttpShape {
  readonly method?: string | null;
  readonly url?: string | null;
  readonly status?: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/** A field that differs between A and B. `noise` fields do not make the step "changed". */
export interface FieldChange {
  readonly part: string;
  readonly path: string;
  readonly a: string | null;
  readonly b: string | null;
  readonly noise: boolean;
  /** Why it is noise ("timestamp", "marked as noise", "you substituted {{x}}"), or for a sent
   *  difference, "variable" / "request". */
  readonly cause: string | null;
}

export interface StepComparison {
  readonly key: string;
  readonly step: Step;
  readonly isChild: boolean;
  readonly label: string;
  /** "POST /path" of the recording. */
  readonly path: string;
  readonly a: StepSide;
  readonly b: StepSide;
  /** Response fields that differ: unexpected ones first, then noise. */
  readonly fields: readonly FieldChange[];
  /** What the step sent differently: variable values and request fields. */
  readonly sent: readonly FieldChange[];
  /** B's time against A's, as a percentage change. Null when either side has no time. */
  readonly timeChangePct: number | null;
  readonly verdict: StepVerdict;
}

export interface VariableComparison {
  readonly name: string;
  readonly savedBy: string | null;
  readonly a: string | null;
  readonly b: string | null;
  readonly change: 'same' | 'changed' | 'missing-a' | 'missing-b';
}

export interface RunComparison {
  readonly rows: readonly StepComparison[];
  readonly counts: Readonly<Record<StepVerdict, number>>;
  /** Steps whose verdict is anything but SAME. */
  readonly changedCount: number;
  readonly verdict: { readonly tone: 'worse' | 'better' | 'mixed' | 'differs' | 'same'; readonly lead: string; readonly text: string };
  readonly variables: readonly VariableComparison[];
}

/** Slower or faster only past this change, and past `TIME_MIN_DELTA_MS`, so jitter on a fast call is not news. */
export const TIME_CHANGE_RATIO = 0.25;
const TIME_MIN_DELTA_MS = 50;

const SKIPPED_STATES: ReadonlySet<StepResult['state']> = new Set(['PENDING', 'WAITING', 'SKIPPED', 'NOT_CALLED', 'CANCELLED']);

// ---- Sides ----

export function runSide(run: FullRun): CompareSide {
  return {
    id: run.id,
    isRecording: false,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    status: run.status,
    driver: run.driver,
    cycleUpdatedAt: run.definition.updatedAt ?? null,
    steps: run.definition.steps,
    results: latestByStepKey(run.stepResults),
    variables: lastValues([
      ...run.seedVariables.map((v) => ({ ...v, stepKey: null })),
      ...run.variableTimeline,
    ]),
    secretNames: run.secrets ?? run.definition.variables.filter((v) => v.secret).map((v) => v.name),
  };
}

/** The recording as a side of its own: every step as it was recorded, nothing captured. */
export function recordingSide(of: CompareSide): CompareSide {
  return {
    id: RECORDING_SIDE,
    isRecording: true,
    startedAt: null,
    finishedAt: null,
    status: null,
    driver: null,
    cycleUpdatedAt: of.cycleUpdatedAt,
    steps: of.steps,
    results: {},
    variables: [],
    secretNames: of.secretNames,
  };
}

export function latestByStepKey(results: readonly StepResult[]): Record<string, StepResult> {
  const latest: Record<string, StepResult> = {};
  for (const r of results) {
    const existing = latest[r.stepKey];
    if (!existing || r.attempt >= existing.attempt) latest[r.stepKey] = r;
  }
  return latest;
}

function lastValues<T extends { readonly name: string; readonly value: string; readonly stepKey: string | null }>(entries: readonly T[]): { name: string; value: string; stepKey: string | null }[] {
  const byName = new Map<string, { name: string; value: string; stepKey: string | null }>();
  for (const e of entries) byName.set(e.name, { name: e.name, value: e.value, stepKey: e.stepKey });
  return [...byName.values()];
}

/** The steps in run order: each top-level step followed by its outbound children. */
export function orderedSteps(steps: readonly Step[]): { readonly step: Step; readonly isChild: boolean }[] {
  const tops = steps.filter((s) => !s.parentKey);
  const known = new Set(tops.map((s) => s.key));
  const out = tops.flatMap((parent) => [
    { step: parent, isChild: false },
    ...steps.filter((s) => s.parentKey === parent.key).map((child) => ({ step: child, isChild: true })),
  ]);
  // A child whose parent is gone still shows, at the end.
  for (const s of steps) if (s.parentKey && !known.has(s.parentKey)) out.push({ step: s, isChild: true });
  return out;
}

// ---- One step on one side ----

export function toHttp(value: unknown): HttpShape | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { status?: unknown; headers?: unknown; body?: unknown; method?: unknown; url?: unknown };
  return {
    status: typeof v.status === 'number' ? v.status : null,
    method: typeof v.method === 'string' ? v.method : null,
    url: typeof v.url === 'string' ? v.url : null,
    headers: (v.headers && typeof v.headers === 'object' ? v.headers : {}) as Readonly<Record<string, string>>,
    body: typeof v.body === 'string' ? v.body : v.body == null ? null : JSON.stringify(v.body),
  };
}

function recordedSide(rec: FrozenCall): StepSide {
  return {
    outcome: 'ok',
    status: rec.status,
    durationMs: rec.durationMs,
    mode: 'RECORDED',
    result: null,
    request: { method: rec.method, url: rec.url, headers: rec.requestHeaders, body: rec.requestBody ?? null },
    response: { status: rec.status, headers: rec.responseHeaders, body: rec.responseBody ?? null },
    error: null,
  };
}

export function outcomeOfResult(result: StepResult | undefined, recordingStatus: number | null): SideOutcome {
  if (!result || SKIPPED_STATES.has(result.state)) return 'skip';
  const state = displayedState(result, recordingStatus);
  if (state === 'FAILED') return 'fail';
  if (state === 'COMPLETED_WITH_DIFFERENCES') return 'diff';
  if (state === 'COMPLETED') return 'ok';
  // Still going (RUNNING, PAUSED, …): nothing to grade yet.
  return 'skip';
}

export function stepSide(side: CompareSide, step: Step | undefined): StepSide {
  if (!step) return { outcome: 'skip', status: null, durationMs: null, mode: null, result: null, request: null, response: null, error: null };
  if (side.isRecording) return recordedSide(step.recording);
  const result = side.results[step.key];
  const response = toHttp(result?.actualResponse);
  const outcome = outcomeOfResult(result, step.recording.status);
  return {
    outcome,
    status: response?.status ?? null,
    // A step that did not run has no time, even when one was stored as 0.
    durationMs: outcome === 'skip' ? null : result?.durationMs ?? null,
    mode: result?.mode ?? null,
    result: result ?? null,
    request: toHttp(result?.actualRequest) ?? toHttp(result?.effectiveRequest),
    response,
    error: result?.error ?? null,
  };
}

// ---- Field differences ----

function graded(http: HttpShape | null): GradedResponse {
  return { status: http?.status ?? 0, headers: http?.headers ?? {}, body: http?.body ?? null };
}

function variablesOf(...sides: StepSide[]): { used: { name: string; value: string }[]; produced: { name: string; value: string }[] } {
  return {
    used: sides.flatMap((s) => s.result?.variablesUsed ?? []),
    produced: sides.flatMap((s) => s.result?.variablesProduced ?? []),
  };
}

function toChange(d: ClassifiedDifference): FieldChange {
  return { part: d.part, path: d.path, a: d.recorded, b: d.actual, noise: d.kind !== 'UNEXPECTED', cause: d.kind === 'UNEXPECTED' ? null : d.cause };
}

/** Response fields that differ between A and B, graded with the given noise rules. */
export function responseChanges(a: StepSide, b: StepSide, noiseRules: readonly NoiseRule[]): FieldChange[] {
  if (!a.response || !b.response) return [];
  const vars = variablesOf(a, b);
  const raw = allResponseDifferences(graded(a.response), graded(b.response), { noiseRules, variablesUsed: vars.used, variablesProduced: vars.produced });
  const classified = classify(raw as RawDifference[], { noiseRules, expected: [], variablesUsed: vars.used, variablesProduced: vars.produced }).map(toChange);
  return [...classified.filter((c) => !c.noise), ...classified.filter((c) => c.noise)];
}

/** What the step sent differently: each variable whose value changed, then the request itself
 *  (url, headers, body), noise left out. A field already explained by a variable is not repeated. */
export function sentChanges(a: StepSide, b: StepSide, noiseRules: readonly NoiseRule[]): FieldChange[] {
  const out: FieldChange[] = [];
  const aVars = new Map((a.result?.variablesUsed ?? []).map((v) => [v.name, v.value]));
  const bVars = new Map((b.result?.variablesUsed ?? []).map((v) => [v.name, v.value]));
  for (const name of new Set([...aVars.keys(), ...bVars.keys()])) {
    const av = aVars.get(name) ?? null;
    const bv = bVars.get(name) ?? null;
    if (av !== bv) out.push({ part: 'variable', path: `{{${name}}}`, a: av, b: bv, noise: false, cause: 'variable' });
  }
  if (!a.request || !b.request) return out;
  if ((a.request.method ?? '') !== (b.request.method ?? '') || (a.request.url ?? '') !== (b.request.url ?? '')) {
    out.push({ part: 'url', path: 'url', a: `${a.request.method ?? ''} ${a.request.url ?? ''}`.trim(), b: `${b.request.method ?? ''} ${b.request.url ?? ''}`.trim(), noise: false, cause: 'request' });
  }
  const values = new Set([...aVars.values(), ...bVars.values()].filter(Boolean));
  const vars = variablesOf(a, b);
  const raw = allResponseDifferences(
    { status: 0, headers: a.request.headers, body: a.request.body },
    { status: 0, headers: b.request.headers, body: b.request.body },
    { noiseRules, variablesUsed: vars.used, variablesProduced: vars.produced },
  );
  for (const d of classify(raw as RawDifference[], { noiseRules, expected: [], variablesUsed: [], variablesProduced: [] })) {
    if (d.kind !== 'UNEXPECTED') continue;
    if (d.recorded != null && d.actual != null && [...values].some((v) => d.recorded!.includes(v) || d.actual!.includes(v))) continue;
    out.push({ part: d.part, path: `request.${d.path}`, a: d.recorded, b: d.actual, noise: false, cause: 'request' });
  }
  return out;
}

// ---- Verdicts ----

export function timeChangePct(a: number | null, b: number | null): number | null {
  if (a == null || b == null || a <= 0) return null;
  return Math.round(((b - a) / a) * 100);
}

export function verdictOf(a: StepSide, b: StepSide, unexpectedFields: number): StepVerdict {
  const aRan = a.outcome !== 'skip';
  const bRan = b.outcome !== 'skip';
  if (!aRan && !bRan) return 'SAME';
  if (aRan !== bRan) return b.outcome === 'fail' ? 'NEW_FAILURE' : 'NOT_RUN';
  if (b.outcome === 'fail' && a.outcome !== 'fail') return 'NEW_FAILURE';
  if (a.outcome === 'fail' && b.outcome !== 'fail') return 'FIXED';
  if (unexpectedFields > 0 || a.status !== b.status) return 'CHANGED';
  if (a.outcome !== b.outcome) return 'CHANGED';
  if (a.durationMs != null && b.durationMs != null && a.durationMs > 0) {
    const delta = b.durationMs - a.durationMs;
    if (Math.abs(delta) >= TIME_MIN_DELTA_MS) {
      if (delta / a.durationMs > TIME_CHANGE_RATIO) return 'SLOWER';
      if (delta / a.durationMs < -TIME_CHANGE_RATIO) return 'FASTER';
    }
  }
  return 'SAME';
}

/** The noise rules a step is graded with: the cycle's, then the step's own. */
export type NoiseRulesFor = (key: string) => readonly NoiseRule[];

export function compareRuns(a: CompareSide, b: CompareSide, noiseFor: NoiseRulesFor): RunComparison {
  const aSteps = new Map(a.steps.map((s) => [s.key, s]));
  const bSteps = new Map(b.steps.map((s) => [s.key, s]));
  const order = orderedSteps(b.steps);
  const inOrder = new Set(order.map((o) => o.step.key));
  for (const o of orderedSteps(a.steps)) if (!inOrder.has(o.step.key)) order.push(o);

  const rows = order.map(({ step, isChild }): StepComparison => {
    const left = stepSide(a, aSteps.get(step.key));
    const right = stepSide(b, bSteps.get(step.key));
    const noise = noiseFor(step.key);
    const fields = responseChanges(left, right, noise);
    const sent = sentChanges(left, right, noise);
    return {
      key: step.key,
      step,
      isChild,
      label: step.label,
      path: `${step.recording.method} ${pathOf(step.recording.url)}`,
      a: left,
      b: right,
      fields,
      sent,
      timeChangePct: timeChangePct(left.durationMs, right.durationMs),
      verdict: verdictOf(left, right, fields.filter((f) => !f.noise).length),
    };
  });

  const counts: Record<StepVerdict, number> = { NEW_FAILURE: 0, FIXED: 0, CHANGED: 0, NOT_RUN: 0, SLOWER: 0, FASTER: 0, SAME: 0 };
  for (const r of rows) counts[r.verdict]++;
  const labelOf = (key: string | null) => (key ? bSteps.get(key)?.label ?? aSteps.get(key)?.label ?? key : null);
  return {
    rows,
    counts,
    changedCount: rows.length - counts.SAME,
    verdict: verdictLine(rows, counts),
    variables: compareVariables(a, b, labelOf),
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function verdictLine(rows: readonly StepComparison[], counts: Readonly<Record<StepVerdict, number>>): RunComparison['verdict'] {
  const failed = rows.filter((r) => r.verdict === 'NEW_FAILURE').map((r) => r.label);
  const bad: string[] = [];
  if (counts.NEW_FAILURE) bad.push(`${plural(counts.NEW_FAILURE, 'new failure', 'new failures')} (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''})`);
  if (counts.NOT_RUN) bad.push(`${plural(counts.NOT_RUN, 'step', 'steps')} not run in one of the two`);
  if (counts.CHANGED) bad.push(`${plural(counts.CHANGED, 'answer', 'answers')} changed`);
  if (counts.SLOWER) bad.push(`${plural(counts.SLOWER, 'slower step', 'slower steps')}`);
  const good: string[] = [];
  if (counts.FIXED) good.push(`${plural(counts.FIXED, 'step', 'steps')} fixed`);
  if (counts.FASTER) good.push(`${plural(counts.FASTER, 'faster step', 'faster steps')}`);

  let tone: RunComparison['verdict']['tone'];
  if (counts.NEW_FAILURE > counts.FIXED) tone = 'worse';
  else if (counts.FIXED > counts.NEW_FAILURE) tone = 'better';
  else if (counts.NEW_FAILURE > 0) tone = 'mixed';
  else if (bad.length || good.length) tone = 'differs';
  else tone = 'same';

  const lead = { worse: 'B is worse:', better: 'B is better:', mixed: 'B is mixed:', differs: 'B differs:', same: 'Same result:' }[tone];
  const text = tone === 'same'
    ? `every step has the same outcome, answer and time (noise fields ignored).`
    : `${[bad.join(', '), good.join(', ')].filter(Boolean).join('. ')}.`;
  return { tone, lead, text };
}

function compareVariables(a: CompareSide, b: CompareSide, labelOf: (key: string | null) => string | null): VariableComparison[] {
  const aMap = new Map(a.variables.map((v) => [v.name, v]));
  const bMap = new Map(b.variables.map((v) => [v.name, v]));
  const names = [...new Set([...aMap.keys(), ...bMap.keys()])];
  return names.map((name) => {
    const av = aMap.get(name) ?? null;
    const bv = bMap.get(name) ?? null;
    const change: VariableComparison['change'] = !av ? 'missing-a' : !bv ? 'missing-b' : av.value === bv.value ? 'same' : 'changed';
    return { name, savedBy: labelOf(bv?.stepKey ?? av?.stepKey ?? null), a: av?.value ?? null, b: bv?.value ?? null, change };
  });
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

// ---- The run matrix ----

export interface MatrixCell {
  readonly runId: string;
  readonly outcome: SideOutcome;
  readonly durationMs: number | null;
  /** Against the step's usual time (the median of the other runs shown). */
  readonly time: 'fast' | 'even' | 'slow' | 'slow2' | 'none';
}

export interface MatrixRow {
  readonly key: string;
  readonly label: string;
  readonly isChild: boolean;
  readonly cells: readonly MatrixCell[];
  /** "What stands out", in words, or null. */
  readonly note: string | null;
  /** True when the outcome is not the same in every run shown. */
  readonly varies: boolean;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeClass(ms: number | null, usual: number | null): MatrixCell['time'] {
  if (ms == null || usual == null || usual <= 0) return 'none';
  const ratio = ms / usual;
  if (ratio > 1.5) return 'slow2';
  if (ratio > 1.15) return 'slow';
  if (ratio < 0.85) return 'fast';
  return 'even';
}

/** `runs` newest first. Rows follow the newest run's steps, then any step only older runs had. */
export function buildMatrix(runs: readonly CompareSide[]): MatrixRow[] {
  if (!runs.length) return [];
  const order = orderedSteps(runs[0].steps);
  const seen = new Set(order.map((o) => o.step.key));
  for (const run of runs.slice(1)) {
    for (const o of orderedSteps(run.steps)) {
      if (!seen.has(o.step.key)) {
        seen.add(o.step.key);
        order.push(o);
      }
    }
  }
  return order.map(({ step, isChild }) => {
    const raw = runs.map((run) => {
      const own = run.steps.find((s) => s.key === step.key);
      const side = stepSide(run, own);
      return { runId: run.id, outcome: side.outcome, durationMs: side.outcome === 'skip' ? null : side.durationMs };
    });
    const cells = raw.map((cell, i) => {
      const others = raw.filter((_, j) => j !== i).map((c) => c.durationMs).filter((ms): ms is number => ms != null);
      return { ...cell, time: timeClass(cell.durationMs, median(others)) };
    });
    return { key: step.key, label: step.label, isChild, cells, note: noteFor(cells), varies: new Set(cells.map((c) => c.outcome)).size > 1 };
  });
}

/** What stands out about a step across the runs shown, newest first. */
export function noteFor(cells: readonly MatrixCell[]): string | null {
  if (cells.length < 2) return null;
  const [newest, ...older] = cells;
  const olderRan = older.filter((c) => c.outcome !== 'skip');
  if (newest.outcome === 'fail' && olderRan.length && olderRan.every((c) => c.outcome !== 'fail')) {
    return `first failure in ${cells.length} runs`;
  }
  if (newest.outcome === 'fail') {
    const streak = cells.findIndex((c) => c.outcome !== 'fail');
    const n = streak === -1 ? cells.length : streak;
    if (n > 1) return `failing for the last ${n} runs`;
  }
  if (newest.outcome !== 'fail' && newest.outcome !== 'skip' && older[0]?.outcome === 'fail') return 'fixed in the newest run';
  const ran = cells.filter((c) => c.outcome === 'ok' || c.outcome === 'diff');
  let flips = 0;
  for (let i = 1; i < ran.length; i++) if (ran[i].outcome !== ran[i - 1].outcome) flips++;
  if (flips >= 2) return 'changes on and off - a flaky answer or a noise field';
  const usual = median(older.map((c) => c.durationMs).filter((ms): ms is number => ms != null));
  if (newest.durationMs != null && usual && newest.durationMs >= usual * 1.8 && newest.durationMs - usual >= TIME_MIN_DELTA_MS) {
    const ratio = newest.durationMs / usual;
    return ratio < 2.5 ? 'twice as slow in the newest run' : `${Math.round(ratio)}× slower in the newest run`;
  }
  if (newest.outcome === 'skip' && olderRan.length === older.length && older.length) return 'not run in the newest run';
  return null;
}
