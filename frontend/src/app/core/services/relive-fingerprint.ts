import { Step } from '../../shared/utils/relive-types';

/** Outbound steps that still need a SEMANTIC_V1 request hash. Inbound steps and steps with no recording are skipped. */
export function outboundAwaitingFingerprint(steps: readonly Step[]): number {
  return steps.filter((step) =>
    step.direction === 'outbound' && step.recording != null && step.fingerprintVersion !== 'SEMANTIC_V1',
  ).length;
}

/** Outbound steps that were saved with no fingerprint at all. An older algorithm is a separate case. */
export function outboundMissingFingerprint(steps: readonly Step[]): number {
  return steps.filter((step) =>
    step.direction === 'outbound' && step.recording != null && step.fingerprintVersion == null,
  ).length;
}

/** Outbound steps saved under a fingerprint algorithm other than SEMANTIC_V1. A missing version is not this case. */
export function outboundOnOldFingerprint(steps: readonly Step[]): number {
  return steps.filter((step) =>
    step.direction === 'outbound'
    && step.recording != null
    && step.fingerprintVersion != null
    && step.fingerprintVersion !== 'SEMANTIC_V1',
  ).length;
}
