/**
 * What the readable call exports (.md and .html, single and bulk) open with, computed ONCE here and
 * drawn by markdown-builder.ts and html-builder.ts - like export-narrative.ts, this is prose whose
 * whole point is saying the same thing in both formats (design: specs/export-redesign-mock.html).
 *
 * - an answer first: which calls failed and why, in one sentence, before any data;
 * - the counts behind it (succeeded / failed / inbound / outbound / flagged);
 * - how each call is named in a card head (number, method + path, direction);
 * - a glossary of the words only ALFRED uses, for a reader who was not there or an AI agent.
 *
 * It adds to the export; it never replaces a detail the export already carried.
 */
import { CallRecord } from '../../core/models/call.model';
import { Comment } from '../../core/models/comment.model';
import { isInProgress, supplierOf, uriPath } from './call-utils';
import { NarrativeCallNode } from './export-narrative';

export type CallExportTone = 'good' | 'bad' | 'neutral';

export interface CallExportVerdict {
  readonly tone: CallExportTone;
  readonly lead: string;
  readonly text: string;
}

export interface CallExportOverview {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly inProgress: number;
  readonly inbound: number;
  readonly outbound: number;
  readonly flagged: number;
  /** Chronological call numbers (the summary table's "#") with flagged lines, and how many each. */
  readonly flaggedCalls: readonly { readonly number: number; readonly count: number }[];
  readonly verdict: CallExportVerdict;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly meaning: string;
}

export const CALL_EXPORT_GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'Inbound · outbound', meaning: 'Inbound: a request INTO your application, logged by ALFRED\'s reverse proxy. Outbound: a call your application made to another system (a supplier), logged by ALFRED\'s forward proxy.' },
  { term: 'Request and response halves', meaning: 'An inbound call that caused other calls is shown as two halves - when it was sent and when it answered - with the calls it made in between, so the list reads in real time order.' },
  { term: 'Spacer (🏷️)', meaning: 'A label a person placed between calls in a session cycle, to name a part of the flow.' },
  { term: 'Flagged line (🚩)', meaning: 'A line of a header or body a person marked with a comment. Listed under Flagged Issues and shown next to the line itself.' },
  { term: 'Changed by Alfred (🛠️)', meaning: 'An interception rule changed this call on its way through ALFRED; the call as it was before and as it actually went out are both included.' },
  { term: 'Session cycle', meaning: 'A named recording of the calls made while a person went through one flow of the application.' },
];

/** What a glossary needs to explain for one export - only terms the reader will actually meet. */
export interface GlossaryUse {
  readonly split?: boolean;
  readonly spacers?: boolean;
  readonly flagged?: boolean;
  readonly changed?: boolean;
  readonly cycle?: boolean;
}

export function glossaryFor(use: GlossaryUse): GlossaryEntry[] {
  const wanted: Readonly<Record<string, boolean>> = {
    'Inbound · outbound': true,
    'Request and response halves': !!use.split,
    'Spacer (🏷️)': !!use.spacers,
    'Flagged line (🚩)': !!use.flagged,
    'Changed by Alfred (🛠️)': !!use.changed,
    'Session cycle': !!use.cycle,
  };
  return CALL_EXPORT_GLOSSARY.filter((g) => wanted[g.term]);
}

/** Same rule as the exports' own Succeeded/Failed counts: answered, without error, status below 400. */
export function callSucceeded(call: CallRecord): boolean {
  return !call.error && !!call.response && call.response.status < 400;
}

export function callDirection(call: CallRecord): 'inbound' | 'outbound' {
  return call.source === 'internal' ? 'inbound' : 'outbound';
}

/** "inbound · odeysys" / "outbound · supplier-b.example". */
export function directionText(call: CallRecord): string {
  return callDirection(call) === 'inbound' ? `inbound · ${call.service_name || 'internal'}` : `outbound · ${supplierOf(call)}`;
}

/** "POST /price" - the short name of a call in a sentence. */
export function callLabel(call: CallRecord): string {
  return `${call.method} /${uriPath(call.url)}`;
}

/** What a call answered, in words: "answered 502", "failed: timeout", "got no answer". */
export function outcomeText(call: CallRecord): string {
  if (isInProgress(call)) return 'was still in progress';
  if (call.error) return `failed (${call.error})`;
  if (!call.response) return 'got no answer';
  return `answered ${call.response.status}`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function flatten(nodes: readonly NarrativeCallNode[], parent: NarrativeCallNode | null, out: Map<string, { node: NarrativeCallNode; parent: NarrativeCallNode | null }>): void {
  for (const node of nodes) {
    out.set(node.callId, { node, parent });
    flatten(node.children, node, out);
  }
}

/**
 * `calls` in time order (the export's numbering), `topology` the narrative's call tree - used only
 * to say a failure was caused by a call it made ("because its call 6 … answered 500").
 */
export function callExportOverview(
  calls: readonly CallRecord[],
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  topology: readonly NarrativeCallNode[] = []
): CallExportOverview {
  const numberOf = new Map(calls.map((c, i) => [c.id, i + 1]));
  const byId = new Map(calls.map((c) => [c.id, c]));
  const tree = new Map<string, { node: NarrativeCallNode; parent: NarrativeCallNode | null }>();
  flatten(topology, null, tree);

  const failedCalls = calls.filter((c) => !callSucceeded(c) && !isInProgress(c));
  const inProgress = calls.filter(isInProgress).length;
  const flaggedCalls = calls
    .map((c) => ({ number: numberOf.get(c.id)!, count: commentsByCallId.get(c.id)?.length ?? 0 }))
    .filter((f) => f.count > 0);
  const flagged = flaggedCalls.reduce((sum, f) => sum + f.count, 0);

  const name = (c: CallRecord) => `${numberOf.get(c.id)} · ${callLabel(c)}`;
  const failedIds = new Set(failedCalls.map((c) => c.id));
  // A failure is listed once, at the highest call that failed; a failing call it made is its cause.
  const roots = failedCalls.filter((c) => {
    const parentId = tree.get(c.id)?.parent?.callId;
    return !parentId || !failedIds.has(parentId);
  });
  const causeOf = (c: CallRecord): CallRecord | null => {
    const stack = [...(tree.get(c.id)?.node.children ?? [])];
    while (stack.length) {
      const next = stack.shift()!;
      const call = byId.get(next.callId);
      if (call && failedIds.has(call.id)) return call;
      stack.push(...next.children);
    }
    return null;
  };

  const flaggedSentence = flagged
    ? ` ${flagged} line${flagged === 1 ? '' : 's'} flagged in call${flaggedCalls.length === 1 ? '' : 's'} ${joinList(flaggedCalls.map((f) => String(f.number)))}.`
    : '';

  let verdict: CallExportVerdict;
  if (calls.length === 0) {
    verdict = { tone: 'neutral', lead: 'No calls:', text: 'this export contains no calls.' };
  } else if (failedCalls.length) {
    const shown = roots.slice(0, 3).map((c) => {
      const cause = causeOf(c);
      return `${name(c)} ${outcomeText(c)}${cause ? ` because its call ${name(cause)} ${outcomeText(cause)}` : ''}`;
    });
    const more = roots.length > 3 ? `, and ${roots.length - 3} more` : '';
    verdict = {
      tone: 'bad',
      lead: calls.length === 1 ? 'Failed:' : `${failedCalls.length} of ${calls.length} calls failed:`,
      text: `${calls.length === 1 ? `the call ${outcomeText(calls[0])}` : `${joinList(shown)}${more}`}.${flaggedSentence}`,
    };
  } else {
    verdict = {
      tone: inProgress ? 'neutral' : 'good',
      lead: calls.length === 1 ? (inProgress ? 'In progress:' : 'Succeeded:') : inProgress ? `${calls.length - inProgress} of ${calls.length} calls succeeded:` : `All ${calls.length} calls succeeded.`,
      text: `${calls.length === 1 ? `the call ${outcomeText(calls[0])}.` : inProgress ? `${inProgress} still in progress.` : ''}${flaggedSentence}`.trim(),
    };
  }

  return {
    total: calls.length,
    succeeded: calls.filter(callSucceeded).length,
    failed: failedCalls.length,
    inProgress,
    inbound: calls.filter((c) => callDirection(c) === 'inbound').length,
    outbound: calls.filter((c) => callDirection(c) === 'outbound').length,
    flagged,
    flaggedCalls,
    verdict,
  };
}
