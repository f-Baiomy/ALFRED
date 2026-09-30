package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fathy.alfred.backend.relive.domain.fingerprint.RequestFingerprint;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.Step;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class StepFingerprintsTest {

    private final FrozenCall recorded = new FrozenCall(
            "POST", "https://api.supplier.com/search",
            Map.of("Content-Type", "application/json"),
            "{\"a\":1}", 200, Map.of(), "{}", "t", 1, null, null, "svc", "outbound");

    private Step outbound(String key, String parent, String label, boolean enabled, FrozenCall recording,
                          String fingerprint, String version) {
        return new Step(key, parent, label, enabled, false, "outbound", "svc",
                new CycleRule(JsonNodeFactory.instance.objectNode(), null), "BLOCK", recording, null,
                JsonNodeFactory.instance.arrayNode(), JsonNodeFactory.instance.arrayNode(), List.of(),
                fingerprint, version);
    }

    @Test
    void newOutboundIsHashedOnceAndLaterEditsReuseIt() {
        Step created = StepFingerprints.maintain(
                List.of(outbound("c-1", "s-1", "supplier", true, recorded, "client-supplied", "NOPE")),
                List.of()).get(0);
        String hash = RequestFingerprint.of(recorded);
        assertThat(created.fingerprint()).isEqualTo(hash);
        assertThat(created.fingerprintVersion()).isEqualTo(RequestFingerprint.VERSION);

        Step moved = outbound("c-1", "s-other", "renamed", false, recorded, null, null);
        Step reused = StepFingerprints.maintain(List.of(moved), List.of(created)).get(0);
        assertThat(reused.fingerprint()).isEqualTo(hash);
        assertThat(reused.parentKey()).isEqualTo("s-other");
        assertThat(reused.enabled()).isFalse();
    }

    @Test
    void changedRequestIsRehashedAndAClientHashIsNotTrusted() {
        Step created = StepFingerprints.maintain(
                List.of(outbound("c-1", "s-1", "supplier", true, recorded, null, null)), List.of()).get(0);
        FrozenCall edited = new FrozenCall(
                recorded.method(), recorded.url(), recorded.requestHeaders(), "{\"a\":2}",
                recorded.status(), recorded.responseHeaders(), recorded.responseBody(),
                recorded.timestamp(), recorded.durationMs(), recorded.sessionId(), recorded.operationId(),
                recorded.serviceName(), recorded.source());
        Step incoming = outbound("c-1", "s-1", "supplier", true, edited, "evil", RequestFingerprint.VERSION);
        Step stamped = StepFingerprints.maintain(List.of(incoming), List.of(created)).get(0);
        assertThat(stamped.fingerprint()).isEqualTo(RequestFingerprint.of(edited));
        assertThat(stamped.fingerprint()).isNotEqualTo(created.fingerprint());
        assertThat(stamped.fingerprint()).isNotEqualTo("evil");
    }

    @Test
    void inboundAndMissingRecordingStayUnhashed() {
        Step inbound = new Step("s-1", null, "login", true, false, "inbound", "svc",
                new CycleRule(JsonNodeFactory.instance.objectNode(), null), "BLOCK", recorded, null,
                JsonNodeFactory.instance.arrayNode(), JsonNodeFactory.instance.arrayNode(), List.of(),
                "should-clear", RequestFingerprint.VERSION);
        Step noBody = outbound("c-2", "s-1", "open", true, null, "should-clear", RequestFingerprint.VERSION);

        List<Step> stamped = StepFingerprints.maintain(List.of(inbound, noBody), List.of());
        assertThat(stamped.get(0).fingerprint()).isNull();
        assertThat(stamped.get(0).fingerprintVersion()).isNull();
        assertThat(stamped.get(1).fingerprint()).isNull();
        assertThat(stamped.get(1).fingerprintVersion()).isNull();
    }

    @Test
    void indexGroupsSemanticCandidatesByParentAndSkipsLegacyAndPathless() {
        Step inbound = new Step("s-in", null, "search", true, false, "inbound", "svc",
                new CycleRule(JsonNodeFactory.instance.objectNode(), null), "BLOCK", null, null,
                JsonNodeFactory.instance.arrayNode(), JsonNodeFactory.instance.arrayNode(), List.of(), null, null);
        Step stamped = outbound("c-1", "s-in", "supplier", true, recorded, "hash-a", RequestFingerprint.VERSION);
        Step legacy = outbound("c-legacy", "s-in", "old", true, recorded, null, null);
        FrozenCall noPath = new FrozenCall(
                "POST", "https://api.supplier.com", recorded.requestHeaders(), recorded.requestBody(),
                recorded.status(), recorded.responseHeaders(), recorded.responseBody(),
                recorded.timestamp(), recorded.durationMs(), recorded.sessionId(), recorded.operationId(),
                recorded.serviceName(), recorded.source());
        Step pathless = outbound("c-nopath", "s-in", "open", true, noPath, "hash-a", RequestFingerprint.VERSION);
        Step nestedInbound = new Step("s-core", "s-in", "core", true, false, "inbound", "core",
                new CycleRule(JsonNodeFactory.instance.objectNode(), null), "BLOCK", null, null,
                JsonNodeFactory.instance.arrayNode(), JsonNodeFactory.instance.arrayNode(), List.of(), null, null);
        Step nestedOff = outbound("c-nested", "s-core", "nested", false, recorded, "hash-a", RequestFingerprint.VERSION);
        Step nestedOn = outbound("c-on", "s-core", "on", true, recorded, "hash-b", RequestFingerprint.VERSION);

        Map<String, Map<String, List<String>>> index = StepFingerprints.indexes(
                List.of(inbound, stamped, legacy, pathless, nestedInbound, nestedOff, nestedOn));

        assertThat(index.get("s-in").get("hash-a")).containsExactly("c-1");
        assertThat(index.get("s-in").get("hash-b")).containsExactly("c-on");
        assertThat(index.get("s-core").get("hash-b")).containsExactly("c-on");
        assertThat(index.get("s-core")).doesNotContainKey("hash-a");
        assertThat(index).doesNotContainKey("c-1");
    }

    @Test
    void aGeneratedHeaderChangeReusesTheStoredHash() {
        Step created = StepFingerprints.maintain(
                List.of(outbound("c-1", "s-1", "supplier", true, recorded, null, null)), List.of()).get(0);
        java.util.Map<String, String> headers = new java.util.LinkedHashMap<>(recorded.requestHeaders());
        headers.put("Cookie", "session=new");
        headers.put("User-Agent", "live");
        headers.put("X-Request-Id", "trace-1");
        FrozenCall noisy = new FrozenCall(
                recorded.method(), recorded.url(), headers, recorded.requestBody(),
                recorded.status(), recorded.responseHeaders(), recorded.responseBody(),
                recorded.timestamp(), recorded.durationMs(), recorded.sessionId(), recorded.operationId(),
                recorded.serviceName(), recorded.source());
        Step reused = StepFingerprints.maintain(
                List.of(outbound("c-1", "s-1", "supplier", true, noisy, null, null)), List.of(created)).get(0);
        assertThat(reused.fingerprint()).isEqualTo(created.fingerprint());

        headers.put("Client-Id", "other");
        FrozenCall edited = new FrozenCall(
                recorded.method(), recorded.url(), headers, recorded.requestBody(),
                recorded.status(), recorded.responseHeaders(), recorded.responseBody(),
                recorded.timestamp(), recorded.durationMs(), recorded.sessionId(), recorded.operationId(),
                recorded.serviceName(), recorded.source());
        Step rehashed = StepFingerprints.maintain(
                List.of(outbound("c-1", "s-1", "supplier", true, edited, null, null)), List.of(created)).get(0);
        assertThat(rehashed.fingerprint()).isEqualTo(RequestFingerprint.of(edited));
        assertThat(rehashed.fingerprint()).isNotEqualTo(created.fingerprint());
    }
}
