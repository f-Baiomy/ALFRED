import { CallEndpointSource, CallRecord, CallSummaryDto, SortMode } from '../../core/models/call.model';

/**
 * One rendered row in the flat call list - either a whole call ('full', today's behavior) or one
 * half of an internal call split across two rows ('request'/'response'). See splitCallsForDisplay().
 */
export interface CallListRow {
  readonly call: CallRecord;
  readonly variant: 'request' | 'response' | 'full';
  readonly rowKey: string;
}

/**
 * Converts a wire-format summary into the frontend's CallRecord shape (nested `response.status`,
 * matching what a hydrated call looks like) - `request`/`response.headers`/`response.body` stay
 * undefined until GET /calls/{id}/detail fills them in. `source` is stamped client-side (not part
 * of the wire shape) so a call fetched into a merged 'both' list still remembers which endpoint
 * (`/calls` vs `/internal-calls`) it came from - see CallRecord.source's doc. Omitted (left
 * undefined) for session-cycles' CapturedCall wrapping, which never deals with 'internal' calls.
 */
export function toCallRecord(dto: CallSummaryDto, source?: CallEndpointSource): CallRecord {
  return {
    id: dto.id,
    original_url: dto.original_url,
    url: dto.url,
    method: dto.method,
    timestamp: dto.timestamp,
    duration_ms: dto.duration_ms,
    response: dto.status != null ? { status: dto.status } : undefined,
    error: dto.error,
    supplierName: dto.supplierName,
    state: dto.state,
    session_id: dto.session_id,
    operation_id: dto.operation_id,
    service_name: dto.service_name,
    source,
  };
}

/** Reserved key for a call that has no service_name - every external call, plus an internal one logged before this field existed (see CallRecord.service_name's doc). Must match backend's LoggingToggleService.UNKNOWN_NAME/proxy's UNKNOWN_NAME for the "unknown" case, but 'external' itself is a frontend-only concept - the backend has no such name. */
export const EXTERNAL_SOURCE_KEY = 'external';

/** Which Sources-bar entry a call belongs to - its own service_name if it has one (an internal call, including its "unknown" bucket), else the reserved 'external' key. See SourceKey's doc. */
export function sourceKeyOf(call: CallRecord): string {
  return call.service_name ?? EXTERNAL_SOURCE_KEY;
}

/** Display label for sourceKeyOf() - 'external' becomes "External", everything else (a real project name, or "unknown") is shown title-cased as-is. */
export function sourceLabelOf(call: CallRecord): string {
  const key = sourceKeyOf(call);
  if (key === EXTERNAL_SOURCE_KEY) return 'External';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Whether a call is still awaiting its upstream response (two-phase logging) - a call with this state has no response/error yet, not to be confused with one that legitimately failed or never carried a status. */
export function isInProgress(call: CallRecord): boolean {
  return call.state === 'IN_PROGRESS';
}

/**
 * Per-CallRecord memo caches, keyed by object identity.
 *
 * A CallRecord is immutable (every field is `readonly`) and each poll parses fresh objects from
 * JSON, so a value derived from one is valid for that object's whole lifetime - and a WeakMap lets
 * the browser reclaim the entry as soon as the poll that produced the call drops it, with no
 * eviction logic to get wrong. Both derivations below are pure functions of the record, so
 * memoizing them cannot change any result; it only stops the same work being redone.
 */
const callKeyCache = new WeakMap<CallRecord, string>();
const supplierCache = new WeakMap<CallRecord, string>();
const callTimeCache = new WeakMap<CallRecord, number>();

/**
 * Stable identity for a call, independent of its position in the list.
 * Deliberately NOT index-based: the backend returns newest-first and new
 * calls prepend, which would otherwise shift every existing call's index
 * on every poll.
 *
 * Memoized because this is one of the hottest functions in the app: it runs per call in every
 * `trackBy`, in the sort comparators, in the live/polled merge and prune, and in `isSelected()` -
 * which a template calls for every rendered card on every change-detection pass.
 */
export function callKey(call: CallRecord): string {
  const cached = callKeyCache.get(call);
  if (cached !== undefined) return cached;

  const raw = `${call.timestamp || ''}|${call.method || ''}|${call.original_url || ''}`;
  const key = 'c_' + raw.replace(/[^a-zA-Z0-9]/g, '_');
  callKeyCache.set(call, key);
  return key;
}

export function statusRank(call: CallRecord): number {
  if (call.error) return 999;
  return call.response?.status ?? -1;
}

/**
 * Parses call.timestamp for the two call-timestamp sort modes - an unparseable/missing timestamp
 * sorts as if it were epoch 0 rather than throwing or silently reordering unpredictably.
 *
 * Memoized because a comparator runs it O(n log n) times per sort, re-parsing the same handful of
 * timestamp strings over and over.
 */
function callTime(call: CallRecord): number {
  const cached = callTimeCache.get(call);
  if (cached !== undefined) return cached;

  const parsed = new Date(call.timestamp).getTime();
  const ms = Number.isNaN(parsed) ? 0 : parsed;
  callTimeCache.set(call, ms);
  return ms;
}

/**
 * @param customOrder Only meaningful for mode 'custom' - callKeys in the manually drag-and-drop
 * arranged order (see CALL_REORDER_STATE). A call not present in it (e.g. one that arrived after
 * the arrangement was last saved) sorts after every ranked call, in its otherwise-current relative
 * order - new arrivals show up at the end rather than disrupting what's already been arranged.
 */
export function sortCalls(calls: readonly CallRecord[], mode: SortMode, customOrder: readonly string[] = []): CallRecord[] {
  const arr = [...calls];
  switch (mode) {
    case 'oldest':
      // The backend returns newest-first (received/capture order, not necessarily call.timestamp order).
      return arr.reverse();
    case 'oldest-call':
      return arr.sort((a, b) => callTime(a) - callTime(b));
    case 'newest-call':
      return arr.sort((a, b) => callTime(b) - callTime(a));
    case 'slowest':
      return arr.sort((a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1));
    case 'fastest':
      return arr.sort((a, b) => (a.duration_ms ?? Infinity) - (b.duration_ms ?? Infinity));
    case 'status':
      return arr.sort((a, b) => statusRank(b) - statusRank(a));
    case 'custom': {
      if (customOrder.length === 0) return arr;
      const rank = new Map(customOrder.map((key, i) => [key, i]));
      return arr.sort((a, b) => (rank.get(callKey(a)) ?? Infinity) - (rank.get(callKey(b)) ?? Infinity));
    }
    default:
      return arr;
  }
}

/** Memoized for the same reason as callKey: `new URL()` is comparatively expensive and this runs per call in the supplier-options tally, the supplier filter, and the group-by-supplier bucketing - all of which re-run on every poll. */
export function supplierOf(call: CallRecord): string {
  const cached = supplierCache.get(call);
  if (cached !== undefined) return cached;

  let supplier: string;
  try {
    supplier = new URL(call.url).hostname;
  } catch {
    supplier = call.url || call.original_url || 'unknown';
  }
  supplierCache.set(call, supplier);
  return supplier;
}

/** The URI - everything after the host, e.g. "api/V2/bundles/GetOfferBundles" for "https://host/api/V2/bundles/GetOfferBundles". No leading slash, no query string. Falls back to the raw url when it can't be parsed. */
export function uriPath(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return url;
  }
}

export function durationClass(ms: number | undefined | null): '' | 'fast' | 'mid' | 'slow' {
  if (ms == null) return '';
  if (ms < 300) return 'fast';
  if (ms < 1200) return 'mid';
  return 'slow';
}

export function statusClass(status: number | null | undefined): string {
  if (status == null) return 'status-err';
  if (status >= 500) return 'status-5xx';
  if (status >= 400) return 'status-4xx';
  if (status >= 300) return 'status-3xx';
  return 'status-2xx';
}

const KNOWN_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function methodClass(method: string | undefined): string {
  const m = (method || '').toUpperCase();
  return KNOWN_METHODS.includes(m) ? `method-${m}` : 'method-DEFAULT';
}

/** Chronological sort modes are the only ones where "request row, then later, response row" reads as a coherent timeline - see splitCallsForDisplay(). */
const CHRONOLOGICAL_SORT_MODES: ReadonlySet<SortMode> = new Set(['newest', 'oldest', 'newest-call', 'oldest-call']);

/** When a resolved internal call's response row should sort - its request's timestamp plus however long it took, so the response row lands after everything that happened before it finished, not back at its request's own timestamp. */
function responseTimeMs(call: CallRecord): number {
  return new Date(call.timestamp).getTime() + (call.duration_ms ?? 0);
}

/**
 * Expands a call list into display rows for the flat list: an internal call (source === 'internal')
 * becomes a 'request' row plus (once resolved) a 'response' row, sharing the call's own id as the
 * correlation key - no new correlation-id concept. External calls, and internal calls when the sort
 * mode isn't chronological (or the list itself isn't in call-timeline order - grouped-by-supplier,
 * pinned, or manually reordered), stay a single 'full' row exactly as before: splitting a call
 * across two rows only has a coherent reading order when the list itself is time-ordered.
 */
export function splitCallsForDisplay(calls: readonly CallRecord[], sortMode: SortMode): CallListRow[] {
  if (!CHRONOLOGICAL_SORT_MODES.has(sortMode)) {
    return calls.map((call) => ({ call, variant: 'full' as const, rowKey: call.id }));
  }

  const rows: Array<{ row: CallListRow; sortTime: number }> = [];
  for (const call of calls) {
    if (call.source !== 'internal') {
      rows.push({ row: { call, variant: 'full', rowKey: call.id }, sortTime: new Date(call.timestamp).getTime() });
      continue;
    }
    rows.push({ row: { call, variant: 'request', rowKey: `${call.id}::request` }, sortTime: new Date(call.timestamp).getTime() });
    if (!isInProgress(call)) {
      rows.push({ row: { call, variant: 'response', rowKey: `${call.id}::response` }, sortTime: responseTimeMs(call) });
    }
  }

  const descending = sortMode === 'newest' || sortMode === 'newest-call';
  rows.sort((a, b) => (descending ? b.sortTime - a.sortTime : a.sortTime - b.sortTime));
  return rows.map((r) => r.row);
}
