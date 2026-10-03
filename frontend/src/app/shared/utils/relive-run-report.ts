/**
 * What a Relive export says, before it is rendered (specs/003-relive-cycle/export-mock.html): one
 * model per document, rendered by `relive-run-export.ts` into .html, .md and .json so the three
 * formats say exactly the same thing.
 *
 * A run report or a comparison is routinely handed to somebody who was not there - a colleague, a
 * supplier, an AI agent asked to find the bug. So it opens with an answer (the verdict) and an
 * "About this document" written from the run itself: what Relive is, what this run did, what went
 * wrong and why, and how to read the rest. Then the steps, numbered 1, 1.1, 2… with each supplier
 * call under the step that made it, and a glossary of the words only ALFRED uses.
 *
 * The model holds the data unmasked; the .md and .html renderers mask secrets, the .json keeps them
 * (it is the data format). Nothing here shortens a body: exports never truncate call data.
 */
import { explainStep } from './relive-outcome';
import {
  CompareSide,
  FieldChange,
  FullRun,
  HttpShape,
  RunComparison,
  StepComparison,
  latestByStepKey,
  orderedSteps,
  outcomeOfResult,
  responseChanges,
  stepSide,
  recordingSide,
  runSide,
} from './relive-run-compare';
import { Run, Step, StepResult } from './relive-types';

export type ReportOutcome = 'passed' | 'differences' | 'failed' | 'not run' | 'in progress';
export type ReportTone = 'good' | 'mid' | 'bad' | 'neutral';

export interface ReportVerdict {
  readonly tone: ReportTone;
  readonly lead: string;
  readonly text: string;
}

export interface ReportAbout {
  readonly whatThisIs: string;
  readonly whatHappened: string;
  readonly howToRead: string;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly meaning: string;
}

export interface ReportStep {
  /** "3", or "3.1" for the first supplier call step 3 made. */
  readonly number: string;
  readonly key: string;
  readonly label: string;
  readonly method: string;
  readonly url: string;
  readonly direction: 'inbound' | 'outbound';
  readonly isChild: boolean;
  readonly parentNumber: string | null;
  readonly mode: 'LIVE' | 'REPLAY' | null;
  readonly outcome: ReportOutcome;
  /** Why it failed, differed, or did not run - full sentences, never shortened. */
  readonly reasons: readonly string[];
  readonly status: { readonly recorded: number; readonly run: number | null };
  readonly durationMs: { readonly recorded: number; readonly run: number | null };
  readonly attribution: string | null;
  readonly rulesApplied: readonly { readonly name: string; readonly tier: string }[];
  readonly variablesUsed: readonly { readonly name: string; readonly value: string }[];
  readonly variablesSaved: readonly { readonly name: string; readonly value: string }[];
  /** Fields of the answer that differ from the recording: `a` recorded, `b` this run. */
  readonly differences: readonly FieldChange[];
  readonly request: HttpShape | null;
  readonly response: HttpShape | null;
  readonly recorded: { readonly request: HttpShape; readonly response: HttpShape };
  readonly error: string | null;
}

export interface RunReport {
  readonly title: string;
  readonly cycle: { readonly id: string; readonly name: string; readonly versionSavedAt: string | null };
  readonly run: {
    readonly id: string;
    readonly status: Run['status'];
    readonly statusText: string;
    readonly driver: string;
    readonly startedAt: string;
    readonly finishedAt: string | null;
    readonly durationMs: number | null;
    readonly startedFrom: string | null;
  };
  readonly exportedAt: string;
  readonly verdict: ReportVerdict;
  readonly counts: { readonly steps: number; readonly passed: number; readonly differences: number; readonly failed: number; readonly notRun: number; readonly live: number; readonly replayed: number };
  readonly about: ReportAbout;
  readonly needsAttention: readonly { readonly number: string; readonly label: string; readonly outcome: ReportOutcome; readonly mode: string | null; readonly reason: string }[];
  readonly steps: readonly ReportStep[];
  readonly variables: readonly { readonly name: string; readonly value: string; readonly secret: boolean; readonly savedBy: string | null; readonly usedBy: readonly string[] }[];
  readonly log: readonly { readonly at: string; readonly step: string | null; readonly kind: string; readonly message: string }[];
  readonly glossary: readonly GlossaryEntry[];
  /** Names of the cycle's secret variables and every value they had - what .md/.html mask. */
  readonly secretNames: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export const RUN_STATUS_TEXT: Readonly<Record<Run['status'], string>> = {
  RUNNING: 'still running',
  COMPLETED: 'passed',
  COMPLETED_WITH_DIFFERENCES: 'completed with differences',
  FAILED: 'failed',
  STOPPED: 'stopped',
  INTERRUPTED: 'interrupted',
};

export const RUN_GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'Relive cycle', meaning: 'A saved, ordered list of HTTP calls recorded from real traffic, that ALFRED can send again on demand to check the system still answers the same way.' },
  { term: 'Run', meaning: 'One replay of a cycle: every step sent again in order, each answer compared with the recording.' },
  { term: 'Step / supplier call', meaning: 'A step is one inbound request into the application. The calls numbered under it (3.1, 3.2…) are the calls the application made to its suppliers while answering it.' },
  { term: 'LIVE', meaning: 'The call really went to the real system.' },
  { term: 'REPLAY', meaning: 'ALFRED answered the call itself with the recorded response; nothing left the machine.' },
  { term: 'Passed / differences / failed', meaning: 'Failed: an error, a timeout, no answer, a 5xx, a different status class than recorded (2xx → 4xx) or a failed check. Differences: answered normally, but a field that matters changed. Passed: nothing that matters changed.' },
  { term: 'Not run', meaning: 'The step was never sent - the run stopped before it, its parent failed, or it was switched off.' },
  { term: 'Noise', meaning: 'A field expected to change every time (timestamps, generated ids, tokens, trace headers, or a field the user marked as noise). Listed, but never counted as a difference.' },
  { term: 'Attribution', meaning: 'How ALFRED knew a call belonged to this run: a header it set (header), the X-Operation-Id the application forwarded (operation id), or the step in flight at that moment (in flight).' },
  { term: 'Variables', meaning: 'Values a step saved from its answer (for example a session id) and later steps sent, written {{name}} or {{$.name}}.' },
];

export const COMPARE_GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'A / B', meaning: 'A is the run before, B the run after. A may also be the recording itself.' },
  { term: 'New failure', meaning: 'The step passed (or did not run) in A and failed in B.' },
  { term: 'Fixed', meaning: 'The step failed in A and did not fail in B.' },
  { term: 'Answer changed', meaning: 'Both answered, but the status or a field that matters differs.' },
  { term: 'Ran in one only', meaning: 'The step was sent in one of the two runs only.' },
  { term: 'Slower / faster', meaning: 'The answer is the same, but B took more than 25% (and 50 ms) longer or shorter than A.' },
  ...RUN_GLOSSARY.filter((g) => ['LIVE', 'REPLAY', 'Noise', 'Step / supplier call'].includes(g.term)),
];

const SKIPPED: ReadonlySet<StepResult['state']> = new Set(['SKIPPED', 'NOT_CALLED', 'CANCELLED', 'PENDING', 'WAITING']);

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '-';
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** A name or a date as part of a download file name. */
export function fileSafe(text: string): string {
  return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'relive';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Step numbers in run order: 1, 2, 2.1, 2.2, 3 … */
export function stepNumbers(steps: readonly { readonly isChild: boolean; readonly key: string }[]): Map<string, { number: string; parent: string | null }> {
  const out = new Map<string, { number: string; parent: string | null }>();
  let top = 0;
  let child = 0;
  for (const s of steps) {
    if (!s.isChild) {
      top++;
      child = 0;
      out.set(s.key, { number: String(top), parent: null });
    } else {
      child++;
      out.set(s.key, { number: `${top || 0}.${child}`, parent: top ? String(top) : null });
    }
  }
  return out;
}

function outcomeWord(result: StepResult | undefined, recordingStatus: number): ReportOutcome {
  if (!result) return 'not run';
  if (SKIPPED.has(result.state)) return 'not run';
  const outcome = outcomeOfResult(result, recordingStatus);
  if (outcome === 'ok') return 'passed';
  if (outcome === 'diff') return 'differences';
  if (outcome === 'fail') return 'failed';
  return 'in progress';
}

function changeText(f: FieldChange): string {
  // A one-line reason names the change; the step's own table below has both values in full.
  const show = (v: string | null) => (v == null ? '(not present)' : v.length > 80 ? `${v.slice(0, 77)}…` : v);
  return `${f.path} ${show(f.a)} → ${show(f.b)}`;
}

function differenceReason(diffs: readonly FieldChange[]): string {
  const real = diffs.filter((d) => !d.noise);
  const noise = diffs.length - real.length;
  if (!real.length) return 'The answer differs from the recording only in a check on the whole body.';
  const shown = real.slice(0, 3).map((d) => changeText(d)).join('; ');
  return `${plural(real.length, 'field')} of the answer changed: ${shown}${real.length > 3 ? '; …' : ''}.${noise ? ` ${plural(noise, 'more field')} changed but ${noise === 1 ? 'is' : 'are'} noise.` : ''}`;
}

function reasonsOf(result: StepResult | undefined, step: Step, outcome: ReportOutcome, diffs: readonly FieldChange[], parent: StepResult | undefined, runEnded: boolean): string[] {
  if (outcome === 'passed' || outcome === 'in progress') return [];
  if (outcome === 'differences') return [differenceReason(diffs)];
  if (!result) {
    return [runEnded ? 'Not run: the run ended before this step was sent.' : 'Not sent yet.'];
  }
  const reasons = explainStep(result, step.recording.status, parent?.state ?? null).map((r) => r.detail ?? r.summary);
  return reasons;
}

/** The model of one run's export. `exportedAt` is passed in so a test can pin it. */
export function buildRunReport(run: FullRun, exportedAt: string): RunReport {
  const results = latestByStepKey(run.stepResults);
  const ordered = orderedSteps(run.definition.steps);
  const numbers = stepNumbers(ordered.map((o) => ({ isChild: o.isChild, key: o.step.key })));
  const side = runSide(run);
  const recordingOf = recordingSide(side);
  const runEnded = run.status !== 'RUNNING';
  const cycleNoise = run.definition.noise ?? [];

  const steps: ReportStep[] = ordered.map(({ step, isChild }) => {
    const result = results[step.key];
    const own = stepSide(side, step);
    const recorded = stepSide(recordingOf, step);
    const outcome = outcomeWord(result, step.recording.status);
    const differences = own.response ? responseChanges(recorded, own, [...cycleNoise, ...step.noise]) : [];
    const parent = step.parentKey ? results[step.parentKey] : undefined;
    const rec = step.recording;
    return {
      number: numbers.get(step.key)!.number,
      key: step.key,
      label: step.label,
      method: rec.method,
      url: rec.url,
      direction: step.direction,
      isChild,
      parentNumber: numbers.get(step.key)!.parent,
      mode: outcome === 'not run' ? null : result?.mode ?? null,
      outcome,
      reasons: reasonsOf(result, step, outcome, differences, parent, runEnded),
      status: { recorded: rec.status, run: own.status },
      durationMs: { recorded: rec.durationMs, run: outcome === 'not run' || (own.response == null && !own.durationMs) ? null : own.durationMs },
      attribution: result && outcome !== 'not run' ? result.attribution.toLowerCase().replace('_', ' ') : null,
      rulesApplied: (result?.rulesApplied ?? []).map((r) => ({ name: r.name, tier: r.tier.toLowerCase() })),
      variablesUsed: result?.variablesUsed ?? [],
      variablesSaved: result?.variablesProduced ?? [],
      differences,
      request: outcome === 'not run' ? null : own.request,
      response: outcome === 'not run' ? null : own.response,
      recorded: { request: recorded.request!, response: recorded.response! },
      error: result?.error ?? null,
    };
  });

  const count = (o: ReportOutcome) => steps.filter((s) => s.outcome === o).length;
  const counts = {
    steps: steps.length,
    passed: count('passed'),
    differences: count('differences'),
    failed: count('failed'),
    notRun: count('not run'),
    live: steps.filter((s) => s.mode === 'LIVE').length,
    replayed: steps.filter((s) => s.mode === 'REPLAY').length,
  };

  const values: Record<string, string> = {};
  for (const v of run.seedVariables) values[v.name] = v.value;
  for (const v of run.variableTimeline) values[v.name] = v.value;
  const secretNames = run.secrets ?? run.definition.variables.filter((v) => v.secret).map((v) => v.name);
  const numberOf = (key: string | null | undefined) => (key ? numbers.get(key)?.number ?? null : null);

  const lastByName = new Map<string, { value: string; stepKey: string | null }>();
  for (const v of run.seedVariables) lastByName.set(v.name, { value: v.value, stepKey: null });
  for (const v of run.variableTimeline) lastByName.set(v.name, { value: v.value, stepKey: v.stepKey });
  const variables = [...lastByName].map(([name, v]) => ({
    name,
    value: v.value,
    secret: secretNames.includes(name) || secretNames.includes(name.replace(/^\$\./, '')),
    savedBy: v.stepKey ? `${numberOf(v.stepKey)} · ${steps.find((s) => s.key === v.stepKey)?.label ?? v.stepKey}` : null,
    usedBy: steps.filter((s) => s.variablesUsed.some((u) => u.name === name)).map((s) => s.number),
  }));

  const durationMs = run.finishedAt ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : null;
  const name = run.definition.name || 'Relive cycle';
  const needsAttention = steps
    .filter((s) => s.outcome === 'failed' || s.outcome === 'differences')
    .sort((x, y) => (x.outcome === y.outcome ? 0 : x.outcome === 'failed' ? -1 : 1))
    .map((s) => ({ number: s.number, label: s.label, outcome: s.outcome, mode: s.mode, reason: s.reasons[0] ?? '' }));

  return {
    title: `Relive run report: ${name}`,
    cycle: { id: run.cycleId, name, versionSavedAt: run.definition.updatedAt ?? null },
    run: {
      id: run.id,
      status: run.status,
      statusText: RUN_STATUS_TEXT[run.status] ?? run.status.toLowerCase(),
      driver: run.driver === 'GUIDED' ? 'Guided (a person clicked through the app)' : 'Automatic (ALFRED sent every step)',
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      durationMs,
      startedFrom: run.fromStepKey ? `${numberOf(run.fromStepKey)} · ${steps.find((s) => s.key === run.fromStepKey)?.label ?? run.fromStepKey}` : null,
    },
    exportedAt,
    verdict: runVerdict(run, steps, counts),
    counts,
    about: runAbout(run, name, steps, counts, durationMs, secretNames.length > 0),
    needsAttention,
    steps,
    variables,
    log: run.log.map((e) => ({ at: e.at, step: numberOf(e.stepKey), kind: e.kind, message: e.message })),
    glossary: RUN_GLOSSARY,
    secretNames,
    values,
  };
}

function countsSentence(counts: RunReport['counts']): string {
  const parts = [`${counts.passed} of ${plural(counts.steps, 'step')} passed`];
  if (counts.differences) parts.push(`${counts.differences} ${counts.differences === 1 ? 'has' : 'have'} differences`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.notRun) parts.push(`${counts.notRun} did not run`);
  return `${joinList(parts)}.`;
}

function runVerdict(run: Run, steps: readonly ReportStep[], counts: RunReport['counts']): ReportVerdict {
  const firstFailed = steps.find((s) => s.outcome === 'failed' && !s.isChild) ?? steps.find((s) => s.outcome === 'failed');
  const tail = countsSentence(counts);
  if (firstFailed) {
    return { tone: 'bad', lead: `Failed at step ${firstFailed.number}, ${firstFailed.label}:`, text: `${firstFailed.reasons[0] ?? 'it failed.'} ${tail}` };
  }
  if (run.status === 'RUNNING') return { tone: 'neutral', lead: 'Still running:', text: `exported while the run was going. ${tail}` };
  if (run.status === 'STOPPED' || run.status === 'INTERRUPTED') {
    return { tone: 'mid', lead: run.status === 'STOPPED' ? 'Stopped before the end:' : 'Interrupted before the end:', text: tail };
  }
  if (counts.differences) {
    const which = steps.filter((s) => s.outcome === 'differences').map((s) => s.label);
    return { tone: 'mid', lead: 'Completed with differences:', text: `${plural(which.length, 'answer')} changed (${which.slice(0, 3).join(', ')}${which.length > 3 ? ', …' : ''}). ${tail}` };
  }
  return { tone: 'good', lead: 'Passed:', text: `every step answered like the recording. ${tail}` };
}

function runAbout(run: Run, name: string, steps: readonly ReportStep[], counts: RunReport['counts'], durationMs: number | null, hasSecrets: boolean): ReportAbout {
  const tops = steps.filter((s) => !s.isChild);
  const children = steps.filter((s) => s.isChild);
  const apps = [...new Set(run.definition.steps.filter((s) => !s.parentKey).map((s) => s.serviceName || hostOf(s.recording.url)))];
  const suppliers = [...new Set(children.map((s) => hostOf(s.url)))];
  const whatThisIs = `A record of one Relive run in ALFRED, a tool that records HTTP traffic and replays it. A Relive cycle is a saved sequence of calls recorded from real traffic - "${name}" has ${plural(tops.length, 'request')} into ${apps.length ? joinList(apps) : 'the application'}${children.length ? ` and the ${plural(children.length, 'call')} it made to ${suppliers.length === 1 ? 'its supplier' : 'its suppliers'} ${joinList(suppliers)} while handling them` : ''}. A run sends those calls again, in order, and compares each answer with what was recorded.`;

  const failed = steps.filter((s) => s.outcome === 'failed');
  const diffs = steps.filter((s) => s.outcome === 'differences');
  const how = run.driver === 'GUIDED' ? 'driven by a person clicking through the application (Guided)' : 'driven automatically by ALFRED';
  const parts = [`This run started ${formatWhen(run.startedAt)}, was ${how}${run.fromStepKey ? `, starting from step ${steps.find((s) => s.key === run.fromStepKey)?.number ?? '?'}` : ''}${durationMs != null ? `, and took ${formatMs(durationMs)}` : ''}. ${ENDED[run.status]}`];
  if (failed.length) {
    parts.push(`${failed.length === 1 ? 'One step failed' : `${failed.length} steps failed`}.`);
    for (const s of failed) parts.push(`Step ${s.number} (${s.label}): ${lowerFirst(trimStop(s.reasons[0] ?? 'it failed'))}.`);
  }
  if (diffs.length) parts.push(`${diffs.length === 1 ? 'One step answered' : `${diffs.length} steps answered`} differently from the recording: ${joinList(diffs.map((s) => `step ${s.number} (${s.label})`))}.`);
  if (counts.notRun) parts.push(`${plural(counts.notRun, 'step')} did not run.`);
  if (!failed.length && !diffs.length && !counts.notRun) parts.push('Every step answered like the recording.');
  parts.push(`${counts.live} ${counts.live === 1 ? 'call' : 'calls'} reached a real system (LIVE) and ALFRED answered ${counts.replayed} itself from the recording (REPLAY).`);

  const howToRead = `"Needs attention" lists every step that failed or differed, with the reason. "All steps" is the whole run in one table. Each step then shows what was sent, what came back and the recording it was compared with - every body in full, never shortened. Differences marked as noise are listed but never count.${hasSecrets ? ' Values of secret variables are shown as ••• in the .html and .md files (the .json keeps them).' : ''} Terms such as LIVE, REPLAY and noise are explained in the glossary at the end.`;
  return { whatThisIs, whatHappened: parts.join(' '), howToRead };
}

const ENDED: Readonly<Record<Run['status'], string>> = {
  RUNNING: 'It was still running when this was exported.',
  COMPLETED: 'It passed.',
  COMPLETED_WITH_DIFFERENCES: 'It completed, with differences.',
  FAILED: 'It failed.',
  STOPPED: 'It was stopped before the end.',
  INTERRUPTED: 'It was interrupted before the end.',
};

function trimStop(text: string): string {
  return text.replace(/[.\s]+$/, '');
}

function upperFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

// ---- The comparison document ----

export interface CompareSideInfo {
  readonly slot: 'A' | 'B';
  readonly role: 'before' | 'after';
  readonly isRecording: boolean;
  readonly runId: string | null;
  readonly label: string;
  readonly startedAt: string | null;
  readonly status: string | null;
  readonly steps: string;
  readonly durationMs: number | null;
  readonly driver: string | null;
  readonly cycleVersionSavedAt: string | null;
}

export interface CompareReport {
  readonly title: string;
  readonly cycleName: string;
  readonly exportedAt: string;
  readonly a: CompareSideInfo;
  readonly b: CompareSideInfo;
  readonly cycleEditedBetween: boolean;
  readonly verdict: ReportVerdict;
  readonly about: ReportAbout;
  readonly rows: readonly (StepComparison & { readonly number: string })[];
  readonly comparison: RunComparison;
  readonly glossary: readonly GlossaryEntry[];
  readonly secretNames: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export const VERDICT_WORDS: Readonly<Record<StepComparison['verdict'], string>> = {
  NEW_FAILURE: 'new failure',
  FIXED: 'fixed',
  CHANGED: 'answer changed',
  NOT_RUN: 'ran in one only',
  SLOWER: 'slower',
  FASTER: 'faster',
  SAME: 'same',
};

function sideInfo(side: CompareSide, slot: 'A' | 'B'): CompareSideInfo {
  const role = slot === 'A' ? 'before' : 'after';
  if (side.isRecording) {
    return { slot, role, isRecording: true, runId: null, label: 'the recording', startedAt: null, status: 'as recorded', steps: `${side.steps.length} steps`, durationMs: null, driver: null, cycleVersionSavedAt: side.cycleUpdatedAt };
  }
  const ran = Object.values(side.results).filter((r) => !SKIPPED.has(r.state)).length;
  return {
    slot,
    role,
    isRecording: false,
    runId: side.id,
    label: `run of ${formatWhen(side.startedAt)}`,
    startedAt: side.startedAt,
    status: side.status ? RUN_STATUS_TEXT[side.status] ?? side.status : null,
    steps: `${ran}/${side.steps.length} steps ran`,
    durationMs: side.startedAt && side.finishedAt ? Math.max(0, Date.parse(side.finishedAt) - Date.parse(side.startedAt)) : null,
    driver: side.driver === 'GUIDED' ? 'Guided' : side.driver ? 'Automatic' : null,
    cycleVersionSavedAt: side.cycleUpdatedAt,
  };
}

export function buildCompareReport(cmp: RunComparison, a: CompareSide, b: CompareSide, cycleName: string, exportedAt: string): CompareReport {
  const numbers = stepNumbers(cmp.rows);
  const rows = cmp.rows.map((r) => ({ ...r, number: numbers.get(r.key)!.number }));
  const ai = sideInfo(a, 'A');
  const bi = sideInfo(b, 'B');
  const edited = !a.isRecording && !b.isRecording && !!a.cycleUpdatedAt && !!b.cycleUpdatedAt && a.cycleUpdatedAt !== b.cycleUpdatedAt;
  const name = cycleName || 'Relive cycle';
  const tone: ReportTone = { worse: 'bad', better: 'good', mixed: 'mid', differs: 'mid', same: 'good' }[cmp.verdict.tone] as ReportTone;

  const values: Record<string, string> = {};
  for (const v of [...a.variables, ...b.variables]) values[v.name] = v.value;

  const pick = (v: StepComparison['verdict']) => rows.filter((r) => r.verdict === v);
  const lines: string[] = [];
  const describe = (list: readonly { number: string; label: string }[]) => joinList(list.map((r) => `step ${r.number} (${r.label})`));
  if (pick('NEW_FAILURE').length) lines.push(`${describe(pick('NEW_FAILURE'))} failed in B but not in A.`);
  if (pick('FIXED').length) lines.push(`${describe(pick('FIXED'))} failed in A and no longer in B.`);
  if (pick('CHANGED').length) lines.push(`The answer of ${describe(pick('CHANGED'))} changed.`);
  if (pick('NOT_RUN').length) lines.push(`${describe(pick('NOT_RUN'))} ran in only one of the two.`);
  if (pick('SLOWER').length) lines.push(`${describe(pick('SLOWER'))} got slower.`);
  if (pick('FASTER').length) lines.push(`${describe(pick('FASTER'))} got faster.`);
  if (!lines.length) lines.push('Every step has the same outcome, answer and time.');
  if (edited) lines.push('The cycle was edited between the two runs, so a change may come from that edit rather than from the systems.');

  return {
    title: `Relive run comparison: ${name}`,
    cycleName: name,
    exportedAt,
    a: ai,
    b: bi,
    cycleEditedBetween: edited,
    verdict: { tone, lead: cmp.verdict.lead, text: cmp.verdict.text },
    about: {
      whatThisIs: `A comparison of two ${a.isRecording ? 'versions' : 'runs'} of the same Relive cycle, "${name}", made by ALFRED, a tool that records HTTP traffic and replays it: A (before) is the ${ai.label}, B (after) is the ${bi.label}. ${a.isRecording ? 'Every step of B is compared with what was originally recorded.' : 'Both replayed the same recorded calls.'} This document shows, step by step, which steps started or stopped failing, whose answers changed, and which got slower or faster.`,
      whatHappened: `${cmp.verdict.lead} ${cmp.verdict.text} ${lines.map(upperFirst).join(' ')}`,
      howToRead: `Fields expected to change every run - timestamps, generated ids, tokens, and fields the user marked as noise - never make a step "changed". "Steps" lists every step with its verdict; "What changed" then shows each changed step: the fields that differ (A | B), what it sent differently, and both full responses, never shortened. Secret values are shown as ••• in the .html and .md files (the .json keeps them). The glossary at the end explains the terms.`,
    },
    rows,
    comparison: cmp,
    glossary: COMPARE_GLOSSARY,
    secretNames: [...new Set([...a.secretNames, ...b.secretNames])],
    values,
  };
}

