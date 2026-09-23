package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.application.port.out.SessionValueLookupPort;
import com.fathy.alfred.backend.resend.domain.model.OutgoingCall;
import com.fathy.alfred.backend.resend.domain.model.ResendEdits;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.SendOutcome;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import com.fathy.alfred.backend.resend.domain.model.SessionValueUse;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

class ResendServiceTest {

    private static final String ORIG_ID = "orig-1";
    private static final Map<String, String> ORIGINAL_HEADERS = new LinkedHashMap<>() {{
        put("Content-Type", "application/json");
        put("X-Request-Id", ORIG_ID);
        put("Cookie", "session=old");
        put("Content-Length", "9");
        put("Host", "api.supplier.test");
    }};

    private final ObjectMapper mapper = new ObjectMapper();
    private OutgoingCall sentCall;
    private List<SessionValue> lookupResult;
    private String lookupDirection;
    private String lookupAuthority;
    private Set<String> lookupNames;
    private String lookupExcludeId;
    private ResendService service;

    private StoredCall storedCall() {
        return new StoredCall("outbound", ORIG_ID, "POST", "https://api.supplier.test/v1/fares?x=1",
                ORIGINAL_HEADERS, "{\"a\":1}", "odeysys");
    }

    @BeforeEach
    void setUp() {
        lookupResult = List.of();
        CallSourcePort source = (direction, callId, cycleId) ->
                ORIG_ID.equals(callId) ? Optional.of(storedCall()) : Optional.empty();
        CallSenderPort sender = call -> {
            sentCall = call;
            return new SendOutcome.Sent(201, 42);
        };
        SessionValueLookupPort lookup = (direction, authority, names, excludeCallId) -> {
            lookupDirection = direction;
            lookupAuthority = authority;
            lookupNames = names;
            lookupExcludeId = excludeCallId;
            return lookupResult;
        };
        service = new ResendService(source, lookup, sender);
    }

    private ResendCallUseCase.ResendOutcome.Done resend(ResendRequest request) {
        return (ResendCallUseCase.ResendOutcome.Done) service.resend(request);
    }

    @Test
    void anUneditedResendSendsTheCallAsItWas() {
        resend(new ResendRequest("outbound", ORIG_ID, null, null, false));

        assertThat(sentCall.method()).isEqualTo("POST");
        assertThat(sentCall.url()).isEqualTo("https://api.supplier.test/v1/fares?x=1");
        assertThat(sentCall.body()).isEqualTo("{\"a\":1}");
        assertThat(sentCall.headers()).doesNotContainKey("Content-Length");
        assertThat(sentCall.headers()).doesNotContainKey("Host");
        assertThat(sentCall.headers()).containsEntry("Cookie", "session=old");
    }

    @Test
    void theRequestIdIsReplacedAndReturned() {
        ResendCallUseCase.ResendOutcome.Done done = resend(new ResendRequest("outbound", ORIG_ID, null, null, false));

        String sentRequestId = sentCall.headers().get("X-Request-Id");
        assertThatCode(() -> UUID.fromString(sentRequestId)).doesNotThrowAnyException();
        assertThat(sentRequestId).isNotEqualTo(ORIG_ID);
        assertThat(done.result().newCallId()).isEqualTo(sentRequestId);
    }

    @Test
    void theLinkHeadersAreAdded() throws Exception {
        ResendEdits edits = new ResendEdits("PUT", null, null, null);
        resend(new ResendRequest("outbound", ORIG_ID, null, edits, false));

        assertThat(sentCall.headers().get("X-Alfred-Resend-Of")).isEqualTo(ORIG_ID);
        String editsJson = sentCall.headers().get("X-Alfred-Resend-Edits");
        assertThatCode(() -> mapper.readTree(editsJson)).doesNotThrowAnyException();
    }

    @Test
    void editsAreAppliedAndOnlyNamesAreRecorded() throws Exception {
        Map<String, String> headerEdits = new LinkedHashMap<>();
        headerEdits.put("X-Api-Key", "s3cret");
        headerEdits.put("Cookie", null);
        ResendEdits edits = new ResendEdits("PUT", null, headerEdits, "{\"a\":2}");

        resend(new ResendRequest("outbound", ORIG_ID, null, edits, false));

        assertThat(sentCall.method()).isEqualTo("PUT");
        assertThat(sentCall.headers()).containsEntry("X-Api-Key", "s3cret");
        assertThat(sentCall.headers()).doesNotContainKey("Cookie");
        assertThat(sentCall.body()).isEqualTo("{\"a\":2}");

        String editsJson = sentCall.headers().get("X-Alfred-Resend-Edits");
        JsonNode node = mapper.readTree(editsJson);
        assertThat(node.get("method").get("from").asText()).isEqualTo("POST");
        assertThat(node.get("method").get("to").asText()).isEqualTo("PUT");
        List<String> headerNames = new java.util.ArrayList<>();
        node.get("headers").forEach(n -> headerNames.add(n.asText()));
        assertThat(headerNames).containsExactly("cookie", "x-api-key");
        assertThat(node.get("body").asBoolean()).isTrue();
        assertThat(editsJson).doesNotContain("s3cret");
    }

    @Test
    void aHeaderEditMatchesTheOriginalCaseInsensitively() {
        Map<String, String> headerEdits = Map.of("content-type", "text/plain");
        ResendEdits edits = new ResendEdits(null, null, headerEdits, null);

        resend(new ResendRequest("outbound", ORIG_ID, null, edits, false));

        long contentTypeCount = sentCall.headers().keySet().stream()
                .filter(k -> k.equalsIgnoreCase("content-type")).count();
        assertThat(contentTypeCount).isEqualTo(1);
        String key = sentCall.headers().keySet().stream()
                .filter(k -> k.equalsIgnoreCase("content-type")).findFirst().orElseThrow();
        assertThat(sentCall.headers().get(key)).isEqualTo("text/plain");
    }

    @Test
    void currentSessionSubstitutesTheNewestValueAndReportsWhereItCameFrom() throws Exception {
        lookupResult = List.of(new SessionValue("cookie", "session=new", "c-9"));

        ResendCallUseCase.ResendOutcome.Done done = resend(
                new ResendRequest("outbound", ORIG_ID, null, null, true));

        assertThat(sentCall.headers()).containsEntry("Cookie", "session=new");
        assertThat(done.result().sessionValuesUsed()).containsExactly(new SessionValueUse("cookie", "c-9"));

        String editsJson = sentCall.headers().get("X-Alfred-Resend-Edits");
        JsonNode node = mapper.readTree(editsJson);
        JsonNode session = node.get("session");
        assertThat(session).hasSize(1);
        assertThat(session.get(0).get("name").asText()).isEqualTo("cookie");
        assertThat(session.get(0).get("fromCallId").asText()).isEqualTo("c-9");
        assertThat(editsJson).doesNotContain("session=new");
        assertThat(editsJson).doesNotContain("session=old");

        assertThat(lookupDirection).isEqualTo("outbound");
        assertThat(lookupAuthority).isEqualTo("api.supplier.test");
        assertThat(lookupNames).isEqualTo(Set.of("authorization", "cookie"));
        assertThat(lookupExcludeId).isEqualTo(ORIG_ID);
    }

    @Test
    void withNothingNewerTheOriginalsAreKept() {
        lookupResult = List.of();

        ResendCallUseCase.ResendOutcome.Done done = resend(
                new ResendRequest("outbound", ORIG_ID, null, null, true));

        assertThat(sentCall.headers()).containsEntry("Cookie", "session=old");
        assertThat(done.result().sessionValuesUsed()).isEmpty();
    }

    @Test
    void anUnknownCallIsNotFound() {
        ResendCallUseCase.ResendOutcome outcome = service.resend(
                new ResendRequest("outbound", "missing", null, null, false));

        assertThat(outcome).isInstanceOf(ResendCallUseCase.ResendOutcome.NotFound.class);
        assertThat(sentCall).isNull();
    }

    @Test
    void senderOutcomesMapThrough() {
        CallSourcePort source = (direction, callId, cycleId) -> Optional.of(storedCall());

        CallSenderPort reverseProxyDown = call -> new SendOutcome.ReverseProxyNotRunning();
        ResendService serviceA = new ResendService(source, (d, a, n, e) -> List.of(), reverseProxyDown);
        assertThat(serviceA.resend(new ResendRequest("outbound", ORIG_ID, null, null, false)))
                .isInstanceOf(ResendCallUseCase.ResendOutcome.ReverseProxyNotRunning.class);

        CallSenderPort failing = call -> new SendOutcome.Failed("x");
        ResendService serviceB = new ResendService(source, (d, a, n, e) -> List.of(), failing);
        ResendCallUseCase.ResendOutcome outcome = serviceB.resend(new ResendRequest("outbound", ORIG_ID, null, null, false));
        assertThat(outcome).isInstanceOf(ResendCallUseCase.ResendOutcome.SendFailed.class);
        assertThat(((ResendCallUseCase.ResendOutcome.SendFailed) outcome).message()).isEqualTo("x");
    }
}
