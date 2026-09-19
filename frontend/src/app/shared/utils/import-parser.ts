import { CallEndpointSource, CallRecord } from '../../core/models/call.model';

/**
 * Reads an Alfred .json export back into CallRecords - the inverse of bulk-json-builder.ts.
 *
 * This exists as its own module, rather than as a private helper inside the import dialog, for one
 * reason: it has to stay the exact inverse of `buildBulkExportPayload`, and the only way to prove
 * that is a test that exports real calls and imports them back (see import-parser.spec.ts). The
 * previous version lived in the dialog and was tested against hand-written fixtures of a
 * `{ calls: [...] }` shape that NO Alfred export has ever produced - so every test passed while the
 * feature could not read a single real export file. Fixtures for this module must come from
 * buildBulkExportPayload, never from hand.
 */

/** Two calls' worth of halves, keyed by callId - see mergeEvents. */
interface Partial_ {
  readonly id: string;
  source?: CallEndpointSource;
  service_name?: string | null;
  method?: string;
  original_url?: string;
  url?: string;
  timestamp?: string;
  duration_ms?: number;
  request?: CallRecord['request'];
  response?: CallRecord['response'];
  error?: string;
  session_id?: string | null;
  operation_id?: string | null;
  state?: CallRecord['state'];
  supplierName?: string | null;
}

export interface ImportParseResult {
  readonly calls: readonly CallRecord[];
  /**
   * How many calls had no `source` in the file and had their direction INFERRED from service_name
   * (see inferSource). Non-zero only for files exported before `source` was written into the
   * events - the dialog surfaces it as a warning rather than importing silently, because the
   * inference is a guess that is wrong for outbound calls carrying an attribution service name.
   */
  readonly inferredDirectionCount: number;
  /** Events that named no call at all (no callId/id) - reported so a partially unreadable file
   * doesn't look like a clean import. */
  readonly skippedCount: number;
  /**
   * How many values the exporter deliberately masked before writing this file, read from the
   * payload's own `redactedValueCount`. Surfaced rather than ignored because re-importing a
   * redacted export is lossy in a way nothing else about the file reveals: the calls land looking
   * complete, with ***REDACTED*** sitting where a token used to be.
   */
  readonly redactedValueCount: number;
}

const EMPTY: ImportParseResult = { calls: [], inferredDirectionCount: 0, skippedCount: 0, redactedValueCount: 0 };

/**
 * Accepts every shape Alfred has ever written or documented:
 *
 * - `{ events: [...] }` - what "Export as JSON" actually produces. A resolved internal call is TWO
 *   events sharing a `callId` (see eventsForCall), so these are grouped by call and merged back
 *   into one record. This is the case that was entirely unimplemented: the response half carries no
 *   url/method, so anything requiring those per-object drops it and the call re-imports with no
 *   status, no duration and no response body.
 * - `{ calls: [...] }` and a bare array of call-shaped objects - kept working. No export produces
 *   these, but they're trivially hand-writable and were the only shape the old importer accepted.
 */
export function parseImportedCalls(parsed: unknown): ImportParseResult {
  if (!parsed || typeof parsed !== 'object') return EMPTY;

  // Read here rather than in mergeEvents: it is a property of the FILE, not of any event, and
  // mergeEvents only ever sees the array.
  const declared = (parsed as { redactedValueCount?: unknown }).redactedValueCount;
  const redactedValueCount = typeof declared === 'number' && declared > 0 ? declared : 0;

  const events = (parsed as { events?: unknown }).events;
  if (Array.isArray(events)) return { ...mergeEvents(events), redactedValueCount };

  const rawCalls = Array.isArray(parsed) ? parsed : (parsed as { calls?: unknown }).calls;
  if (Array.isArray(rawCalls)) return { ...mergeEvents(rawCalls), redactedValueCount };

  return EMPTY;
}

/**
 * Folds a flat event list into one record per call.
 *
 * Grouped by call id and merged field-by-field rather than "last event wins", because the two
 * halves of a split call are deliberately disjoint - the request half holds url/method/request, the
 * response half holds status/duration/response - and either can come first in file order (events
 * are sorted by their own timestamps, so another call's events interleave between them). Merging
 * only ever fills a field that isn't set yet, so a bare array of whole calls that happens to repeat
 * an id can't have its first entry silently overwritten either.
 */
function mergeEvents(events: readonly unknown[]): ImportParseResult {
  const byId = new Map<string, Partial_>();
  let skipped = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      skipped++;
      continue;
    }
    const raw = event as Record<string, unknown>;
    // 'callId' is what every export event uses; 'id' is the bare-array/hand-written shape.
    const id = str(raw['callId']) ?? str(raw['id']);
    if (!id) {
      skipped++;
      continue;
    }

    const existing = byId.get(id) ?? { id };
    fill(existing, raw);
    byId.set(id, existing);
  }

  let inferred = 0;
  const calls: CallRecord[] = [];
  for (const partial of byId.values()) {
    // A call with no url was never described by any event in the file (e.g. an orphaned response
    // half whose request was filtered out of the export) - there is nothing to re-issue or display.
    if (!partial.url) {
      skipped++;
      continue;
    }
    let source = partial.source;
    if (source === undefined) {
      source = inferSource(partial.service_name);
      inferred++;
    }
    calls.push({
      id: partial.id,
      original_url: partial.original_url ?? partial.url,
      url: partial.url,
      method: partial.method ?? 'GET',
      request: partial.request,
      timestamp: partial.timestamp ?? '',
      duration_ms: partial.duration_ms as number,
      response: partial.response,
      error: partial.error,
      supplierName: partial.supplierName,
      // Absent in older files: a call that reached a response or an error is finished by definition.
      state: partial.state ?? (partial.response !== undefined || partial.error !== undefined ? 'COMPLETED' : undefined),
      source,
      service_name: partial.service_name,
      session_id: partial.session_id,
      operation_id: partial.operation_id,
    });
  }

  return { calls, inferredDirectionCount: inferred, skippedCount: skipped, redactedValueCount: 0 };
}

/** Copies every field this event carries onto the accumulating record, never overwriting one that's
 * already been set by an earlier event for the same call. */
function fill(into: Partial_, raw: Record<string, unknown>): void {
  const set = <K extends keyof Partial_>(key: K, value: Partial_[K] | undefined): void => {
    if (value !== undefined && into[key] === undefined) into[key] = value;
  };

  const source = str(raw['source']);
  if (source === 'internal' || source === 'external') set('source', source);
  // A response event carries none of these, which is exactly why merging is needed at all.
  set('service_name', nullableStr(raw['service_name']));
  set('method', str(raw['method']));
  set('original_url', str(raw['original_url']));
  set('url', str(raw['url']));
  set('timestamp', str(raw['timestamp']));
  set('duration_ms', num(raw['duration_ms']));
  set('error', str(raw['error']));
  set('session_id', nullableStr(raw['session_id']));
  set('operation_id', nullableStr(raw['operation_id']));
  set('supplierName', nullableStr(raw['supplierName']));
  const state = str(raw['state']);
  if (state) set('state', state as CallRecord['state']);
  if (raw['request'] !== undefined && raw['request'] !== null) set('request', raw['request'] as CallRecord['request']);
  if (raw['response'] !== undefined && raw['response'] !== null) set('response', raw['response'] as CallRecord['response']);

  // A split call's request event carries the request timestamp and its response event carries the
  // RESPONSE timestamp (see responseTimestamp) - so the earliest of the two is the call's own start,
  // whichever order they were read in. Without this a response-first merge would date the call at
  // its own end.
  const timestamp = str(raw['timestamp']);
  if (timestamp && into.timestamp && new Date(timestamp).getTime() < new Date(into.timestamp).getTime()) {
    into.timestamp = timestamp;
  }
}

/**
 * Last-resort direction guess for a file exported before `source` was written into the events.
 *
 * A NON-NULL service_name means inbound on the overwhelming majority of captures, and it is the only
 * signal such a file has. It is still a guess: an outbound call carries a service_name too once its
 * project opts into forward-proxy outbound attribution, and that case comes out wrong here - which
 * is why this is counted and surfaced to the user rather than applied quietly, and why current
 * exports state `source` outright instead of relying on this.
 */
function inferSource(serviceName: string | null | undefined): CallEndpointSource {
  return serviceName != null ? 'internal' : 'external';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableStr(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
