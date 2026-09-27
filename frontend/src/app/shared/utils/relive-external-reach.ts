/**
 * The external-reach watcher's pure core (research D14/D15): everything in a cycle that can let a
 * call reach a real external system, and what changed between two snapshots of it (FR-015a).
 * Consumed by the (component-level) watcher that diffs this on every render and raises a notice
 * for anything newly added (mock.html `watchExternal()`/`notifyExternal()` - the UI half lives in
 * the cycle editor component, not here).
 */
import { reachesHost } from './relive-call-rule';
import { ReliveCycle, Step } from './relive-types';

export interface ExternalReachEntry {
  readonly label: string;
  readonly host: string;
  readonly reason: string;
}

function isInternalHost(host: string, internalHosts: readonly string[]): boolean {
  return internalHosts.some((suffix) => host === suffix || host.endsWith(suffix));
}

function hostOf(step: Step): string {
  try {
    return new URL(step.recording.url).host;
  } catch {
    return step.recording.url;
  }
}

/** Every enabled outbound child that can reach a real (non-internal) host right now, plus the
 *  cycle-wide unexpected-call and unattributed policies when they can send to the real system. */
export function externalReach(cycle: ReliveCycle): ReadonlyMap<string, ExternalReachEntry> {
  const result = new Map<string, ExternalReachEntry>();
  const internalHosts = cycle.settings.internalHosts ?? [];

  for (const step of cycle.steps) {
    if (!step.enabled || !step.parentKey) continue;
    const host = hostOf(step);
    if (isInternalHost(host, internalHosts)) continue;
    const { reaches, reason } = reachesHost(step.callRule);
    if (reaches && reason) {
      result.set(step.key, { label: step.label, host, reason });
    }
  }

  const unexpected = cycle.unexpectedCalls;
  if (unexpected.policy === 'SEND_REAL' || (unexpected.policy === 'RULES' && unexpected.fallback === 'SEND_REAL')) {
    result.set('__unexpected', {
      label: 'Unexpected outbound calls',
      host: 'any host',
      reason:
        unexpected.policy === 'SEND_REAL'
          ? 'the unexpected-call policy is "Send to the real system"'
          : 'unexpected calls no rule matches fall back to "Send to real"',
    });
  }

  for (const step of cycle.steps) {
    if (step.enabled && step.parentKey && step.unattributed === 'SEND_REAL') {
      result.set('__unattributed_' + step.key, {
        label: step.label,
        host: hostOf(step),
        reason: "calls ALFRED can't tell are yours are sent to the real system",
      });
    }
  }

  return result;
}

/** The keys present in `after` but not in `before` - what to raise a fresh notice for (FR-015a). */
export function newlyReaching(before: ReadonlyMap<string, ExternalReachEntry>, after: ReadonlyMap<string, ExternalReachEntry>): readonly string[] {
  return [...after.keys()].filter((key) => !before.has(key));
}
