/**
 * Turns recorded ALFRED calls (an inbound root plus its correlated outbound children) into
 * Relive `Step`s (FR-001, FR-004, FR-006). The recorded call is only ever read here, never
 * written to - freezing makes a copy, so nothing this module does can modify the original.
 */
import { CallRecord } from '../../core/models/call.model';
import { buildCallTree } from './call-tree';
import { defaultCallRule } from './relive-call-rule';
import { FrozenCall, ReliveSettings, Step } from './relive-types';

function newKey(): string {
  return crypto.randomUUID();
}

function directionOf(call: CallRecord): 'outbound' | 'inbound' {
  return call.source === 'internal' ? 'inbound' : 'outbound';
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function freezeOne(call: CallRecord, cycleId: string | null): FrozenCall {
  return {
    method: call.method,
    url: call.url,
    requestHeaders: { ...(call.request?.headers ?? {}) },
    requestBody: call.request?.body ?? null,
    status: call.response?.status ?? 0,
    responseHeaders: { ...(call.response?.headers ?? {}) },
    responseBody: call.response?.body ?? null,
    timestamp: call.timestamp,
    durationMs: call.duration_ms,
    sessionId: call.session_id ?? null,
    operationId: call.operation_id ?? null,
    serviceName: call.service_name ?? null,
    source: directionOf(call),
  };
}

function labelOf(call: CallRecord): string {
  return `${call.method} ${pathOf(call.url)}`;
}

/**
 * `calls` is every root (inbound, or an unparented outbound call the user picked on its own) the
 * user chose to add; `details` supplies the full-body version of a call when the caller only had
 * a lighter summary (a call's own `request`/`response` already carry full bodies once detail is
 * loaded - see `buildCallTree`'s own doc on why nothing here re-fetches). Each inbound root brings
 * its correlated outbound children automatically (FR-004); the user may remove individual
 * children afterwards in the step tree.
 */
export function freezeCalls(calls: readonly CallRecord[], details: ReadonlyMap<string, CallRecord>, settings: ReliveSettings, cycleId: string | null = null): Step[] {
  const resolved = (call: CallRecord): CallRecord => details.get(call.id) ?? call;
  const tree = buildCallTree(calls.map(resolved));
  const steps: Step[] = [];

  for (const root of tree) {
    const rootCall = root.call;
    const rootKey = newKey();
    const rootRecording = freezeOne(rootCall, cycleId);
    const rootStep: Step = {
      key: rootKey,
      parentKey: null,
      label: labelOf(rootCall),
      enabled: true,
      optional: false,
      direction: directionOf(rootCall),
      serviceName: rootRecording.serviceName,
      callRule: defaultCallRule({ key: rootKey, parentKey: null, label: labelOf(rootCall), recording: rootRecording }, settings),
      unattributed: 'BLOCK',
      recording: rootRecording,
      source: { callId: rootCall.id, cycleId, direction: directionOf(rootCall) },
      extract: [],
      assertions: [],
      noise: [],
    };
    steps.push(rootStep);

    for (const child of root.children) {
      const childCall = resolved(child.call);
      const childKey = newKey();
      const childRecording = freezeOne(childCall, cycleId);
      steps.push({
        key: childKey,
        parentKey: rootKey,
        label: labelOf(childCall),
        enabled: true,
        optional: false,
        direction: directionOf(childCall),
        serviceName: childRecording.serviceName,
        callRule: defaultCallRule({ key: childKey, parentKey: rootKey, label: labelOf(childCall), recording: childRecording }, settings),
        unattributed: 'BLOCK',
        recording: childRecording,
        source: { callId: childCall.id, cycleId, direction: directionOf(childCall) },
        extract: [],
        assertions: [],
        noise: [],
      });
    }
  }

  return steps;
}
