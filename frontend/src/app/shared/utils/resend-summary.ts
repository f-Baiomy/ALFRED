import { CallEndpointSource, CallRecord } from '../../core/models/call.model';
import { CallRef } from '../../core/models/call-ref.model';

/**
 * A resent call's `resendEdits`, typed. Written by backend-resend's ResendService into the
 * X-Alfred-Resend-Edits header and copied verbatim by the proxy, so every field is optional: a
 * resend logged before a field existed simply lacks it. Names only, never a header value.
 */
export interface ResendSummary {
  readonly method?: { readonly from: string; readonly to: string };
  readonly url?: { readonly from: string; readonly to: string };
  /** Header names that were set, added or removed. */
  readonly headers?: readonly string[];
  readonly body?: boolean;
  readonly session?: readonly { readonly name: string; readonly fromCallId: string }[];
  /** Where the original was: its direction and, for a captured copy, its cycle. Absent on older resends. */
  readonly origin?: { readonly direction: 'outbound' | 'inbound'; readonly cycleId: string | null };
  /** Its place in a multi-call resend. */
  readonly batch?: { readonly id: string; readonly index: number; readonly total: number };
}

export function resendSummaryOf(call: CallRecord): ResendSummary | null {
  if (!call.resendOf) return null;
  const raw = call.resendEdits;
  return raw && typeof raw === 'object' ? (raw as ResendSummary) : {};
}

/**
 * Which call this one is a resend of. Uses the recorded origin when there is one; an older resend
 * only knows the id, so it is looked for in the live log in this call's own direction (a resend
 * always goes out the way the original did).
 */
export function originalRefOf(call: CallRecord): CallRef | null {
  if (!call.resendOf) return null;
  const origin = resendSummaryOf(call)?.origin;
  const source: CallEndpointSource = origin ? (origin.direction === 'inbound' ? 'internal' : 'external') : call.source ?? 'external';
  return { source, callId: call.resendOf, cycleId: origin?.cycleId ?? null };
}

/** "URL · 2 headers · body · 1 session value" - what the user changed, in the words the panel head uses. */
export function describeResendChanges(summary: ResendSummary): string[] {
  const out: string[] = [];
  if (summary.method) out.push('method');
  if (summary.url) out.push('URL');
  const headers = summary.headers?.length ?? 0;
  if (headers) out.push(`${headers} header${headers === 1 ? '' : 's'}`);
  if (summary.body) out.push('body');
  const session = summary.session?.length ?? 0;
  if (session) out.push(`${session} session value${session === 1 ? '' : 's'}`);
  return out;
}
