package com.fathy.alfred.backend.relivebridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.calls.application.port.out.NewCallObserverPort;
import com.fathy.alfred.backend.internalcalls.application.port.out.NewInternalCallObserverPort;
import com.fathy.alfred.backend.relive.application.port.in.ObserveRunCallUseCase;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Bridges the proxy webhook pipeline's own call observers (backend-calls' outbound, two-phase
 * NewCallObserverPort; backend-internal-calls' inbound, completion-only NewInternalCallObserverPort)
 * to Relive's run engine (T050). Lives in backend-app because backend-relive must not depend on
 * either calls slice directly (ArchUnit) - each slice's own {@code CallRecord} is translated into
 * {@link ObserveRunCallUseCase}'s slice-agnostic {@code ObservedCall} here, the one place all three
 * meet. Never captures a call into anything itself (unlike a session-cycle observer), so every
 * method returns an empty id list.
 */
@Component
public class ReliveCallObserverAdapter implements NewCallObserverPort, NewInternalCallObserverPort {

    private final ObserveRunCallUseCase observeRunCall;
    private final ObjectMapper objectMapper;

    public ReliveCallObserverAdapter(ObserveRunCallUseCase observeRunCall, ObjectMapper objectMapper) {
        this.observeRunCall = observeRunCall;
        this.objectMapper = objectMapper;
    }

    /** Legacy single-shot path - the call arrives already fully resolved, so it's treated as a completion. */
    @Override
    public List<String> onNewCall(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        observeRunCall.onOutboundCallCompleted(toObservedCall(call));
        return List.of();
    }

    @Override
    public List<String> onCallPrepared(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        observeRunCall.onOutboundCallPrepared(toObservedCall(call));
        return List.of();
    }

    @Override
    public List<String> onCallCompleted(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        observeRunCall.onOutboundCallCompleted(toObservedCall(call));
        return List.of();
    }

    @Override
    public List<String> onCallCompleted(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call) {
        observeRunCall.onInboundCallCompleted(toObservedCall(call));
        return List.of();
    }

    private ObserveRunCallUseCase.ObservedCall toObservedCall(com.fathy.alfred.backend.calls.domain.model.CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        Long durationMs = call.durationMs() == null ? null : call.durationMs().longValue();
        return new ObserveRunCallUseCase.ObservedCall(call.id(), call.serviceName(), call.relive(),
                Boolean.TRUE.equals(call.reachedUpstream()), toJson(call.request()), toJson(call.response()),
                status, durationMs, call.timestamp());
    }

    private ObserveRunCallUseCase.ObservedCall toObservedCall(com.fathy.alfred.backend.internalcalls.domain.model.CallRecord call) {
        Integer status = call.response() != null ? call.response().status() : null;
        Long durationMs = call.durationMs() == null ? null : call.durationMs().longValue();
        return new ObserveRunCallUseCase.ObservedCall(call.id(), call.serviceName(), call.relive(),
                Boolean.TRUE.equals(call.reachedUpstream()), toJson(call.request()), toJson(call.response()),
                status, durationMs, call.timestamp());
    }

    private JsonNode toJson(Object value) {
        return value == null ? null : objectMapper.valueToTree(value);
    }
}
