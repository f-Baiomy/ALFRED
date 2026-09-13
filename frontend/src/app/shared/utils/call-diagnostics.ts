import { CallRecord } from '../../core/models/call.model';
import { CallTreeNode } from './call-tree';

/**
 * Where a root call's wall-clock time actually went.
 *
 * Every millisecond of the root's duration lands in exactly one bucket:
 *
 *   duration = setup + upstream + between + tail
 *
 * `upstream` is the UNION of the children's windows, not their sum. Six calls running in parallel
 * occupy one stretch of wall clock, not six - summing them would claim more time than the request
 * took. The union is also what makes "time between calls" meaningful when calls overlap: rather
 * than a per-pair gap (which can be negative, and there are n^2 of them), `between` is the time
 * inside the fan-out window when NOTHING was in flight. With sequential calls that degenerates to
 * the obvious gap; with parallel ones it stays correct.
 */
export interface TimeLedger {
  readonly durationMs: number;
  /** Root start until the first outbound call left. */
  readonly setupMs: number;
  /** Wall clock with at least one call in flight. */
  readonly upstreamMs: number;
  /** Inside the fan-out window, with nothing in flight. */
  readonly betweenMs: number;
  /** Last response in until the root itself answered. */
  readonly tailMs: number;
  /** setup + between + tail - time the root spent somewhere other than an outbound call. */
  readonly unaccountedMs: number;
  /** The actual stretches making up `betweenMs`, as offsets from the root's start. */
  readonly gaps: readonly Gap[];
}

export interface Gap {
  readonly fromMs: number;
  readonly toMs: number;
  readonly durationMs: number;
}

export interface CallTiming {
  readonly call: CallRecord;
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly endMs: number;
  /**
   * How much slower this call could get without delaying the root, given everything else stayed
   * put. Zero means it is on the critical path and is the only kind of call worth optimising -
   * shaving a second off anything with slack changes the total by nothing.
   */
  readonly slackMs: number;
  readonly onCriticalPath: boolean;
  readonly failed: boolean;
}

export interface Parallelism {
  /** Summed child durations over wall-clock time they occupy. 1.0 = strictly sequential. */
  readonly factor: number;
  readonly maxConcurrent: number;
  readonly sumOfDurationsMs: number;
  /** What running them one after another would have cost, minus what they actually cost. */
  readonly savedByParallelismMs: number;
}

export type FindingLevel = 'problem' | 'watch' | 'good';

export interface Finding {
  readonly level: FindingLevel;
  readonly title: string;
  readonly detail: string;
}

export interface CallDiagnostics {
  readonly ledger: TimeLedger;
  readonly timings: readonly CallTiming[];
  readonly parallelism: Parallelism | null;
  readonly findings: readonly Finding[];
}

function startMs(call: CallRecord): number {
  return new Date(call.timestamp).getTime();
}

/** Only a call with a real, finished window can be placed on a timeline. */
function isMeasurable(call: CallRecord): boolean {
  return call.state !== 'IN_PROGRESS' && (call.duration_ms ?? 0) > 0 && Number.isFinite(startMs(call));
}

function mergeWindows(windows: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function maxConcurrentOf(windows: readonly { start: number; end: number }[]): number {
  // Ends before starts at an equal timestamp: a call that finishes exactly as another begins was
  // never actually concurrent with it.
  const events = [
    ...windows.map((w) => ({ at: w.start, delta: 1 })),
    ...windows.map((w) => ({ at: w.end, delta: -1 })),
  ].sort((a, b) => a.at - b.at || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

const PHASE_DOMINANT_FRACTION = 0.4;
const UPSTREAM_DOMINANT_FRACTION = 0.6;
/** Two identical requests closer together than this are worth a second look - see the duplicate rule. */
const DUPLICATE_WINDOW_MS = 150;

/**
 * Analyses ONE root call against its direct children.
 *
 * Direct children only, deliberately: a grandchild happened inside a child, so it belongs to that
 * child's own accounting. Mixing depths would double-count the same wall clock.
 */
export function analyzeCall(node: CallTreeNode): CallDiagnostics | null {
  const root = node.call;
  if (!isMeasurable(root)) return null;

  const rootStart = startMs(root);
  const durationMs = root.duration_ms ?? 0;
  const children = node.children.map((child) => child.call).filter(isMeasurable);

  if (children.length === 0) {
    return {
      ledger: {
        durationMs,
        setupMs: 0,
        upstreamMs: 0,
        betweenMs: 0,
        tailMs: 0,
        unaccountedMs: durationMs,
        gaps: [],
      },
      timings: [],
      parallelism: null,
      findings: [
        {
          level: 'watch',
          title: 'No outbound calls were logged inside this one',
          detail: `All ${formatMs(durationMs)} happened inside your app, or the calls it made did not go through Alfred's proxy.`,
        },
      ],
    };
  }

  const windows = children.map((call) => {
    const start = startMs(call);
    return { start, end: start + (call.duration_ms ?? 0) };
  });
  const merged = mergeWindows(windows);
  const firstStart = merged[0].start;
  const lastEnd = merged[merged.length - 1].end;

  const upstreamMs = merged.reduce((total, window) => total + (window.end - window.start), 0);
  const setupMs = Math.max(0, firstStart - rootStart);
  const tailMs = Math.max(0, rootStart + durationMs - lastEnd);
  const betweenMs = Math.max(0, lastEnd - firstStart - upstreamMs);

  const gaps: Gap[] = [];
  for (let i = 1; i < merged.length; i++) {
    gaps.push({
      fromMs: merged[i - 1].end - rootStart,
      toMs: merged[i].start - rootStart,
      durationMs: merged[i].start - merged[i - 1].end,
    });
  }

  const timings: CallTiming[] = children.map((call, index) => {
    const window = windows[index];
    return {
      call,
      offsetMs: window.start - rootStart,
      durationMs: call.duration_ms ?? 0,
      endMs: window.end - rootStart,
      slackMs: Math.max(0, lastEnd - window.end),
      onCriticalPath: window.end === lastEnd,
      failed: !!call.error || (call.response?.status ?? 0) >= 500,
    };
  });

  const sumOfDurationsMs = windows.reduce((total, window) => total + (window.end - window.start), 0);
  const parallelism: Parallelism = {
    factor: upstreamMs > 0 ? sumOfDurationsMs / upstreamMs : 1,
    maxConcurrent: maxConcurrentOf(windows),
    sumOfDurationsMs,
    savedByParallelismMs: Math.max(0, sumOfDurationsMs - upstreamMs),
  };

  const ledger: TimeLedger = {
    durationMs,
    setupMs,
    upstreamMs,
    betweenMs,
    tailMs,
    unaccountedMs: setupMs + betweenMs + tailMs,
    gaps,
  };

  return { ledger, timings, parallelism, findings: buildFindings(ledger, timings, parallelism) };
}

function buildFindings(
  ledger: TimeLedger,
  timings: readonly CallTiming[],
  parallelism: Parallelism
): readonly Finding[] {
  const findings: Finding[] = [];
  const total = ledger.durationMs || 1;

  if (ledger.tailMs / total >= PHASE_DOMINANT_FRACTION) {
    findings.push({
      level: 'problem',
      title: `${percent(ledger.tailMs, total)} of this call runs after every response arrived`,
      detail: `${formatMs(ledger.tailMs)} with nothing in flight. Whatever is slow is in your app after the last response, not upstream.`,
    });
  }
  if (ledger.setupMs / total >= PHASE_DOMINANT_FRACTION) {
    findings.push({
      level: 'problem',
      title: `${percent(ledger.setupMs, total)} of this call runs before the first request goes out`,
      detail: `${formatMs(ledger.setupMs)} of setup before any outbound call. Look at what happens between receiving the request and making the first one.`,
    });
  }
  if (ledger.upstreamMs / total >= UPSTREAM_DOMINANT_FRACTION) {
    findings.push({
      level: 'problem',
      title: `${percent(ledger.upstreamMs, total)} of this call is spent waiting upstream`,
      detail: 'The suppliers really are the bottleneck here. Look at the critical-path call below.',
    });
  }
  if (ledger.betweenMs / total >= 0.15) {
    findings.push({
      level: 'watch',
      title: `${formatMs(ledger.betweenMs)} of dead time between calls`,
      detail: 'Stretches inside the fan-out window with nothing in flight - work happening between one response and the next request.',
    });
  }

  // Sequential fan-out is the classic accidental regression: an await inside a loop turns a
  // parallel fan-out into a queue, and the total jumps without any individual call getting slower.
  if (timings.length >= 3 && parallelism.maxConcurrent === 1) {
    findings.push({
      level: 'problem',
      title: `${timings.length} calls run one at a time`,
      detail: `Nothing overlaps. Running them together would save around ${formatMs(parallelism.sumOfDurationsMs - longestOf(timings))}.`,
    });
  } else if (parallelism.factor >= 1.5) {
    findings.push({
      level: 'good',
      title: `Fan-out is parallel: ${parallelism.factor.toFixed(1)}x`,
      detail: `${formatMs(parallelism.sumOfDurationsMs)} of upstream work in ${formatMs(ledger.upstreamMs)}, up to ${parallelism.maxConcurrent} at once. Running serially would cost ${formatMs(parallelism.savedByParallelismMs)} more.`,
    });
  }

  const failures = timings.filter((timing) => timing.failed);
  if (failures.length > 0) {
    findings.push({
      level: 'problem',
      title: `${failures.length} outbound ${failures.length === 1 ? 'call' : 'calls'} failed`,
      detail: failures.map((timing) => `${timing.call.method} ${pathOf(timing.call)}`).join(', '),
    });
  }

  for (const duplicate of findDuplicates(timings)) {
    findings.push(duplicate);
  }

  const withSlack = timings.filter((timing) => !timing.onCriticalPath && timing.slackMs > 0);
  if (timings.length > 1 && withSlack.length === timings.length - 1) {
    const critical = timings.find((timing) => timing.onCriticalPath);
    if (critical) {
      findings.push({
        level: 'watch',
        title: `Only 1 of ${timings.length} calls is on the critical path`,
        detail: `${critical.call.method} ${pathOf(critical.call)} (${formatMs(critical.durationMs)}) decides the total. The other ${withSlack.length} have slack, so making them faster changes nothing.`,
      });
    }
  }

  return findings;
}

/**
 * Same method and path, started within DUPLICATE_WINDOW_MS of each other.
 *
 * Reported as something to look at rather than as a defect: fanning the same search out to several
 * suppliers is normal and legitimate, and this rule cannot tell that apart from genuinely doing the
 * work twice. It says what it saw and leaves the judgement to the reader.
 */
function findDuplicates(timings: readonly CallTiming[]): Finding[] {
  const groups = new Map<string, CallTiming[]>();
  for (const timing of timings) {
    const key = `${timing.call.method} ${timing.call.url}`;
    groups.set(key, [...(groups.get(key) ?? []), timing]);
  }

  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.offsetMs - b.offsetMs);
    const closest = Math.min(
      ...sorted.slice(1).map((timing, index) => timing.offsetMs - sorted[index].offsetMs)
    );
    if (closest > DUPLICATE_WINDOW_MS) continue;
    findings.push({
      level: 'watch',
      title: `${group.length} identical requests, ${formatMs(closest)} apart`,
      detail: `${key} - deliberate fan-out, or the same work done twice?`,
    });
  }
  return findings;
}

function longestOf(timings: readonly CallTiming[]): number {
  return timings.reduce((longest, timing) => Math.max(longest, timing.durationMs), 0);
}

function pathOf(call: CallRecord): string {
  try {
    return new URL(call.url).pathname;
  } catch {
    return call.url;
  }
}

function percent(part: number, total: number): string {
  return `${Math.round((part / total) * 100)}%`;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
