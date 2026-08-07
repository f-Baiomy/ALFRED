package com.alfred.pennyworth.calls.adapter.out.websocket;

import com.alfred.pennyworth.calls.application.port.out.CallNotificationPort;
import com.alfred.pennyworth.calls.domain.model.CallRecord;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

@Component
public class WebSocketCallNotificationAdapter implements CallNotificationPort {

    private static final Logger log = LoggerFactory.getLogger(WebSocketCallNotificationAdapter.class);

    private final CallEventsWebSocketHandler handler;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public WebSocketCallNotificationAdapter(CallEventsWebSocketHandler handler) {
        this.handler = handler;
    }

    @Override
    public void notifyNewCall(CallRecord call) {
        try {
            handler.broadcast(objectMapper.writeValueAsString(call));
        } catch (JsonProcessingException e) {
            log.error("Failed to serialize call for WebSocket broadcast: {}", e.getMessage());
        }
    }
}
