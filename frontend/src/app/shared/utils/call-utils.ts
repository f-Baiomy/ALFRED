import { CallRecord, CapturedCall, SortMode } from '../../core/models/call.model';

/**
 * Stable identity for a call, independent of its position in the list.
 * Deliberately NOT index-based: the backend returns newest-first and new
 * calls prepend, which would otherwise shift every existing call's index
 * on every poll.
 */
export function callKey(call: CallRecord): string {
  const raw = `${call.timestamp || ''}|${call.method || ''}|${call.original_url || ''}`;
  return 'c_' + raw.replace(/[^a-zA-Z0-9]/g, '_');
}

export function statusRank(call: CallRecord): number {
  if (call.error) return 999;
  return call.response?.status ?? -1;
}

/** Parses call.timestamp for the two call-timestamp sort modes - an unparseable/missing timestamp sorts as if it were epoch 0 rather than throwing or silently reordering unpredictably. */
function callTime(call: CallRecord): number {
  const ms = new Date(call.timestamp).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

export function sortCalls(calls: readonly CallRecord[], mode: SortMode): CallRecord[] {
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
    default:
      return arr;
  }
}

export function matchesSearch(call: CallRecord, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const parts = [
    call.method,
    call.original_url,
    call.url,
    call.response ? String(call.response.status) : '',
    call.error || '',
  ];
  if (call.request) {
    parts.push(JSON.stringify(call.request.headers || {}));
    parts.push(call.request.body || '');
  }
  if (call.response) {
    parts.push(JSON.stringify(call.response.headers || {}));
    parts.push(call.response.body || '');
  }
  return parts.join(' ').toLowerCase().includes(q);
}

/** Calls pushed live over WebSocket that the next poll hasn't confirmed yet, ahead of the polled list - deduped by callKey so a call never renders twice while both copies exist. */
export function mergeLiveCalls(live: readonly CallRecord[], polled: readonly CallRecord[]): CallRecord[] {
  return [...unconfirmedLiveCalls(live, polled), ...polled];
}

/** The subset of `live` not yet present in `polled` - once a poll confirms a live-pushed call, it drops out of the live buffer instead of accumulating forever. */
export function unconfirmedLiveCalls(live: readonly CallRecord[], polled: readonly CallRecord[]): CallRecord[] {
  const known = new Set(polled.map(callKey));
  return live.filter((c) => !known.has(callKey(c)));
}

/**
 * CapturedCall counterpart of mergeLiveCalls. Keyed by callKey(c.call), not CapturedCall.id - a
 * live-pushed captured call doesn't have its real backend-assigned id yet (the broadcast only
 * carries the raw CallRecord), so identity has to come from the call's own content, exactly like
 * the dashboard's live/polled merge already does.
 */
export function mergeLiveCapturedCalls(live: readonly CapturedCall[], polled: readonly CapturedCall[]): CapturedCall[] {
  return [...unconfirmedLiveCapturedCalls(live, polled), ...polled];
}

/** The subset of `live` not yet present in `polled`, keyed by callKey(c.call). */
export function unconfirmedLiveCapturedCalls(live: readonly CapturedCall[], polled: readonly CapturedCall[]): CapturedCall[] {
  const known = new Set(polled.map((c) => callKey(c.call)));
  return live.filter((c) => !known.has(callKey(c.call)));
}

export function supplierOf(call: CallRecord): string {
  try {
    return new URL(call.url).hostname;
  } catch {
    return call.url || call.original_url || 'unknown';
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
