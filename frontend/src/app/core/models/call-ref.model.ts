import { CallEndpointSource, CallRecord } from './call.model';

/**
 * Which logged call, wherever it lives: the live log (cycleId null) or a session cycle's captured
 * copy. A captured call keeps the live call's id, so the id alone is ambiguous - the same call can
 * be in the live log, in two cycles, or only in a cycle once the live log has evicted it. The
 * backend resolves this same triple (`direction`, `callId`, `cycleId`) for stored answers and for
 * resend.
 */
export interface CallRef {
  readonly source: CallEndpointSource;
  readonly callId: string;
  readonly cycleId: string | null;
}

/** One pick: the reference, the summary the card showed, and where it was picked, for the bar to say. */
export interface PickedCall {
  readonly ref: CallRef;
  readonly call: CallRecord;
  readonly originLabel: string;
}

export function refOf(call: CallRecord, cycleId: string | null): CallRef {
  return { source: call.source ?? 'external', callId: call.id, cycleId };
}

/** The wire word the backend's call-resolving endpoints take. */
export function directionOf(ref: CallRef): 'outbound' | 'inbound' {
  return ref.source === 'internal' ? 'inbound' : 'outbound';
}

export function sameRef(a: CallRef, b: CallRef): boolean {
  return a.source === b.source && a.callId === b.callId && a.cycleId === b.cycleId;
}
