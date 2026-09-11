import { CallEndpointSource, CallOverlapCandidate, CallRecord, CallSummaryDto, SortMode } from '../../core/models/call.model';

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

/**
 * Display label for a call's source badge. An external call (call.source !== 'internal') shows
 * "External" alone when unattributed (the common case - most external traffic, or data predating
 * outbound attribution), or "External · via <Project>" once the forward-proxy outbound-attribution
 * mechanism has named exactly which project made it (call.service_name non-null on an external
 * call - see call.model.ts's doc on service_name). Every other call (internal, including its
 * "unknown" bucket) is shown title-cased as-is, via sourceKeyOf().
 */
export function sourceLabelOf(call: CallRecord): string {
  if (call.source !== 'internal') {
    return call.service_name ? `External · via ${titleCase(call.service_name)}` : 'External';
  }
  const key = sourceKeyOf(call);
  return titleCase(key);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Whether a call is still awaiting its upstream response (two-phase logging) - a call with this state has no response/error yet, not to be confused with one that legitimately failed or never carried a status. */
export function isInProgress(call: CallRecord): boolean {
  return call.state === 'IN_PROGRESS';
}

/** Which stat-pill bucket (if any) is narrowing the visible list - see StatsBarComponent. 'all' means no narrowing. Lives here (not call-list-view.ts, which imports it back) so this file's containment-check helpers (candidateMatchesStatusFilter, hasQualifyingOverlap) can apply the same client-side-only filter to a CallOverlapCandidate without call-list-view.ts and call-utils.ts importing each other in a cycle. */
export type CallStatusFilter = 'all' | 'inProgress' | 'ok' | 'client' | 'failed';

export function matchesStatusFilter(call: CallRecord, filter: CallStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'inProgress':
      return isInProgress(call);
    case 'ok':
      return !!call.response && call.response.status < 400;
    case 'client':
      return !!call.response && call.response.status >= 400 && call.response.status < 500;
    case 'failed':
      return !!call.error || (!!call.response && call.response.status >= 500);
  }
}

/**
 * The status-pill equivalent of matchesStatusFilter, applied to a CallOverlapCandidate's own
 * flattened status/error fields instead of a CallRecord's nested response - a candidate is never
 * 'inProgress' (GET /call-overlaps only ever returns resolved calls, see CallOverlapCandidate's
 * doc), so that bucket always excludes every candidate.
 */
export function candidateMatchesStatusFilter(candidate: CallOverlapCandidate, filter: CallStatusFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'inProgress':
      return false;
    case 'ok':
      return candidate.status != null && candidate.status < 400;
    case 'client':
      return candidate.status != null && candidate.status >= 400 && candidate.status < 500;
    case 'failed':
      return candidate.error != null || (candidate.status != null && candidate.status >= 500);
  }
}

/**
 * Minimum share of the parent's own duration a candidate must occupy to count as blocking evidence
 * (check 3 of 4 - see qualifiesAsEvidence). A genuine blocking child - the call that actually held
 * the parent up - accounts for most of how long the parent took; a coincidental overlap (two
 * unrelated concurrent requests in the same browser burst) essentially never does.
 */
const MIN_COVERAGE_RATIO = 0.3;

/**
 * Flat floor, in ms, for how soon after a blocking child ends the parent must also finish (check 3
 * of 4). Whichever is larger of this flat floor or TAIL_RATIO * the parent's own duration applies -
 * a very short parent still needs a genuinely tight tail, and a very long parent isn't held to an
 * unrealistic fixed quarter-second once its own duration dwarfs it.
 */
const MIN_TAIL_MS = 250;

/** See MIN_TAIL_MS's doc - the proportional half of the same "parent wraps up shortly after its
 * blocking child" tail rule. */
const TAIL_RATIO = 0.1;

function targetWindow(target: CallRecord): { start: number; end: number } {
  const start = new Date(target.timestamp).getTime();
  return { start, end: start + (target.duration_ms ?? 0) };
}

function candidateWindow(candidate: CallOverlapCandidate): { start: number; end: number } {
  const start = new Date(candidate.timestamp).getTime();
  return { start, end: start + candidate.durationMs };
}

/** Check 1 of 4: candidate.start >= target.start AND candidate.end <= target.end, using each side's
 * own timestamp/timestamp+duration window. The candidate sharing the target's own id (the call
 * would otherwise trivially "contain" itself) is excluded unconditionally. */
function isStrictlyContained(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  if (candidate.id === target.id) return false;
  const t = targetWindow(target);
  const c = candidateWindow(candidate);
  return c.start >= t.start && c.end <= t.end;
}

/**
 * Check 2 of 4: ownership/attribution. An internal candidate only qualifies if it names a DIFFERENT
 * service than the target (unchanged from before this rewrite - two calls to the same project are
 * siblings, not parent/child, regardless of attribution). An external candidate with a non-null
 * serviceName (new - see call.model.ts's doc on service_name) is now a DEFINITE fact about which
 * project made it, via outbound attribution, so it only qualifies on an EXACT match with the
 * target's own service_name. An external candidate with serviceName null (older data, or that
 * project hasn't opted into outbound attribution) falls back to the old permissive behavior - it
 * still counts regardless of the target's service_name, since we have no certainty either way and
 * don't want to regress calls that used to split before attribution existed.
 */
function passesOwnershipCheck(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  const targetServiceName = target.service_name ?? null;
  if (candidate.source === 'internal') {
    return candidate.serviceName !== targetServiceName;
  }
  if (candidate.serviceName == null) return true;
  return candidate.serviceName === targetServiceName;
}

/**
 * Check 3 of 4: the blocking signature - a candidate that's merely contained by coincidence (two
 * unrelated concurrent calls) neither accounts for much of the parent's duration nor ends close to
 * when the parent itself finishes; a genuine blocking child does both. See MIN_COVERAGE_RATIO/
 * MIN_TAIL_MS/TAIL_RATIO's own docs for why each threshold is shaped the way it is.
 */
function passesBlockingSignature(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  const targetDurationMs = target.duration_ms ?? 0;
  if (targetDurationMs <= 0) return false;

  const t = targetWindow(target);
  const c = candidateWindow(candidate);
  const coverage = candidate.durationMs / targetDurationMs;
  const tail = t.end - c.end;

  return coverage >= MIN_COVERAGE_RATIO && tail <= Math.max(MIN_TAIL_MS, targetDurationMs * TAIL_RATIO);
}

/** Checks 1-3 combined - everything EXCEPT the ambiguity veto (check 4), which can only be applied
 * once every other internal call under consideration is known too. See computeSplitCallIds. */
function qualifiesAsEvidence(target: CallRecord, candidate: CallOverlapCandidate): boolean {
  return isStrictlyContained(target, candidate) && passesOwnershipCheck(target, candidate) && passesBlockingSignature(target, candidate);
}

/**
 * Two-pass computation of which of `internalCalls` (every internal, resolved call currently under
 * consideration - e.g. mainListCalls()'s internal subset for the live list, or the exported `calls`
 * subset for exports) stay split into request/response rows, per the full 4-check algorithm:
 *
 * Pass 1: for every internal call, gather its own set of candidates surviving checks 1-3
 * (qualifiesAsEvidence) among the candidates currently visible under the status-pill filter.
 *
 * Pass 2 (the ambiguity veto, check 4): for every candidate that survived checks 1-3 against MORE
 * THAN ONE different internal call, it's ambiguous which call it's actually blocking evidence for -
 * remove it from every one of those calls' surviving sets rather than guessing for either.
 *
 * A call stays split iff its remaining surviving set, after the veto, is non-empty.
 */
function computeSplitCallIds(
  internalCalls: readonly CallRecord[],
  candidates: readonly CallOverlapCandidate[],
  statusFilter: CallStatusFilter
): ReadonlySet<string> {
  const visibleCandidates = candidates.filter((candidate) => candidateMatchesStatusFilter(candidate, statusFilter));

  const survivorsByCallId = new Map<string, CallOverlapCandidate[]>();
  for (const call of internalCalls) {
    survivorsByCallId.set(
      call.id,
      visibleCandidates.filter((candidate) => qualifiesAsEvidence(call, candidate))
    );
  }

  const survivedCountByCandidate = new Map<CallOverlapCandidate, number>();
  for (const survivors of survivorsByCallId.values()) {
    for (const candidate of survivors) {
      survivedCountByCandidate.set(candidate, (survivedCountByCandidate.get(candidate) ?? 0) + 1);
    }
  }

  const staysSplit = new Set<string>();
  for (const [callId, survivors] of survivorsByCallId) {
    const afterVeto = survivors.filter((candidate) => (survivedCountByCandidate.get(candidate) ?? 0) <= 1);
    if (afterVeto.length > 0) staysSplit.add(callId);
  }
  return staysSplit;
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
 * Expands a call list into display rows for the flat list: an internal, resolved call becomes a
 * 'request' row plus a 'response' row, sharing the call's own id as the correlation key - no new
 * correlation-id concept - but ONLY when it actually STAYS split per the containment rule below;
 * otherwise (and for every external call, and internal calls when the sort mode isn't
 * chronological - or the list itself isn't in call-timeline order: grouped-by-supplier, pinned, or
 * manually reordered) it's a single 'full' row, rendered exactly like an external call.
 *
 * An internal, resolved call stays split only if some OTHER call - external, or internal to a
 * DIFFERENT service, never the same service - genuinely happened strictly inside its own
 * [timestamp, timestamp + duration_ms] window (see isContainedOverlap/hasQualifyingOverlap);
 * otherwise it merges back into one row. `overlapCandidates` is the batch of candidates fetched
 * for whatever time range/filters are currently active (see call-list-view.ts) - `undefined` means
 * that fetch hasn't resolved yet (or hasn't been triggered at all) for the current range, in which
 * case every eligible call renders PROVISIONALLY SPLIT, the safe default (point 6 of the
 * containment-rule spec): never provisionally merged, since merging a call that's actually still
 * "nested" would hide real request/response detail. `statusFilter` is the status-pill bucket
 * (StatsBarComponent) - the one active filter that's genuinely client-side rather than a backend
 * query param - applied to each candidate so a candidate that wouldn't itself be visible right now
 * doesn't count towards "something happened inside this window" either.
 */
export function splitCallsForDisplay(
  calls: readonly CallRecord[],
  sortMode: SortMode,
  overlapCandidates: readonly CallOverlapCandidate[] | undefined,
  statusFilter: CallStatusFilter
): CallListRow[] {
  if (!CHRONOLOGICAL_SORT_MODES.has(sortMode)) {
    return calls.map((call) => ({ call, variant: 'full' as const, rowKey: call.id }));
  }

  // Computed once per call, up front, over every internal/resolved call in this list - the
  // ambiguity veto (check 4) needs the full picture of who else a candidate might be evidence for
  // before any single call's split/merge decision can be made. undefined means the candidates fetch
  // for the current range hasn't resolved yet - staysSplitIds stays undefined too, and every
  // eligible call below renders provisionally split (the safe default), never provisionally merged.
  const resolvedInternalCalls = calls.filter((call) => call.source === 'internal' && !isInProgress(call));
  const staysSplitIds = overlapCandidates === undefined ? undefined : computeSplitCallIds(resolvedInternalCalls, overlapCandidates, statusFilter);

  const rows: Array<{ row: CallListRow; sortTime: number }> = [];
  for (const call of calls) {
    if (call.source !== 'internal') {
      rows.push({ row: { call, variant: 'full', rowKey: call.id }, sortTime: new Date(call.timestamp).getTime() });
      continue;
    }
    if (isInProgress(call)) {
      rows.push({ row: { call, variant: 'request', rowKey: `${call.id}::request` }, sortTime: new Date(call.timestamp).getTime() });
      continue;
    }

    const staysSplit = staysSplitIds === undefined || staysSplitIds.has(call.id);
    if (staysSplit) {
      rows.push({ row: { call, variant: 'request', rowKey: `${call.id}::request` }, sortTime: new Date(call.timestamp).getTime() });
      rows.push({ row: { call, variant: 'response', rowKey: `${call.id}::response` }, sortTime: responseTimeMs(call) });
    } else {
      rows.push({ row: { call, variant: 'full', rowKey: call.id }, sortTime: new Date(call.timestamp).getTime() });
    }
  }

  const descending = sortMode === 'newest' || sortMode === 'newest-call';
  rows.sort((a, b) => (descending ? b.sortTime - a.sortTime : a.sortTime - b.sortTime));
  return rows.map((r) => r.row);
}
