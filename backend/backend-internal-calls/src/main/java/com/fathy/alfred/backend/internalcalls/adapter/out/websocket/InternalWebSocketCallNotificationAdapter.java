package com.fathy.alfred.backend.internalcalls.adapter.out.websocket;

import com.fathy.alfred.backend.internalcalls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.internalcalls.domain.model.CallRecord;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class InternalWebSocketCallNotificationAdapter implements CallNotificationPort {

    private static final Logger log = LoggerFactory.getLogger(InternalWebSocketCallNotificationAdapter.class);

    private static final String CALLS_CLEARED_EVENT = "{\"type\":\"calls-cleared\"}";

    private final InternalCallEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public InternalWebSocketCallNotificationAdapter(InternalCallEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyCallPrepared(CallRecord call) {
        broadcastCallEvent(call, List.of());
    }

    @Override
    public void notifyCallCompleted(CallRecord call, List<String> capturedByCycleIds) {
        broadcastCallEvent(call, capturedByCycleIds);
    }

    private void broadcastCallEvent(CallRecord call, List<String> capturedByCycleIds) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(new CallEvent(CallSummary.of(call), capturedByCycleIds)));
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize internal call event for WebSocket broadcast: {}", e.getMessage());
        }
    }

    @Override
    public void notifyCallsCleared() {
        handler.broadcast(CALLS_CLEARED_EVENT);
    }
}
