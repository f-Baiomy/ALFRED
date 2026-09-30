package com.fathy.alfred.backend.relive.domain.model;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One call in a cycle - an inbound step, or an outbound child of one (data-model.md "Step").
 * {@code mode}, {@code ordinal}, {@code external}, {@code modified}, {@code checkpoint} and
 * {@code onRequestChanged} are derived from {@code callRule} and are deliberately not fields
 * here (FR-010a/029b) - the frontend's {@code relive-call-rule.ts} and the proxy both derive
 * them the same way, from the one call rule, rather than from separate stored flags that could
 * drift out of sync with it.
 *
 * <p>{@code fingerprint} is the persisted SEMANTIC_V1 hash of an outbound step's request. It is
 * written when the cycle is saved and reused by every later run. Null on an inbound step and on
 * a cycle saved before fingerprints existed.
 */
public record Step(
        String key,
        String parentKey,
        String label,
        boolean enabled,
        boolean optional,
        String direction,
        String serviceName,
        CycleRule callRule,
        String unattributed,
        FrozenCall recording,
        StepSource source,
        JsonNode extract,
        JsonNode assertions,
        java.util.List<NoiseRule> noise,
        String fingerprint,
        String fingerprintVersion
) {
    public Step withFingerprint(String fingerprint, String fingerprintVersion) {
        return new Step(key, parentKey, label, enabled, optional, direction, serviceName,
                callRule, unattributed, recording, source, extract, assertions, noise,
                fingerprint, fingerprintVersion);
    }
}
