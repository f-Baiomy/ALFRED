import { UpdateJob } from '../../core/models/server-settings.model';
import { formatBytes } from './server-settings';

/**
 * The Server card's progress dialog (Restart Alfred, Restart proxies, Install update) as a pure view: which step is
 * running, done or failed, and how full the bar is. Every step moves on a real event - the supervisor's update job
 * (DOWNLOADING with its bytes, VERIFYING, INSTALLING, FAILED), the /ws/server socket dropping (Alfred stopped) and
 * coming back (Alfred answers). Only the stretches nobody can report on (the installer running, Alfred starting)
 * let the bar creep towards the end of their span, never reaching it, so it never sits still and never lies about
 * being done.
 */
export type ProgressKind = 'BACKEND' | 'PROXIES' | 'UPDATE';
export type StepState = 'pending' | 'active' | 'done' | 'fail';
export type ProgressOutcome = 'running' | 'ok' | 'failed';

export interface ProgressStep {
  label: string;
  state: StepState;
  detail: string;
  /** The step's own bar, 0-100 - the download's real bytes while it runs; absent for the other steps. */
  bar?: number;
}

export interface ProgressView {
  steps: ProgressStep[];
  /** 0-100, one decimal. */
  percent: number;
  /** What the bar is doing right now: "Downloading", "Installing", "Done"... */
  phase: string;
  outcome: ProgressOutcome;
}

/** Everything the dialog knows; the component keeps it, this file only reads it. */
export interface ProgressInput {
  kind: ProgressKind;
  /** The supervisor's update job (UPDATE only), as last fetched. */
  job: UpdateJob | null;
  /** The installer size from the release feed, when the job has no Content-Length yet. */
  sizeBytes: number;
  /** The restart/install request was answered OK. */
  accepted: boolean;
  /** /ws/server closed after the request - Alfred stopped. */
  dropped: boolean;
  /** /ws/server opened again - Alfred answers. */
  back: boolean;
  /** The request failed, or the job did: the reason. */
  error: string | null;
  /** How long the current phase has lasted, for the creep. */
  phaseMs: number;
  /** Download speed in bytes per second, when known. */
  bytesPerSecond?: number;
}

/** Still starting after this long: say so on the last step instead of only spinning. */
export const SLOW_START_MS = 60_000;

const UPDATE_STEPS = ['Downloading the installer', 'Verifying its checksum', 'Installing - Alfred stops, its files are replaced',
  'Waiting for Alfred to answer'];
const BACKEND_STEPS = ['Stopping the backend', 'Starting it with the current .env - Alfred is unavailable for a moment'];
const PROXIES_STEPS = ['Restarting the outbound and reverse proxies'];

/**
 * lo → towards hi, never reaching it: half of the way in `halfMs`, and never past 95% of the stretch - a long
 * install must not round up into the next step's share of the bar.
 */
export function creep(lo: number, hi: number, ms: number, halfMs: number): number {
  return lo + (hi - lo) * Math.min(0.95, 1 - Math.pow(0.5, Math.max(0, ms) / halfMs));
}

/** Which phase the input is in - the component restarts its phase clock whenever this changes. */
export function progressPhase(input: ProgressInput): string {
  if (input.error) {
    return 'failed';
  }
  if (input.back) {
    return 'back';
  }
  if (input.dropped) {
    return 'dropped';
  }
  if (input.kind === 'UPDATE') {
    return input.job?.state ?? 'IDLE';
  }
  return input.accepted ? 'accepted' : 'asked';
}

export function progressView(input: ProgressInput): ProgressView {
  switch (input.kind) {
    case 'UPDATE':
      return updateView(input);
    case 'BACKEND':
      return backendView(input);
    default:
      return proxiesView(input);
  }
}

function steps(labels: string[], activeIndex: number, finished: boolean, failed: boolean): ProgressStep[] {
  return labels.map((label, i) => ({
    label,
    detail: '',
    state: finished || i < activeIndex ? 'done' : i === activeIndex ? (failed ? 'fail' : 'active') : 'pending',
  }));
}

function round(percent: number): number {
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

function updateView(input: ProgressInput): ProgressView {
  const state = input.job?.state ?? 'IDLE';
  // The socket dropping means the installer stopped Alfred, whatever the last job event said.
  let active = 0;
  let percent = 0;
  let phase = 'Downloading';
  if (input.back) {
    // Back with an error: Alfred answered, on the wrong version - the last step is the one that failed.
    active = input.error ? 3 : UPDATE_STEPS.length;
    percent = 95;
  } else if (input.dropped) {
    active = 3;
    percent = creep(90, 99, input.phaseMs, 15_000);
    phase = 'Starting Alfred';
  } else if (state === 'INSTALLING') {
    active = 2;
    percent = creep(70, 90, input.phaseMs, 6_000);
    phase = 'Installing';
  } else if (state === 'VERIFYING') {
    active = 1;
    percent = creep(60, 70, input.phaseMs, 2_000);
    phase = 'Verifying';
  } else if (state === 'FAILED') {
    active = failedStep(input.job);
    percent = active === 0 ? downloadPercent(input) : 60 + active * 5;
  } else {
    percent = downloadPercent(input);
  }
  const failed = !!input.error || state === 'FAILED';
  const view: ProgressView = {
    steps: steps(UPDATE_STEPS, active, input.back && !failed, failed),
    percent: round(input.back && !failed ? 100 : percent),
    phase: failed ? 'Stopped' : input.back ? 'Done' : phase,
    outcome: failed ? 'failed' : input.back ? 'ok' : 'running',
  };
  const total = input.job?.totalBytes || input.sizeBytes;
  const downloaded = input.job?.downloadedBytes ?? 0;
  if (total && (active > 0 || downloaded > 0)) {
    const speed = active === 0 && input.bytesPerSecond ? ` · ${formatBytes(Math.round(input.bytesPerSecond))}/s` : '';
    view.steps[0].detail = active > 0 ? formatBytes(total) : `${formatBytes(downloaded)} of ${formatBytes(total)}${speed}`;
    if (active === 0) {
      view.steps[0].bar = round(100 * Math.min(1, downloaded / total));
    }
  }
  if (active > 1) {
    view.steps[1].detail = 'sha256 matches the release';
  }
  if (active > 2) {
    view.steps[2].detail = 'Alfred stopped, files replaced';
  }
  if (active === 3 && input.phaseMs >= SLOW_START_MS) {
    view.steps[3].detail = 'still starting - the first start after an update takes longer';
  }
  if (failed) {
    const step = view.steps.find(s => s.state === 'fail');
    if (step) {
      step.detail = input.error || input.job?.error || 'failed';
    }
  }
  return view;
}

/** The supervisor's FAILED says nothing about where: its message does (checksum → verifying; else downloading). */
function failedStep(job: UpdateJob | null): number {
  const error = (job?.error ?? '').toLowerCase();
  if (error.includes('checksum')) {
    return 1;
  }
  if (error.includes('installer') && !error.includes('download')) {
    return 2;
  }
  return 0;
}

function downloadPercent(input: ProgressInput): number {
  const total = input.job?.totalBytes || input.sizeBytes;
  const downloaded = input.job?.downloadedBytes ?? 0;
  return total ? 60 * Math.min(1, downloaded / total) : creep(0, 30, input.phaseMs, 10_000);
}

function backendView(input: ProgressInput): ProgressView {
  const failed = !!input.error;
  const active = input.back ? 2 : input.dropped ? 1 : 0;
  const percent = input.back ? 100 : input.dropped ? creep(40, 99, input.phaseMs, 8_000) : creep(0, 40, input.phaseMs, 1_500);
  const view: ProgressView = {
    steps: steps(BACKEND_STEPS, active, input.back && !failed, failed),
    percent: round(percent),
    phase: failed ? 'Stopped' : input.back ? 'Done' : input.dropped ? 'Starting Alfred' : 'Stopping',
    outcome: failed ? 'failed' : input.back ? 'ok' : 'running',
  };
  if (failed) {
    view.steps[active].detail = input.error!;
  } else if (active === 1 && input.phaseMs >= SLOW_START_MS) {
    view.steps[1].detail = 'still starting';
  }
  return view;
}

function proxiesView(input: ProgressInput): ProgressView {
  const failed = !!input.error;
  const finished = input.accepted && !failed;
  const view: ProgressView = {
    steps: steps(PROXIES_STEPS, 0, finished, failed),
    percent: round(finished ? 100 : creep(0, 95, input.phaseMs, 1_500)),
    phase: failed ? 'Stopped' : finished ? 'Done' : 'Restarting',
    outcome: failed ? 'failed' : finished ? 'ok' : 'running',
  };
  if (failed) {
    view.steps[0].detail = input.error!;
  }
  return view;
}
