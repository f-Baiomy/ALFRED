package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase.ResendOutcome;
import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.application.port.out.OutgoingCall;
import com.fathy.alfred.backend.resend.application.port.out.SendOutcome;
import com.fathy.alfred.backend.resend.application.port.out.SessionValueLookupPort;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.resend.domain.model.ResendBatch;
import com.fathy.alfred.backend.resend.domain.model.ResendEdits;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendResult;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class ResendServiceTest {

    private static final StoredCall ORIGINAL = new StoredCall("outbound", "call-1", "GET",
            "https://api.supplier.com/v1/fares", Map.of("X-Request-Id", "old-id", "Accept", "application/json"),
            null, "api.supplier.com", null);

    private CallSourcePort calls(StoredCall call) {
        return (direction, callId, cycleId) -> Optional.ofNullable(call);
    }

    private static class CapturingSender implements CallSenderPort {
        OutgoingCall lastCall;
        SendOutcome outcome = new SendOutcome.Sent(200, "ok");

        @Override
        public SendOutcome send(OutgoingCall call) {
            lastCall = call;
            return outcome;
        }
    }

    private static class FixedSessionValues implements SessionValueLookupPort {
        List<SessionValue> values;

        FixedSessionValues(List<SessionValue> values) {
            this.values = values;
        }

        @Override
        public List<SessionValue> newest(String direction, String host, Set<String> names, String cycleId) {
            return values;
        }
    }

    @Test
    void editsAreAppliedAndResendEditsListsHeaderNamesButNeverValues() {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);
        ResendEdits edits = new ResendEdits(null, null, new LinkedHashMap<>(Map.of("Accept", "text/xml")), null);

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "call-1", null, edits, false));

        assertThat(outcome).isInstanceOf(ResendOutcome.Success.class);
        assertThat(sender.lastCall.headers()).containsEntry("Accept", "text/xml");
        String editsHeader = sender.lastCall.headers().get("X-Alfred-Resend-Edits");
        assertThat(editsHeader).contains("\"headers\"").contains("Accept").doesNotContain("text/xml");
    }

    @Test
    void theOriginalXRequestIdIsReplacedByAFreshUuidReturnedAsNewCallId() {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "call-1", null, null, false));

        ResendResult result = ((ResendOutcome.Success) outcome).result();
        assertThat(result.newCallId()).isNotEqualTo("old-id");
        assertThat(sender.lastCall.headers()).containsEntry("X-Request-Id", result.newCallId());
    }

    @Test
    void resendOfAndResendEditsHeadersAreAdded() {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        service.resend(new ResendRequest("outbound", "call-1", null, null, false));

        assertThat(sender.lastCall.headers()).containsEntry("X-Alfred-Resend-Of", "call-1");
    }

    @Test
    void useCurrentSessionSubstitutesTheNewestValueAndReportsNameAndSourceCall() {
        CapturingSender sender = new CapturingSender();
        SessionValueLookupPort lookup = new FixedSessionValues(List.of(
                new SessionValue("Cookie", "session=fresh", "call-42")));
        ResendService service = new ResendService(calls(ORIGINAL), lookup, sender);

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "call-1", null, null, true));

        ResendResult result = ((ResendOutcome.Success) outcome).result();
        assertThat(result.sessionValuesUsed()).containsExactly(
                new com.fathy.alfred.backend.resend.domain.model.SessionValueUse("Cookie", "call-42"));
        assertThat(sender.lastCall.headers()).containsEntry("Cookie", "session=fresh");
    }

    @Test
    void withNothingNewerTheOriginalsAreKeptAndTheResultSaysSo() {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "call-1", null, null, true));

        ResendResult result = ((ResendOutcome.Success) outcome).result();
        assertThat(result.sessionValuesUsed()).isEmpty();
        assertThat(sender.lastCall.headers()).containsEntry("Accept", "application/json");
    }

    @Test
    void anUnknownCallIsNotFound() {
        ResendService service = new ResendService(calls(null), new FixedSessionValues(List.of()), new CapturingSender());

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "missing", null, null, false));

        assertThat(outcome).isInstanceOf(ResendOutcome.NotFound.class);
    }

    @Test
    void aReverseProxyNotRunningOutcomeIsPassedThrough() {
        CapturingSender sender = new CapturingSender();
        sender.outcome = new SendOutcome.ReverseProxyNotRunning();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "call-1", null, null, false));

        assertThat(outcome).isInstanceOf(ResendOutcome.ReverseProxyNotRunning.class);
    }

    @Test
    void aSendFailureIsPassedThroughWithItsMessage() {
        CapturingSender sender = new CapturingSender();
        sender.outcome = new SendOutcome.Failed("connection reset");
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        ResendOutcome outcome = service.resend(new ResendRequest("outbound", "call-1", null, null, false));

        assertThat(outcome).isInstanceOf(ResendOutcome.SendFailed.class);
        assertThat(((ResendOutcome.SendFailed) outcome).message()).isEqualTo("connection reset");
    }

    @Test
    void aNullHeaderValueInEditsRemovesThatHeader() {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);
        Map<String, String> headerEdits = new LinkedHashMap<>();
        headerEdits.put("Accept", null);
        ResendEdits edits = new ResendEdits(null, null, headerEdits, null);

        service.resend(new ResendRequest("outbound", "call-1", null, edits, false));

        assertThat(sender.lastCall.headers()).doesNotContainKey("Accept");
    }

    private static JsonNode resendEdits(CapturingSender sender) throws Exception {
        String header = sender.lastCall.headers().get("X-Alfred-Resend-Edits");
        assertThat(header).isNotNull();
        return new ObjectMapper().readTree(header);
    }

    @Test
    void theEditsHeaderIsSentEvenWithNoEditsAndCarriesTheLiveOriginWithANullCycleId() throws Exception {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        service.resend(new ResendRequest("outbound", "call-1", null, null, false));

        JsonNode summary = resendEdits(sender);
        assertThat(summary.get("origin").get("direction").asText()).isEqualTo("outbound");
        assertThat(summary.get("origin").has("cycleId")).isTrue();
        assertThat(summary.get("origin").get("cycleId").isNull()).isTrue();
        assertThat(summary.has("batch")).isFalse();
        assertThat(summary.has("method")).isFalse();
        assertThat(summary.has("headers")).isFalse();
    }

    @Test
    void theOriginCarriesTheCycleIdAndDirectionOfACycleCapturedCall() throws Exception {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);

        service.resend(new ResendRequest("inbound", "call-1", "cycle-7", null, false));

        JsonNode origin = resendEdits(sender).get("origin");
        assertThat(origin.get("direction").asText()).isEqualTo("inbound");
        assertThat(origin.get("cycleId").asText()).isEqualTo("cycle-7");
    }

    @Test
    void aBatchIsPassedThroughIntoTheSummaryAlongsideTheEdits() throws Exception {
        CapturingSender sender = new CapturingSender();
        ResendService service = new ResendService(calls(ORIGINAL), new FixedSessionValues(List.of()), sender);
        ResendEdits edits = new ResendEdits("POST", null, null, null);

        service.resend(new ResendRequest("outbound", "call-1", null, edits, false, new ResendBatch("b-1", 2, 5)));

        JsonNode summary = resendEdits(sender);
        assertThat(summary.get("batch").get("id").asText()).isEqualTo("b-1");
        assertThat(summary.get("batch").get("index").asInt()).isEqualTo(2);
        assertThat(summary.get("batch").get("total").asInt()).isEqualTo(5);
        assertThat(summary.get("method").get("from").asText()).isEqualTo("GET");
        assertThat(summary.get("method").get("to").asText()).isEqualTo("POST");
        assertThat(summary.get("origin").get("direction").asText()).isEqualTo("outbound");
    }
}
