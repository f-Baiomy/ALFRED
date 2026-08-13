package com.fathy.alfred.backend.calls.adapter.out.websocket;

import com.fathy.alfred.backend.calls.application.port.out.CallNotificationPort;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
public class WebSocketCallNotificationAdapter implements CallNotificationPort {

    private static final Logger log = LoggerFactory.getLogger(WebSocketCallNotificationAdapter.class);

    private static final String CALLS_CLEARED_EVENT = "{\"type\":\"calls-cleared\"}";

    private final CallEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public WebSocketCallNotificationAdapter(CallEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyNewCall(CallRecord call, List<String> capturedByCycleIds) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(new CallEvent(CallSummary.of(call), capturedByCycleIds)));
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize call event for WebSocket broadcast: {}", e.getMessage());
        }
    }

    @Override
    public void notifyCallsCleared() {
        handler.broadcast(CALLS_CLEARED_EVENT);
    }
}
