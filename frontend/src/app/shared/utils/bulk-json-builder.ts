import { CallRecord, CallResponse, HttpMessageData } from '../../core/models/call.model';
import { ExportFormData } from '../../core/models/export-metadata.model';
import { Comment } from '../../core/models/comment.model';
import { isInProgress } from './call-utils';

/** A request-side event, emitted for every internal call that gets split (see buildBulkExportPayload). */
export interface BulkExportRequestEvent {
  readonly type: 'request';
  readonly callId: string;
  readonly service_name: string | null | undefined;
  readonly method: string;
  readonly original_url: string;
  readonly url: string;
  readonly timestamp: string;
  readonly request?: HttpMessageData;
  readonly session_id?: string | null;
  readonly operation_id?: string | null;
  readonly comments: readonly Comment[];
}

/** The response-side counterpart to a BulkExportRequestEvent, correlated purely by sharing the same callId. */
export interface BulkExportResponseEvent {
  readonly type: 'response';
  readonly callId: string;
  readonly status: number | undefined;
  readonly error?: string;
  readonly duration_ms: number;
  readonly timestamp: string;
  readonly response?: CallResponse;
}

/** An unsplit call - every external call, or an internal call that isn't resolved yet and shouldn't emit a synthetic response. */
export interface BulkExportCallEvent {
  readonly type: 'call';
  readonly callId: string;
  readonly service_name: string | null | undefined;
  readonly method: string;
  readonly original_url: string;
  readonly url: string;
  readonly timestamp: string;
  readonly duration_ms?: number;
  readonly status?: number;
  readonly error?: string;
  readonly request?: HttpMessageData;
  readonly response?: CallResponse;
  readonly session_id?: string | null;
  readonly operation_id?: string | null;
  readonly comments: readonly Comment[];
}

export type BulkExportEvent = BulkExportRequestEvent | BulkExportResponseEvent | BulkExportCallEvent;

export interface BulkExportPayload {
  readonly metadata: ExportFormData;
  readonly exportedAt: string;
  readonly summary: {
    readonly callCount: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly totalDurationMs: number;
  };
  readonly events: readonly BulkExportEvent[];
}

/** Response event's timestamp is derived, not stored - the moment the response was actually received, not restated at the request's own timestamp. */
function responseTimestamp(call: CallRecord): string {
  return new Date(new Date(call.timestamp).getTime() + (call.duration_ms ?? 0)).toISOString();
}

/**
 * Expands one call into its exported event(s). An internal, resolved call (has a response or an
 * error - i.e. not still in-progress) becomes a request event followed by a response event,
 * correlated purely by sharing `callId` (no new correlation-id concept). An internal call that's
 * still in-progress emits only its request event - fabricating a response here would misrepresent
 * a legitimate point-in-time export taken mid-flight. Every external call (never split, regardless
 * of its resolution state) emits a single 'call' event mirroring today's per-call shape exactly.
 *
 * Comments are attached to the request event only, not duplicated onto the response event too -
 * a call's comments aren't inherently request-side or response-side (see CommentBlock, which
 * already distinguishes request- and response- prefixed fields), so there's no need to carry two
 * copies of the same list through the file; a reader/reprocessor groupBy(callId)-ing the events
 * back into a call finds the comments on whichever event happens to be first in file order.
 */
function eventsForCall(call: CallRecord, comments: readonly Comment[]): BulkExportEvent[] {
  if (call.source !== 'internal') {
    return [
      {
        type: 'call',
        callId: call.id,
        service_name: call.service_name,
        method: call.method,
        original_url: call.original_url,
        url: call.url,
        timestamp: call.timestamp,
        duration_ms: call.duration_ms,
        status: call.response?.status,
        error: call.error,
        request: call.request,
        response: call.response,
        session_id: call.session_id,
        operation_id: call.operation_id,
        comments,
      },
    ];
  }

  const requestEvent: BulkExportRequestEvent = {
    type: 'request',
    callId: call.id,
    service_name: call.service_name,
    method: call.method,
    original_url: call.original_url,
    url: call.url,
    timestamp: call.timestamp,
    request: call.request,
    session_id: call.session_id,
    operation_id: call.operation_id,
    comments,
  };

  const resolved = (call.response !== undefined || call.error !== undefined) && !isInProgress(call);
  if (!resolved) return [requestEvent];

  const responseEvent: BulkExportResponseEvent = {
    type: 'response',
    callId: call.id,
    status: call.response?.status,
    error: call.error,
    duration_ms: call.duration_ms,
    timestamp: responseTimestamp(call),
    response: call.response,
  };
  return [requestEvent, responseEvent];
}

/**
 * The .json counterpart to buildBulkExportMarkdown - same metadata and per-call comments,
 * structured for a machine to reprocess rather than a person to read. Emits one event per
 * request/response EVENT (not one object per call): an internal, resolved call's request and
 * response come out as two separate events sharing `callId`, so a reprocessor can
 * `groupBy(event.callId)` to reconstruct a call - see eventsForCall(). exportedAt is passed in
 * rather than computed here with `new Date()`, so this stays a pure, easily-testable function.
 */
export function buildBulkExportPayload(
  calls: readonly CallRecord[],
  form: ExportFormData,
  commentsByCallId: ReadonlyMap<string, readonly Comment[]>,
  exportedAt: string
): BulkExportPayload {
  const succeeded = calls.filter((c) => !c.error && c.response && c.response.status < 400).length;

  // Sorted by each event's own timestamp (not call order, and not "all of call A's events before
  // call B's") so a resolved call's response event correctly interleaves after whatever other
  // calls' requests/responses happened in between it and its own request - the same real-time
  // ordering buildBulkExportMarkdown/buildBulkExportHtml force for the same reason.
  const events = calls
    .flatMap((call) => eventsForCall(call, commentsByCallId.get(call.id) ?? []))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    metadata: form,
    exportedAt,
    summary: {
      // Stays a count of actual calls, not events - splitting a call into two events must not double it here.
      callCount: calls.length,
      succeeded,
      failed: calls.length - succeeded,
      totalDurationMs: calls.reduce((sum, c) => sum + (c.duration_ms ?? 0), 0),
    },
    events,
  };
}
