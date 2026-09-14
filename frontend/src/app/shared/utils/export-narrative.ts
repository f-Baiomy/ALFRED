import { CallOverlapCandidate, CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { buildCallTree, CallTreeNode, indexCallTree } from './call-tree';
import { isInProgress, supplierOf, uriPath } from './call-utils';

/**
 * The "About This Document" section every readable export opens with - the one thing in an export
 * that is *about* the data rather than being the data.
 *
 * An export is routinely handed to somebody (or some agent) who wasn't watching the traffic happen:
 * a supplier's support team, a colleague on another service, an LLM asked to find the bug. Those
 * readers get a wall of JSON with no statement of what they're looking at, which direction the
 * traffic went, which call caused which, or what the 🚩 annotations are. This module derives all of
 * that from the calls themselves and states it in plain language up front.
 *
 * Computed ONCE here and rendered per format (markdown-builder, html-builder, bulk-json-builder)
 * rather than mirrored per consumer like the split algorithm is - the split has to stay
 * byte-identical across builders because it decides which BLOCKS exist, whereas this is one section
 * of prose whose whole point is saying the same thing everywhere. A change here shows up in every
 * export at once.
 *
 * Deliberately NOT applied to the Discord/cURL/Postman exports: those are a chat blurb, a single
 * shell command and a runnable collection respectively, and a page of narrative would swamp all
 * three.
 */

/** One call in the narrative's topology - the export's own numbering, plus where its time went. */
export interface NarrativeCallNode {
  readonly callId: string;
  /** The call's number in the export, matching the summary table's "#" column (1-based, chronological). */
  readonly number: number;
  readonly depth: number;
  readonly direction: CallDirection;
  /** The project an inbound call arrived at ('odeysys'), or null on an external call. */
  readonly service: string | null;
  /** The third-party host an external call went to, or null on an inbound call. */
  readonly host: string | null;
  readonly method: string;
  readonly path: string;
  readonly durationMs: number | null;
  /**
   * How long this call spent waiting on calls nested inside it - the UNION of its direct children's
   * windows, not their sum: two children that overlap were waited on once, and summing them would
   * invent time the call never spent. Null on a leaf, which has no downstream work by definition.
   */
  readonly downstreamMs: number | null;
  /** durationMs - downstreamMs: the call's own work. Null on a leaf (where it's just the duration). */
  readonly selfMs: number | null;
  readonly status: number | null;
  readonly error: string | null;
  readonly inProgress: boolean;
  readonly children: readonly NarrativeCallNode[];
}

/**
 * Which side of a service a call was logged on. Named for the reader rather than for the store:
 * `CallRecord.source` is 'internal'/'external' (which REST resource it came from), but "internal"
 * reads like "internal to the company" to somebody outside this codebase, which is the wrong idea
 * entirely - what it actually means is that the call came INTO a service Alfred fronts.
 */
export type CallDirection = 'inbound' | 'outbound';

/** What a call, or the export as a whole, did at each level - see shapeOf. */
export interface NarrativeCounts {
  readonly calls: number;
  readonly inbound: number;
  readonly outbound: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly inProgress: number;
  readonly ambiguous: number;
  readonly services: readonly string[];
  readonly externalHosts: readonly string[];
  readonly flaggedLines: number;
}

/** Context Alfred can see but this file doesn't contain - only ever populated for a single-call export. */
export interface NarrativeNotIncluded {
  /**
   * The call this one happened inside, if any. Only ever partially described: the overlap feed
   * carries timing and attribution but no method or URL (see CallOverlapCandidate), so this can say
   * "a 17,084 ms inbound call to core-service" and truthfully not more than that.
   */
  readonly parent: { readonly service: string | null; readonly durationMs: number } | null;
  readonly descendantCount: number;
  readonly descendantInbound: number;
  readonly descendantOutbound: number;
  /** Of the call's own duration, how much is accounted for by those nested calls (union, as above). */
  readonly descendantMs: number | null;
}

export interface NarrativeTimingRow {
  readonly number: number;
  readonly label: string;
  readonly durationMs: number;
  readonly downstreamMs: number | null;
  readonly selfMs: number | null;
}

/**
 * Machine-readable facts plus the prose rendered from them. Both, deliberately: an agent
 * reprocessing the .json wants `depth`/`shape`/`topology` as data, and an agent given only the
 * `description` string still gets a usable summary without having to reimplement any of this.
 */
export interface ExportNarrative {
  readonly documentType: 'alfred-call-export';
  readonly scope: 'single' | 'multi';
  /** The whole "What this is" paragraph as one plain-text string - no markup, safe in any format. */
  readonly description: string;
  readonly capturedFrom: string | null;
  readonly capturedTo: string | null;
  readonly wallClockMs: number | null;
  /** 1 for a flat capture where nothing nests; 3 for inbound -> inbound -> external. */
  readonly depth: number;
  /**
   * The chain of directions the capture actually forms, e.g. 'outbound', 'inbound',
   * 'inbound -> outbound', 'inbound -> inbound -> outbound', or 'mixed' when a single level holds
   * both directions and no one chain describes it.
   */
  readonly shape: string;
  readonly counts: NarrativeCounts;
  readonly topology: readonly NarrativeCallNode[];
  /** The topology drawn as monospace text, ready to drop into a code fence or <pre>. */
  readonly treeLines: readonly string[];
  /** Prose restating the topology for a reader who won't parse the tree - null when there's no hierarchy. */
  readonly flowSummary: string | null;
  readonly notIncluded: NarrativeNotIncluded | null;
  readonly timingRows: readonly NarrativeTimingRow[];
  /** Used instead of timingRows when nothing nests and a table would have one meaningful column. */
  readonly timingNote: string | null;
  /** Failures, in-progress calls and ambiguous parentage - empty when the capture is clean. */
  readonly caveats: readonly string[];
  /** Why a call can appear twice in the list - null when nothing in this export was split. */
  readonly orderingNote: string | null;
  readonly commentsNote: string;
  readonly readingGuide: {
    readonly events: string;
    readonly nesting: string;
    readonly comments: string;
  };
}

export interface NarrativeInput {
  readonly calls: readonly CallRecord[];
  readonly commentsByCallId: ReadonlyMap<string, readonly Comment[]>;
  /**
   * The ids the CALLER decided to split into request/response blocks. Passed in rather than
   * recomputed so the ordering note can never claim a split the surrounding document didn't make -
   * each builder already has this set (see its own computeSplitCallIds). Empty for a format that
   * never splits.
   */
  readonly splitCallIds?: ReadonlySet<string>;
  /**
   * Only used for a single-call export, to describe the context that call sits in but the file
   * doesn't contain. Ignored for a multi-call export, whose topology comes from the exported calls
   * themselves.
   */
  readonly overlapCandidates?: readonly CallOverlapCandidate[];
}

function formatMs(ms: number): string {
  const hasFraction = Math.abs(ms % 1) > 1e-9;
  return `${ms.toLocaleString('en-US', { minimumFractionDigits: hasFraction ? 2 : 0, maximumFractionDigits: 2 })} ms`;
}

/** "22.4 s" reads as a span; "22,383 ms" reads as a measurement. Wall clock wants the former. */
function formatSpan(ms: number): string {
  if (ms < 1000) return formatMs(ms);
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds % 60)} s`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/** "a", "b" and "c" - an Oxford-less list, since these are read aloud in a sentence. */
function joinList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function directionOf(call: CallRecord): CallDirection {
  return call.source === 'internal' ? 'inbound' : 'outbound';
}

/** Title-cased the same way call-tree.ts's serviceLabel does, so a service reads the same everywhere. */
function serviceLabel(name: string | null | undefined): string {
  if (!name) return 'Internal';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What to call a call in prose - its service when Alfred knows whose it is, its host otherwise. */
function labelOf(call: CallRecord): string {
  return directionOf(call) === 'inbound' ? serviceLabel(call.service_name) : supplierOf(call);
}

function statusOf(call: CallRecord): number | null {
  return call.response?.status ?? null;
}

function failed(call: CallRecord): boolean {
  if (isInProgress(call)) return false;
  if (call.error) return true;
  const status = statusOf(call);
  return status == null || status >= 400;
}

function windowOf(call: CallRecord): { start: number; end: number } {
  const start = new Date(call.timestamp).getTime();
  return { start, end: start + (call.duration_ms ?? 0) };
}

/**
 * Total time covered by `intervals`, counting overlapping stretches once. Two children running in
 * parallel for 5s each occupy 5s of their parent's time, not 10 - summing would let "waiting on
 * downstream" exceed the parent's own duration and produce a negative "own work".
 */
function unionMs(intervals: readonly { start: number; end: number }[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start > end) {
      total += end - start;
      start = interval.start;
      end = interval.end;
    } else if (interval.end > end) {
      end = interval.end;
    }
  }
  return round2(total + (end - start));
}

/**
 * Derived times are rounded to the same 2dp the rendered prose shows. A window start comes from
 * Date.getTime() (whole ms) while a duration is fractional, so subtracting them produces artefacts
 * like 79.02984374999869 - invisible once formatted, but the .json exposes these numbers raw and a
 * consumer comparing them shouldn't inherit float noise that isn't really in the measurement.
 */
function round2(ms: number): number {
  return Math.round(ms * 100) / 100;
}

function buildNode(node: CallTreeNode, numberByCallId: ReadonlyMap<string, number>): NarrativeCallNode {
  const { call } = node;
  const direction = directionOf(call);
  const children = node.children.map((child) => buildNode(child, numberByCallId));
  const duration = call.duration_ms ?? null;
  const downstream = node.children.length > 0 ? unionMs(node.children.map((child) => windowOf(child.call))) : null;

  return {
    callId: call.id,
    number: numberByCallId.get(call.id) ?? 0,
    depth: node.depth,
    direction,
    service: direction === 'inbound' ? (call.service_name ?? null) : null,
    host: direction === 'outbound' ? supplierOf(call) : null,
    method: call.method,
    path: uriPath(call.url),
    durationMs: duration,
    downstreamMs: downstream,
    selfMs: duration != null && downstream != null ? round2(Math.max(0, duration - downstream)) : null,
    status: statusOf(call),
    error: call.error ?? null,
    inProgress: isInProgress(call),
    children,
  };
}

function flattenNodes(nodes: readonly NarrativeCallNode[]): NarrativeCallNode[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children)]);
}

/**
 * The chain of directions the capture forms, read down the tree one level at a time.
 *
 * A level holding both directions has no single answer ("mixed") rather than a guessed one - that
 * genuinely happens when one inbound call calls a supplier directly while its sibling calls another
 * service, and pretending otherwise would mislead exactly the reader this section exists for.
 */
function shapeOf(nodes: readonly NarrativeCallNode[], depth: number): string {
  if (nodes.length === 0) return 'empty';

  const directionsByLevel = new Map<number, Set<CallDirection>>();
  for (const node of flattenNodes(nodes)) {
    const set = directionsByLevel.get(node.depth) ?? new Set<CallDirection>();
    set.add(node.direction);
    directionsByLevel.set(node.depth, set);
  }

  const levels: string[] = [];
  for (let level = 0; level < depth; level++) {
    const set = directionsByLevel.get(level);
    if (!set || set.size !== 1) return 'mixed';
    levels.push([...set][0]);
  }
  return levels.join(' -> ');
}

const MAX_TREE_LINES = 40;

function nodeStatusText(node: NarrativeCallNode): string {
  if (node.inProgress) return 'in progress ⏳';
  if (node.error) return `${node.error} ❌`;
  if (node.status == null) return 'no response ❌';
  return `${node.status} ${node.status < 400 ? '✅' : '⚠️'}`;
}

/**
 * The topology as monospace text. Two passes: build each row's left half (the branch art and the
 * call), then pad every left half to the same width before appending the columns - otherwise the
 * direction/duration/status columns stagger with depth and stop being readable as columns at all.
 */
export function renderTreeLines(nodes: readonly NarrativeCallNode[]): readonly string[] {
  const rows: { left: string; direction: string; duration: string; status: string }[] = [];

  const walk = (siblings: readonly NarrativeCallNode[], prefix: string): void => {
    siblings.forEach((node, index) => {
      const last = index === siblings.length - 1;
      const branch = prefix === '' ? '' : last ? '└─ ' : '├─ ';
      const marker = node.children.length > 0 ? '▼ ' : '';
      const where = node.service ? serviceLabel(node.service) : (node.host ?? 'unknown');
      rows.push({
        left: `${prefix}${branch}${node.number}. ${marker}${node.method} ${where} · /${node.path}`,
        direction: node.direction,
        duration: node.durationMs != null ? formatMs(node.durationMs) : '—',
        status: nodeStatusText(node),
      });
      const childPrefix = prefix === '' ? '   ' : `${prefix}${last ? '   ' : '│  '}`;
      walk(node.children, childPrefix);
    });
  };
  walk(nodes, '');

  const shown = rows.slice(0, MAX_TREE_LINES);
  const leftWidth = Math.max(...shown.map((row) => row.left.length), 0);
  const durationWidth = Math.max(...shown.map((row) => row.duration.length), 0);
  const lines = shown.map(
    (row) => `${row.left.padEnd(leftWidth)}   ${row.direction.padEnd(8)} ${row.duration.padStart(durationWidth)}   ${row.status}`
  );

  if (rows.length > shown.length) {
    const remaining = rows.length - shown.length;
    lines.push(`⋯ ${remaining} further ${plural(remaining, 'call')} not drawn — see the summary table`);
  }
  return lines;
}

function flowSummaryOf(nodes: readonly NarrativeCallNode[]): string | null {
  const roots = nodes.filter((node) => node.children.length > 0);
  if (roots.length === 0) return null;

  const describe = (node: NarrativeCallNode): string => {
    const where = node.service ? serviceLabel(node.service) : (node.host ?? 'unknown');
    const subtree = flattenNodes(node.children);
    const inbound = subtree.filter((child) => child.direction === 'inbound');
    const outbound = subtree.filter((child) => child.direction === 'outbound');
    const hosts = [...new Set(outbound.map((child) => child.host).filter((host): host is string => host != null))];

    const parts: string[] = [];
    if (inbound.length > 0) {
      const services = [...new Set(inbound.map((child) => serviceLabel(child.service)))];
      parts.push(`${inbound.length} inbound ${plural(inbound.length, 'call')} to ${joinList(services)}`);
    }
    if (outbound.length > 0) {
      parts.push(
        `${outbound.length} outbound ${plural(outbound.length, 'call')} to ${hosts.length} external ${plural(
          hosts.length,
          'host'
        )} (${joinList(hosts)})`
      );
    }
    return `Call ${node.number}, ${node.method} into ${where}, caused ${joinList(parts)}.`;
  };

  return roots.map(describe).join(' ');
}

function timingRowsOf(nodes: readonly NarrativeCallNode[]): NarrativeTimingRow[] {
  return flattenNodes(nodes)
    .filter((node) => node.durationMs != null)
    .map((node) => ({
      number: node.number,
      label: `${node.service ? serviceLabel(node.service) : (node.host ?? 'unknown')} · /${node.path}`,
      durationMs: node.durationMs as number,
      downstreamMs: node.downstreamMs,
      selfMs: node.selfMs,
    }))
    .sort((a, b) => a.number - b.number);
}

function caveatsOf(calls: readonly CallRecord[]): string[] {
  const caveats: string[] = [];

  const failures = calls.filter(failed);
  if (failures.length > 0) {
    const described = failures
      .slice(0, 5)
      .map((call) => {
        const reason = call.error ?? (statusOf(call) != null ? `HTTP ${statusOf(call)}` : 'no response received');
        return `${call.method} ${labelOf(call)}/${uriPath(call.url)} — ${reason}`;
      })
      .join('; ');
    const more = failures.length > 5 ? `, and ${failures.length - 5} more` : '';
    caveats.push(
      `${failures.length} of ${calls.length} ${plural(calls.length, 'call')} did not succeed: ${described}${more}.`
    );
  }

  const pending = calls.filter(isInProgress);
  if (pending.length > 0) {
    caveats.push(
      `${pending.length} ${plural(pending.length, 'call was', 'calls were')} still in progress when this export was taken. ` +
        `Their responses are absent by design, not missing.`
    );
  }

  const depthInfo = indexCallTree(calls);
  const ambiguous = calls.filter((call) => depthInfo.get(call.id)?.ambiguous);
  if (ambiguous.length > 0) {
    caveats.push(
      `${ambiguous.length} ${plural(ambiguous.length, 'call sits', 'calls sit')} inside two or more overlapping calls ` +
        `that could equally have caused ${plural(ambiguous.length, 'it', 'them')}. Alfred shows ${plural(
          ambiguous.length,
          'it',
          'them'
        )} at top level rather than guessing whose work ${plural(ambiguous.length, 'it was', 'they were')}.`
    );
  }

  return caveats;
}

const COMMENTS_EXPLAINER =
  'A reviewer can highlight any single line of a request or response — headers or body — and attach a note to it. ' +
  'Those are Alfred’s comments: human annotations added after the fact, never anything a service sent. ' +
  'They appear twice over — collected under a 🚩 Flagged Issues heading per call, and inline on the exact line they belong to.';

function commentsNoteOf(commentsByCallId: ReadonlyMap<string, readonly Comment[]>): string {
  const total = [...commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0);
  if (total === 0) {
    return `${COMMENTS_EXPLAINER} This export contains no flagged lines.`;
  }
  const callCount = [...commentsByCallId.values()].filter((list) => list.length > 0).length;
  return `${COMMENTS_EXPLAINER} This export contains ${total} flagged ${plural(total, 'line')} across ${callCount} ${plural(
    callCount,
    'call'
  )}.`;
}

const ALWAYS_COMPLETE =
  'Every request and response below is the complete payload as it crossed the wire — Alfred exports never truncate, sample or summarize.';

const BOTH_SIDES =
  'Alfred logs traffic on both sides of your services: inbound calls arriving at a service it fronts, and outbound calls those services make to third parties.';

function countsOf(calls: readonly CallRecord[], commentsByCallId: ReadonlyMap<string, readonly Comment[]>): NarrativeCounts {
  const inbound = calls.filter((call) => directionOf(call) === 'inbound');
  const outbound = calls.filter((call) => directionOf(call) === 'outbound');
  const pending = calls.filter(isInProgress);
  const failures = calls.filter(failed);
  const depthInfo = indexCallTree(calls);

  return {
    calls: calls.length,
    inbound: inbound.length,
    outbound: outbound.length,
    succeeded: calls.length - failures.length - pending.length,
    failed: failures.length,
    inProgress: pending.length,
    ambiguous: calls.filter((call) => depthInfo.get(call.id)?.ambiguous).length,
    services: [...new Set(inbound.map((call) => serviceLabel(call.service_name)))].sort(),
    externalHosts: [...new Set(outbound.map(supplierOf))].sort(),
    flaggedLines: [...commentsByCallId.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

function singleCallDescription(call: CallRecord, notIncluded: NarrativeNotIncluded | null): string {
  const direction = directionOf(call);
  const where =
    direction === 'inbound'
      ? `an inbound call arriving at your service ${serviceLabel(call.service_name)}`
      : `an outbound call to the external host ${supplierOf(call)}`;

  const outcome = isInProgress(call)
    ? 'It was still in progress when this export was taken, so it has no response yet'
    : call.error
      ? `It failed: ${call.error}`
      : statusOf(call) != null
        ? `It returned ${statusOf(call)}${call.duration_ms != null ? ` after ${formatMs(call.duration_ms)}` : ''}`
        : 'No response was recorded for it';

  const sentences = [
    `An Alfred export of a single HTTP call: ${where}, on ${call.timestamp}.`,
    `${call.method} /${uriPath(call.url)}. ${outcome}.`,
    BOTH_SIDES,
    `This one is ${direction}.`,
    ALWAYS_COMPLETE,
  ];

  if (notIncluded?.parent || (notIncluded && notIncluded.descendantCount > 0)) {
    sentences.push(contextSentence(notIncluded));
  }
  return sentences.join(' ');
}

/** The one thing a single-call export cannot show: what surrounded it. See NarrativeNotIncluded. */
function contextSentence(notIncluded: NarrativeNotIncluded): string {
  const parts: string[] = [];
  if (notIncluded.parent) {
    const who = notIncluded.parent.service ? ` to ${serviceLabel(notIncluded.parent.service)}` : '';
    parts.push(
      `Alfred observed this call happening inside a ${formatMs(notIncluded.parent.durationMs)} inbound call${who}, which is not part of this export`
    );
  }
  if (notIncluded.descendantCount > 0) {
    const breakdown: string[] = [];
    if (notIncluded.descendantInbound > 0) breakdown.push(`${notIncluded.descendantInbound} inbound`);
    if (notIncluded.descendantOutbound > 0) breakdown.push(`${notIncluded.descendantOutbound} outbound`);
    const accounted =
      notIncluded.descendantMs != null ? `, accounting for ${formatMs(notIncluded.descendantMs)} of its duration` : '';
    parts.push(
      `Alfred observed ${notIncluded.descendantCount} ${plural(notIncluded.descendantCount, 'call')} nested inside this one (${joinList(
        breakdown
      )})${accounted} — also not included here`
    );
  }
  return `${joinList(parts)}. Re-export from the tree view if you need the surrounding flow.`;
}

function multiCallDescription(
  calls: readonly CallRecord[],
  counts: NarrativeCounts,
  from: string | null,
  to: string | null,
  wallClockMs: number | null
): string {
  const composition =
    counts.inbound === 0
      ? `All ${counts.calls} are outbound calls to external third parties; no inbound entry point was captured, so this file shows one side of the traffic only — Alfred's inbound logging was either off or not fronting whatever made these calls.`
      : counts.outbound === 0
        ? `All ${counts.calls} are inbound calls arriving at ${counts.services.length} ${plural(
            counts.services.length,
            'service'
          )}: ${joinList(counts.services)}.`
        : `${counts.inbound} inbound across ${counts.services.length} ${plural(
            counts.services.length,
            'service'
          )} (${joinList(counts.services)}) and ${counts.outbound} outbound to ${counts.externalHosts.length} external ${plural(
            counts.externalHosts.length,
            'host'
          )} (${joinList(counts.externalHosts)}).`;

  const when =
    from && to && wallClockMs != null
      ? ` captured between ${from} and ${to} (${formatSpan(wallClockMs)} of wall clock)`
      : '';

  return [
    `An Alfred export of ${calls.length} HTTP calls${when}.`,
    composition,
    BOTH_SIDES,
    ALWAYS_COMPLETE,
  ].join(' ');
}

/**
 * Whether `candidate` could be the parent of `call` - the same containment + ownership pair
 * call-tree.ts's canOwn asks, restated against the overlap feed's shape. Only an inbound call can be
 * a parent: an external call is an outbound leaf, and nothing Alfred logs happens inside one.
 */
function candidateCouldOwn(candidate: CallOverlapCandidate, call: CallRecord): boolean {
  if (candidate.id === call.id) return false;
  if (candidate.source !== 'internal') return false;

  const outer = { start: new Date(candidate.timestamp).getTime(), end: new Date(candidate.timestamp).getTime() + candidate.durationMs };
  const inner = windowOf(call);
  if (!(inner.start >= outer.start && inner.end <= outer.end)) return false;

  if (call.source === 'internal') return candidate.serviceName !== (call.service_name ?? null);
  const callService = call.service_name ?? null;
  return callService == null || callService === candidate.serviceName;
}

/** Mirrors call-utils.ts's isStrictlyContained + passesOwnershipCheck, with `call` as the container. */
function candidateNestsInside(candidate: CallOverlapCandidate, call: CallRecord): boolean {
  if (candidate.id === call.id) return false;

  const outer = windowOf(call);
  const start = new Date(candidate.timestamp).getTime();
  if (!(start >= outer.start && start + candidate.durationMs <= outer.end)) return false;

  const callService = call.service_name ?? null;
  if (candidate.source === 'internal') return candidate.serviceName !== callService;
  return candidate.serviceName == null || candidate.serviceName === callService;
}

function notIncludedFor(call: CallRecord, candidates: readonly CallOverlapCandidate[]): NarrativeNotIncluded | null {
  if (candidates.length === 0) return null;

  const owners = candidates.filter((candidate) => candidateCouldOwn(candidate, call));
  // The innermost owner is the immediate parent, exactly as call-tree.ts's resolveParent picks it.
  const parent = owners.length > 0 ? owners.reduce((best, owner) => (owner.durationMs < best.durationMs ? owner : best)) : null;

  const nested = candidates.filter((candidate) => candidateNestsInside(candidate, call));

  if (!parent && nested.length === 0) return null;

  return {
    parent: parent ? { service: parent.serviceName, durationMs: parent.durationMs } : null,
    descendantCount: nested.length,
    descendantInbound: nested.filter((candidate) => candidate.source === 'internal').length,
    descendantOutbound: nested.filter((candidate) => candidate.source !== 'internal').length,
    descendantMs:
      nested.length > 0
        ? unionMs(
            nested.map((candidate) => {
              const start = new Date(candidate.timestamp).getTime();
              return { start, end: start + candidate.durationMs };
            })
          )
        : null,
  };
}

const READING_GUIDE = {
  events:
    'One event per request/response, in true chronological order. An inbound call with downstream work emits a separate "request" and "response" event sharing the same callId; group by callId to reconstruct the call. An outbound call always emits a single "call" event.',
  nesting:
    'Derived from time containment plus service attribution, not from trace headers: a call is shown inside another when its whole window falls within it and a different service made it. A call that two overlapping calls could equally claim is left at top level and flagged as ambiguous rather than guessed into a subtree.',
  comments:
    'Human annotations pinned to a specific line of a specific block (request-headers | request-body | response-headers | response-body). lineIndex is 0-based against the pretty-printed text of that block.',
} as const;

/** Nothing to narrate - an export with no calls in it, which the dialog shouldn't produce but which no builder should crash on either. */
function emptyNarrative(): ExportNarrative {
  return {
    documentType: 'alfred-call-export',
    scope: 'multi',
    description: 'An Alfred export containing no calls.',
    capturedFrom: null,
    capturedTo: null,
    wallClockMs: null,
    depth: 0,
    shape: 'empty',
    counts: {
      calls: 0, inbound: 0, outbound: 0, succeeded: 0, failed: 0, inProgress: 0, ambiguous: 0,
      services: [], externalHosts: [], flaggedLines: 0,
    },
    topology: [],
    treeLines: [],
    flowSummary: null,
    notIncluded: null,
    timingRows: [],
    timingNote: null,
    caveats: [],
    orderingNote: null,
    commentsNote: commentsNoteOf(new Map()),
    readingGuide: READING_GUIDE,
  };
}

/**
 * Derives the whole About section from the calls themselves. Pure - takes no clock and no
 * injectables, so every branch of it is directly testable.
 */
export function buildExportNarrative(input: NarrativeInput): ExportNarrative {
  const { calls, commentsByCallId, splitCallIds, overlapCandidates = [] } = input;
  if (calls.length === 0) return emptyNarrative();

  const counts = countsOf(calls, commentsByCallId);
  const commentsNote = commentsNoteOf(commentsByCallId);

  // Same forced-chronological numbering the bulk builders use for their summary tables, so the
  // topology's "3." and the table's "3" are always the same call.
  const sorted = [...calls].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const numberByCallId = new Map(sorted.map((call, index) => [call.id, index + 1]));

  // A call whose timestamp doesn't parse contributes no range rather than poisoning it with NaN -
  // this is real logged data, and one malformed timestamp must not cost the reader the whole section.
  const starts = sorted.map((call) => windowOf(call).start).filter(Number.isFinite);
  const ends = sorted.map((call) => windowOf(call).end).filter(Number.isFinite);
  const dated = starts.length > 0 && ends.length > 0;
  const from = dated ? new Date(Math.min(...starts)).toISOString() : null;
  const to = dated ? new Date(Math.max(...ends)).toISOString() : null;
  const wallClockMs = dated ? Math.max(...ends) - Math.min(...starts) : null;

  if (calls.length === 1) {
    const call = calls[0];
    const notIncluded = notIncludedFor(call, overlapCandidates);
    const node = buildNode({ call, children: [], depth: 0 }, numberByCallId);
    return {
      documentType: 'alfred-call-export',
      scope: 'single',
      description: singleCallDescription(call, notIncluded),
      capturedFrom: from,
      capturedTo: to,
      wallClockMs,
      depth: 1,
      shape: directionOf(call),
      counts,
      topology: [node],
      treeLines: [],
      flowSummary: null,
      notIncluded,
      timingRows: [],
      timingNote: call.duration_ms != null ? `This call took ${formatMs(call.duration_ms)} end to end.` : null,
      caveats: caveatsOf(calls),
      orderingNote: null,
      commentsNote,
      readingGuide: READING_GUIDE,
    };
  }

  const topology = buildCallTree(sorted).map((node) => buildNode(node, numberByCallId));
  const allNodes = flattenNodes(topology);
  const depth = Math.max(...allNodes.map((node) => node.depth)) + 1;
  const nests = allNodes.some((node) => node.children.length > 0);

  const timingRows = nests ? timingRowsOf(topology) : [];
  const totalDurationMs = calls.reduce((sum, call) => sum + (call.duration_ms ?? 0), 0);
  const measured = [...sorted].filter((call) => call.duration_ms != null);
  const slowest = measured.length > 0 ? measured.reduce((a, b) => ((b.duration_ms ?? 0) > (a.duration_ms ?? 0) ? b : a)) : null;
  const fastest = measured.length > 0 ? measured.reduce((a, b) => ((b.duration_ms ?? 0) < (a.duration_ms ?? 0) ? b : a)) : null;

  const timingNote = nests
    ? 'Nesting and these figures come from time containment: a call is shown inside another when its whole window falls within it and a different service made it. "Waiting on downstream" counts overlapping children once, so a call that fanned out in parallel is not charged twice for it.'
    : slowest && fastest
      ? `${formatMs(totalDurationMs)} in total across ${calls.length} calls; slowest ${slowest.method} /${uriPath(
          slowest.url
        )} at ${formatMs(slowest.duration_ms as number)}, fastest ${fastest.method} /${uriPath(fastest.url)} at ${formatMs(
          fastest.duration_ms as number
        )}.`
      : null;

  const splitCount = splitCallIds ? calls.filter((call) => splitCallIds.has(call.id)).length : 0;
  const orderingNote =
    splitCount > 0
      ? `Calls appear in true chronological order of events, not grouped per call. ${splitCount} ${plural(
          splitCount,
          'call in this export has',
          'calls in this export have'
        )} downstream work, so ${plural(splitCount, 'it is', 'each is')} split into a request block and a response block with ` +
        `everything ${plural(splitCount, 'it', 'they')} caused sitting between them — which is why ${plural(
          splitCount,
          'that call appears',
          'those calls appear'
        )} twice in the summary table, once as "· request" and once as "· response". An outbound call is never split.`
      : null;

  return {
    documentType: 'alfred-call-export',
    scope: 'multi',
    description: multiCallDescription(calls, counts, from, to, wallClockMs),
    capturedFrom: from,
    capturedTo: to,
    wallClockMs,
    depth,
    shape: shapeOf(topology, depth),
    counts,
    topology,
    treeLines: nests ? renderTreeLines(topology) : [],
    flowSummary: nests
      ? flowSummaryOf(topology)
      : `Depth 1 — flat. No call fell inside another, so they are listed in time order with no hierarchy.`,
    notIncluded: null,
    timingRows,
    timingNote,
    caveats: caveatsOf(calls),
    orderingNote,
    commentsNote,
    readingGuide: READING_GUIDE,
  };
}

/** The depth line that opens "Who called whom" - null when there's no hierarchy to describe. */
export function depthSentence(narrative: ExportNarrative): string | null {
  if (narrative.scope === 'single' || narrative.depth <= 1) return null;
  const shape = narrative.shape === 'mixed' ? 'mixed — different branches take different shapes' : narrative.shape.replace(/->/g, '→');
  return `This capture is ${narrative.depth} levels deep: ${shape}.`;
}

export function formatNarrativeMs(ms: number): string {
  return formatMs(ms);
}
