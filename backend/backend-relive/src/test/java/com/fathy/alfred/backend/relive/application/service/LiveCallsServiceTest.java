package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.GlobalRulesSelection;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveSettings;
import com.fathy.alfred.backend.relive.domain.model.Step;
import com.fathy.alfred.backend.relive.domain.model.StepSource;
import com.fathy.alfred.backend.relive.domain.model.UnexpectedCallsPolicy;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class LiveCallsServiceTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final LiveCallStorePort liveCallStore = mock(LiveCallStorePort.class);
    private final ManageReliveCyclesUseCase manageCycles = mock(ManageReliveCyclesUseCase.class);
    private final LiveCallsService service = new LiveCallsService(liveCallStore, manageCycles);

    private FrozenCall recording() {
        return new FrozenCall("GET", "https://api.supplier-a.com/v2/search", Map.of(), "{}", 200, Map.of(), "{}",
                "2026-09-27T10:00:00Z", 100L, null, null, "odeysys", "outbound");
    }

    private JsonNode ruleWithMockResponse() throws Exception {
        return objectMapper.readTree("""
                { "name": "Supplier A", "enabled": true, "priority": 0, "stopProcessing": true, "match": {},
                  "actions": [ { "type": "MOCK_RESPONSE", "enabled": true, "status": 200, "headers": {}, "body": "{\\"stale\\":true}" } ] }
                """);
    }

    private Step step(JsonNode rule) {
        return new Step("s-supA", "s-search", "Supplier A", true, false, "outbound", "odeysys",
                new CycleRule(rule, null), "BLOCK", recording(), new StepSource("call-1", null, "outbound"), null, null, List.of());
    }

    private ReliveCycle cycle(Step step) {
        return new ReliveCycle("c-1", "Book flow", null, List.of(step), List.of(), List.of(),
                new GlobalRulesSelection("NONE", List.of()),
                new ReliveSettings("LIVE", "HOLD", "CONTINUE", "AUTOMATIC", List.of()),
                List.of(), new UnexpectedCallsPolicy("BLOCK", List.of(), "BLOCK"), "t0", "t0", false, null);
    }

    @Test
    void replacesTheStepsRecordingAndMockResponseWithTheLiveCallsActualData() throws Exception {
        JsonNode liveRequest = objectMapper.readTree("{\"headers\":{\"X-Trace\":\"abc\"},\"body\":\"{\\\"q\\\":1}\"}");
        JsonNode liveResponse = objectMapper.readTree("{\"status\":500,\"headers\":{\"Content-Type\":\"application/json\"},\"body\":\"{\\\"error\\\":\\\"boom\\\"}\"}");
        LiveCall live = new LiveCall("l-1", "c-1", "r-1", "s-supA", "LIVE", "call-9", liveRequest, liveResponse, 500, 77L, "2026-09-27T11:00:00Z");

        Step original = step(ruleWithMockResponse());
        ReliveCycle cycle = cycle(original);
        when(liveCallStore.findById("l-1")).thenReturn(Optional.of(live));
        when(manageCycles.get("c-1")).thenReturn(Optional.of(cycle));
        when(manageCycles.update(eq("c-1"), any(), eq("t0"), eq("USE_LIVE_CALL"))).thenAnswer(inv -> inv.getArgument(1));

        ReliveCycle result = service.useAsRecording("c-1", "l-1", "s-supA");

        Step updated = result.steps().get(0);
        assertThat(updated.recording().method()).isEqualTo("GET"); // unchanged - a live call carries no method/url
        assertThat(updated.recording().url()).isEqualTo("https://api.supplier-a.com/v2/search");
        assertThat(updated.recording().requestHeaders()).containsEntry("X-Trace", "abc");
        assertThat(updated.recording().requestBody()).isEqualTo("{\"q\":1}");
        assertThat(updated.recording().status()).isEqualTo(500);
        assertThat(updated.recording().responseHeaders()).containsEntry("Content-Type", "application/json");
        assertThat(updated.recording().responseBody()).isEqualTo("{\"error\":\"boom\"}");
        assertThat(updated.recording().timestamp()).isEqualTo("2026-09-27T11:00:00Z");
        assertThat(updated.recording().durationMs()).isEqualTo(77L);

        JsonNode mockAction = updated.callRule().rule().get("actions").get(0);
        assertThat(mockAction.get("status").asInt()).isEqualTo(500);
        assertThat(mockAction.get("body").asText()).isEqualTo("{\"error\":\"boom\"}");

        verify(manageCycles).update(eq("c-1"), any(), eq("t0"), eq("USE_LIVE_CALL"));
    }

    @Test
    void unknownLiveCallThrows() {
        when(liveCallStore.findById("missing")).thenReturn(Optional.empty());

        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> service.useAsRecording("c-1", "missing", "s-1"));
    }

    @Test
    void unknownStepThrows() {
        LiveCall live = new LiveCall("l-1", "c-1", "r-1", "s-1", "LIVE", "call-1", null, null, 200, 1L, "t0");
        when(liveCallStore.findById("l-1")).thenReturn(Optional.of(live));
        when(manageCycles.get("c-1")).thenReturn(Optional.of(cycle(step(objectMapper.nullNode()))));

        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> service.useAsRecording("c-1", "l-1", "no-such-step"));
    }
}
