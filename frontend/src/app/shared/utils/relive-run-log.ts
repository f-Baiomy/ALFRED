import { LogEntry, Step } from './relive-types';

/**
 * Turns a run's raw execution log (FR-038) into one row per step attempt.
 *
 * The backend log is append-only and written from two places: the run page writes a `SENT`/`ERROR`
 * line when a step settles, and the proxy's observer writes a `FORWARDED_LIVE`/`REPLAYED`/`BLOCKED`
 * line (plus `REQUEST_CHANGED`/`RULE_APPLIED`) for the call itself. Shown raw, every call appears
 * twice, lines are out of time order (the proxy line usually arrives after the page line that
 * followed it), and two timestamp formats are mixed. This merges each attempt's lines into one row,
 * sorted by time, and nests outbound child steps under their parent's attempt. It works on the
 * stored log only, so runs saved before this existed display the same way.
 */

export type RunLogTag = 'problem' | 'rule' | 'var' | 'hold';
export type RunLogOutcomeKind = 'ok' | 'diff' | 'fail' | 'skip' | 'warn' | 'info';
export type RunLogAnsweredBy = 'LIVE' | 'REPLAYED' | 'BLOCKED';

export interface RunLogEvent {
  readonly icon: string;
  readonly label: string;
  readonly text: string;
}

export interface RunLogRow {
  readonly id: string;
  readonly at: string;
  readonly atMs: number;
  readonly stepKey: string | null;
  readonly stepLabel: string | null;
  readonly direction: 'inbound' | 'outbound' | null;
  readonly method: string | null;
  /** What the row shows: the path for an inbound call, host + path for an outbound one, else the message. */
  readonly target: string;
  readonly url: string | null;
  readonly answeredBy: RunLogAnsweredBy | null;
  readonly status: number | null;
  readonly outcome: { readonly kind: RunLogOutcomeKind; readonly label: string } | null;
  readonly attempt: number | null;
  readonly events: readonly RunLogEvent[];
  readonly tags: readonly RunLogTag[];
  readonly children: readonly RunLogRow[];
}

interface Indexed extends LogEntry {
  readonly ms: number;
  readonly index: number;
}

const CALL_KINDS: ReadonlySet<string> = new Set(['FORWARDED_LIVE', 'REPLAYED', 'BLOCKED']);
const SETTLE_KINDS: ReadonlySet<string> = new Set(['SENT', 'ERROR']);
/** Lines written after the step settled (a value extracted from its response, a hold released)
 *  belong to the attempt that just ended, not to a new one. */
const TRAILING_KINDS: ReadonlySet<string> = new Set(['VARIABLE_SET', 'CONTINUED', 'RESUMED', 'MATCHED']);

const OUTCOMES: Readonly<Record<string, { readonly kind: RunLogOutcomeKind; readonly label: string }>> = {
  COMPLETED: { kind: 'ok', label: '✓ OK' },
  COMPLETED_WITH_DIFFERENCES: { kind: 'diff', label: '≠ differs' },
  FAILED: { kind: 'fail', label: '✗ failed' },
  SKIPPED: { kind: 'skip', label: 'skipped' },
  NOT_CALLED: { kind: 'skip', label: 'not called' },
  CANCELLED: { kind: 'skip', label: 'cancelled' },
};

const ATTRIBUTION: Readonly<Record<string, string>> = {
  header: 'by the ALFRED run header',
  operation_id: 'by operation id',
  inflight: 'as part of the step in flight',
  ambiguous: 'ambiguous - more than one run could own it',
  unattributed: 'not matched to a step',
};

export function buildRunLog(log: readonly LogEntry[], steps: readonly Step[]): readonly RunLogRow[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const sorted = log
    .map((entry, index): Indexed => ({ ...entry, index, ms: Date.parse(entry.at) }))
    .sort((a, b) => (Number.isNaN(a.ms) || Number.isNaN(b.ms) ? 0 : a.ms - b.ms) || a.index - b.index);

  const groupsByStep = new Map<string, Indexed[][]>();
  const open = new Map<string, Indexed[]>();
  const standalone: Indexed[] = [];

  const startGroup = (key: string, entry: Indexed): void => {
    const group = [entry];
    const list = groupsByStep.get(key) ?? [];
    list.push(group);
    groupsByStep.set(key, list);
    open.set(key, group);
  };

  for (const entry of sorted) {
    const key = entry.stepKey ?? null;
    if (!key || !byKey.has(key) || entry.kind === 'UNEXPECTED_CALL') {
      standalone.push(entry);
      continue;
    }
    const current = open.get(key);
    if (TRAILING_KINDS.has(entry.kind) && !current) {
      const last = groupsByStep.get(key)?.at(-1);
      if (last) last.push(entry);
      else startGroup(key, entry);
      continue;
    }
    if (!current || (CALL_KINDS.has(entry.kind) && current.some((e) => CALL_KINDS.has(e.kind)))) {
      startGroup(key, entry);
    } else {
      current.push(entry);
    }
    if (SETTLE_KINDS.has(entry.kind)) open.delete(key);
  }

  const rowsByStep = new Map<string, RunLogRow[]>();
  for (const [key, groups] of groupsByStep) {
    const step = byKey.get(key)!;
    rowsByStep.set(key, groups.map((group, i) => stepRow(step, group, `${key}#${i}`)));
  }

  // Outbound child steps sit under the parent attempt they ran in: the last one that started
  // before them, or the first one when the child's line came in earlier.
  const childrenOf = new Map<RunLogRow, RunLogRow[]>();
  const top: RunLogRow[] = [];
  for (const [key, rows] of rowsByStep) {
    const parentRows = byKey.get(key)?.parentKey ? rowsByStep.get(byKey.get(key)!.parentKey!) : undefined;
    for (const row of rows) {
      if (!parentRows?.length) {
        top.push(row);
        continue;
      }
      const parent = [...parentRows].reverse().find((p) => p.atMs <= row.atMs) ?? parentRows[0];
      childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), row]);
    }
  }
  standalone.forEach((entry) => top.push(standaloneRow(entry, byKey.get(entry.stepKey ?? '') ?? null)));

  return top
    .map((row) => {
      const children = (childrenOf.get(row) ?? []).sort(byTime);
      return children.length ? { ...row, children, tags: mergeTags(row.tags, children) } : row;
    })
    .sort(byTime);
}

function stepRow(step: Step, group: readonly Indexed[], id: string): RunLogRow {
  const call = group.find((e) => CALL_KINDS.has(e.kind));
  const settled = [...group].reverse().find((e) => SETTLE_KINDS.has(e.kind));
  const parsedCall = call ? parseCallMessage(call.message) : null;
  const parsedSettle = settled ? parseSettleMessage(settled.message) : null;
  const events: RunLogEvent[] = [];
  const tags = new Set<RunLogTag>();

  if (parsedCall?.attribution) {
    events.push({ icon: '🔗', label: 'Matched', text: ATTRIBUTION[parsedCall.attribution] ?? parsedCall.attribution });
  }
  for (const entry of group) {
    if (entry === call || entry === settled) continue;
    const event = eventOf(entry);
    events.push(event.event);
    if (event.tag) tags.add(event.tag);
  }
  if (parsedSettle?.error) events.push({ icon: '✗', label: 'Error', text: parsedSettle.error });
  if (settled && !parsedSettle) events.push({ icon: '•', label: humanize(settled.kind), text: settled.message });

  const answeredBy = call ? answeredByOf(call.kind) : null;
  let outcome = parsedSettle ? (OUTCOMES[parsedSettle.state] ?? { kind: 'info', label: humanize(parsedSettle.state) }) : null;
  if (!outcome && settled?.kind === 'ERROR') outcome = OUTCOMES['FAILED'];
  if (!outcome && answeredBy === 'BLOCKED') outcome = { kind: 'fail', label: '✗ blocked' };
  if (outcome?.kind === 'fail' || outcome?.kind === 'diff' || answeredBy === 'BLOCKED') tags.add('problem');

  const url = parsedCall?.url ?? step.recording.url;
  const direction = parsedCall?.direction ?? step.direction;
  const first = call ?? group[0];
  return {
    id,
    at: first.at,
    atMs: first.ms,
    stepKey: step.key,
    stepLabel: step.label,
    direction,
    method: parsedCall?.method ?? step.recording.method,
    target: targetOf(url, direction),
    url,
    answeredBy,
    status: parsedCall?.status ?? null,
    outcome,
    attempt: parsedSettle?.attempt ?? null,
    events,
    tags: [...tags],
    children: [],
  };
}

function standaloneRow(entry: Indexed, step: Step | null): RunLogRow {
  const base = {
    id: `log#${entry.index}`,
    at: entry.at,
    atMs: entry.ms,
    stepKey: step?.key ?? null,
    stepLabel: step?.label ?? null,
    attempt: null,
    children: [],
  };
  if (entry.kind === 'UNEXPECTED_CALL') {
    const match = /^(\S+) (\S+) matched no step(?: - (.*))?$/s.exec(entry.message);
    const url = match?.[2] ?? null;
    return {
      ...base,
      direction: null,
      method: match?.[1] ?? null,
      target: url ? targetOf(url, 'outbound') : entry.message,
      url,
      answeredBy: match?.[3]?.includes('real system') ? 'LIVE' : match?.[3] ? 'REPLAYED' : null,
      status: null,
      outcome: { kind: 'warn', label: '⚠ unexpected' },
      events: [{ icon: '⚠', label: 'Unexpected', text: 'matched no step' + (match?.[3] ? ` - ${match[3]}` : '') }],
      tags: ['problem'],
    };
  }
  const blocked = entry.kind === 'AMBIGUOUS_BLOCKED';
  return {
    ...base,
    direction: null,
    method: null,
    target: entry.message,
    url: null,
    answeredBy: blocked ? 'BLOCKED' : null,
    status: null,
    outcome: blocked
      ? { kind: 'fail', label: '✗ blocked' }
      : entry.kind === 'DEFINITION_UPDATED'
        ? { kind: 'info', label: '✎ cycle edited' }
        : { kind: entry.kind === 'ERROR' ? 'fail' : 'info', label: humanize(entry.kind) },
    events: [],
    tags: blocked || entry.kind === 'ERROR' ? ['problem'] : [],
  };
}

function eventOf(entry: Indexed): { readonly event: RunLogEvent; readonly tag?: RunLogTag } {
  switch (entry.kind) {
    case 'REQUEST_CHANGED':
      return { event: { icon: '≠', label: 'Request changed', text: 'differs from the recording' } };
    case 'RULE_APPLIED':
      return { event: { icon: '⚙', label: 'Rule applied', text: entry.message }, tag: 'rule' };
    case 'VARIABLE_SET':
      return { event: { icon: '📦', label: 'Variable set', text: entry.message }, tag: 'var' };
    case 'HELD':
      return { event: { icon: '⏸', label: 'Held', text: entry.message }, tag: 'hold' };
    case 'CONTINUED':
      return { event: { icon: '▶', label: 'Continued', text: entry.message }, tag: 'hold' };
    case 'RESUMED':
      return { event: { icon: '↻', label: 'Resumed', text: entry.message } };
    default:
      return { event: { icon: '•', label: humanize(entry.kind), text: entry.message } };
  }
}

function parseCallMessage(message: string): {
  readonly direction: 'inbound' | 'outbound';
  readonly method: string;
  readonly url: string;
  readonly attribution: string;
  readonly status: number | null;
} | null {
  const match = /^(inbound|outbound) (\S+) (\S+) \(([^,)]*)(?:, (\d{3}))?\)$/.exec(message);
  if (!match) return null;
  return {
    direction: match[1] as 'inbound' | 'outbound',
    method: match[2],
    url: match[3],
    attribution: match[4],
    status: match[5] ? Number(match[5]) : null,
  };
}

function parseSettleMessage(message: string): { readonly attempt: number; readonly state: string; readonly error: string | null } | null {
  const match = /^Attempt (\d+): (\w+)(?: - (.*))?$/s.exec(message);
  return match ? { attempt: Number(match[1]), state: match[2], error: match[3] ?? null } : null;
}

function answeredByOf(kind: string): RunLogAnsweredBy {
  return kind === 'FORWARDED_LIVE' ? 'LIVE' : kind === 'BLOCKED' ? 'BLOCKED' : 'REPLAYED';
}

/** An inbound call's host is always the app being run, so only its path is shown; an outbound
 *  call keeps its host, since that is which supplier it went to. */
function targetOf(url: string, direction: 'inbound' | 'outbound' | null): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return direction === 'outbound' ? parsed.host + path : path;
  } catch {
    return url;
  }
}

function humanize(kind: string): string {
  const words = kind.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function mergeTags(own: readonly RunLogTag[], children: readonly RunLogRow[]): readonly RunLogTag[] {
  return [...new Set([...own, ...children.flatMap((c) => c.tags)])];
}

function byTime(a: RunLogRow, b: RunLogRow): number {
  return Number.isNaN(a.atMs) || Number.isNaN(b.atMs) ? 0 : a.atMs - b.atMs;
}

/** Local wall-clock time with milliseconds, e.g. `19:16:19.634`. */
export function runLogTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Time since the run started, e.g. `+4.7s` or `+1m 05s`. */
export function runLogOffset(atMs: number, startMs: number): string {
  if (Number.isNaN(atMs) || Number.isNaN(startMs)) return '';
  const seconds = Math.max(0, (atMs - startMs) / 1000);
  if (seconds < 60) return `+${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `+${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}
