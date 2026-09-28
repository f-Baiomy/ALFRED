package com.fathy.alfred.backend.relivebridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.calls.domain.model.CallLifecycleStatus;
import com.fathy.alfred.backend.calls.domain.model.RequestData;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;
import com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

class ReliveCallObserverAdapterTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void outboundPreparedForwardsTheCallsRelivedAttributionAndServiceName() {
        ObserveRunCallUseCase observeRunCall = mock(ObserveRunCallUseCase.class);
        ReliveCallObserverAdapter adapter = new ReliveCallObserverAdapter(observeRunCall, objectMapper);
        JsonNode relive = objectMapper.createObjectNode().put("runId", "r-1").put("stepKey", "s-1");
        com.fathy.alfred.backend.calls.domain.model.CallRecord call = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "call-1", "https://svc/x", "https://svc/x", "GET", new RequestData(null, null), "t0", null, null,
                null, CallLifecycleStatus.IN_PROGRESS, null, null, "odeysys", null, null, null, null, relive, null);

        adapter.onCallPrepared(call);

        ArgumentCaptor<ObserveRunCallUseCase.ObservedCall> captor = ArgumentCaptor.forClass(ObserveRunCallUseCase.ObservedCall.class);
        verify(observeRunCall).onOutboundCallPrepared(captor.capture());
        assertThat(captor.getValue().callId()).isEqualTo("call-1");
        assertThat(captor.getValue().serviceName()).isEqualTo("odeysys");
        assertThat(captor.getValue().relive().get("runId").asText()).isEqualTo("r-1");
    }

    @Test
    void outboundCompletedCarriesReachedUpstreamAndResponseStatus() {
        ObserveRunCallUseCase observeRunCall = mock(ObserveRunCallUseCase.class);
        ReliveCallObserverAdapter adapter = new ReliveCallObserverAdapter(observeRunCall, objectMapper);
        JsonNode relive = objectMapper.createObjectNode().put("runId", "r-1").put("stepKey", "s-1");
        com.fathy.alfred.backend.calls.domain.model.CallRecord call = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "call-1", "https://svc/x", "https://svc/x", "GET", new RequestData(null, null), "t0", 5.0,
                new ResponseData(200, null, "ok"), null, CallLifecycleStatus.COMPLETED, null, null, "odeysys",
                null, null, null, null, relive, true);

        adapter.onCallCompleted(call);

        ArgumentCaptor<ObserveRunCallUseCase.ObservedCall> captor = ArgumentCaptor.forClass(ObserveRunCallUseCase.ObservedCall.class);
        verify(observeRunCall).onOutboundCallCompleted(captor.capture());
        assertThat(captor.getValue().reachedUpstream()).isTrue();
        assertThat(captor.getValue().status()).isEqualTo(200);
        assertThat(captor.getValue().durationMs()).isEqualTo(5L);
    }

    @Test
    void legacySingleShotIsTreatedAsACompletion() {
        ObserveRunCallUseCase observeRunCall = mock(ObserveRunCallUseCase.class);
        ReliveCallObserverAdapter adapter = new ReliveCallObserverAdapter(observeRunCall, objectMapper);
        com.fathy.alfred.backend.calls.domain.model.CallRecord call = new com.fathy.alfred.backend.calls.domain.model.CallRecord(
                "call-2", "https://svc/x", "https://svc/x", "GET", null, "t0", 1.0, new ResponseData(200, null, null), null);

        adapter.onNewCall(call);

        verify(observeRunCall).onOutboundCallCompleted(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void inboundCompletedForwardsToTheInboundMethod() {
        ObserveRunCallUseCase observeRunCall = mock(ObserveRunCallUseCase.class);
        ReliveCallObserverAdapter adapter = new ReliveCallObserverAdapter(observeRunCall, objectMapper);
        JsonNode relive = objectMapper.createObjectNode().put("runId", "r-1").put("stepKey", "s-inbound");
        com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call = new com.fathy.alfred.backend.internalcalls.domain.model.CallRecord(
                "call-3", "https://wildfly-proxy/x", "https://wildfly/x", "GET", null, "t0", 2.0,
                new com.fathy.alfred.backend.internalcalls.domain.model.ResponseData(200, null, null), null,
                com.fathy.alfred.backend.internalcalls.domain.model.CallLifecycleStatus.COMPLETED,
                null, null, "odeysys", null, null, null, relive, true);

        adapter.onCallCompleted(call);

        ArgumentCaptor<ObserveRunCallUseCase.ObservedCall> captor = ArgumentCaptor.forClass(ObserveRunCallUseCase.ObservedCall.class);
        verify(observeRunCall).onInboundCallCompleted(captor.capture());
        assertThat(captor.getValue().callId()).isEqualTo("call-3");
        assertThat(captor.getValue().relive().get("stepKey").asText()).isEqualTo("s-inbound");
    }
}
